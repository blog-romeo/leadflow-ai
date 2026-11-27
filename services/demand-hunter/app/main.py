"""Demand Hunter service: authenticated HTTP API around the original BuyerML engine.

Kept from BuyerML, unchanged (folder buyerml/): hunt.py (the hunt), demand.py (the reading of a post),
learning.py (what the hunts learn), areas.py (the tree of market areas), seed/it_taxonomy.json and
seed/market_areas.json, the SerpApi search of dork_runner.py, the dedup of hunt.py and buyerml_store.py.

Added here, around it:
  - HMAC authentication of the gateway (security.py), the organization read only from the signed headers;
  - one SQLite database per organization (data/orgs/<uuid>.db): the hunts, the learning and the discovered
    concepts of an organization are never visible to another one;
  - persistent jobs (jobs.py) and idempotency keys: the same confirmation never starts two hunts;
  - hard caps on the budget and on the hunts running at the same time.
The confirmation of the budget (single-use token bound to the user) is issued and consumed by the gateway,
which is also the only one that knows the organization's monthly limits.
"""
from __future__ import annotations

import os
import re
import threading

from . import BUYERML_DIR  # noqa: F401  (puts the BuyerML modules on the path)
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import areas
import demand
import hunt as hunt_mod
import learning
from buyerml_store import Store

from . import externals as ext_mod
from . import security
from .jobs import TERMINAL, JobStore
from .settings import Settings, load

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
TEXT_MAX = 120


class HuntBody(BaseModel):
    seed: str = Field(min_length=1, max_length=TEXT_MAX)
    budget: int = Field(ge=1, le=500)
    goal: str = "clienti"


class HuntStart(HuntBody):
    idempotency_key: str


class AreaBody(BaseModel):
    label: str = Field(min_length=1, max_length=TEXT_MAX)
    idempotency_key: str = ""


class FeedbackBody(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    verdict: str | None = None


class ClassifyBody(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


def _goal(goal: str) -> str:
    if goal not in hunt_mod.GOALS:
        raise HTTPException(400, "unknown_goal")
    return goal


def _clean(s: str) -> str:
    return " ".join(s.split())


def reading_view(text: str) -> dict:
    """The classification with its textual evidence (demand.read: rules, free, deterministic)."""
    r = demand.read(text)
    return {"author_role": r.author_role, "demand": r.demand, "intent_types": r.intent_types, "stage": r.stage,
            "lead_score": r.lead_score, "confidence": r.confidence, "urgency": r.urgency,
            "budget_declared": r.budget_declared, "specificity": r.specificity, "lead_class": r.lead_class,
            "taxonomy_path": r.taxonomy_path, "technology": r.technology, "language": r.language,
            "evidence": [{"signal": e.get("signal"), "match": e.get("match")} for e in r.evidence][:12],
            "reader": r.reader}


def create_app(settings: Settings | None = None, externals_factory=None) -> FastAPI:
    settings = settings or load()
    app = FastAPI(title="Demand Hunter service", docs_url=None, redoc_url=None, openapi_url=None)
    nonces = security.NonceCache()
    jobs = JobStore(os.path.join(settings.data_dir, "service.db"))
    live_hunts: dict[str, hunt_mod.Hunt] = {}
    start_lock = threading.Lock()
    make_ext = externals_factory or (lambda: ext_mod.make(settings.simulated))

    def org_db(org: str) -> str:
        if not security.UUID_RE.match(org):          # already checked by verify(): defence in depth for the path
            raise HTTPException(400, "invalid_org")
        d = os.path.join(settings.data_dir, "orgs")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, f"{org.lower()}.db")

    def externals():
        try:
            return make_ext()
        except ext_mod.NotConfigured:
            raise HTTPException(503, "search_provider_not_configured")

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        if request.url.path == "/healthz":
            return await call_next(request)
        body = await request.body()
        path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        try:
            org, user = security.verify(settings.secret, request.headers, request.method, path, body, nonces,
                                        settings.signature_window_s)
        except security.AuthError as e:
            return JSONResponse({"error": e.code}, status_code=e.status)
        request.state.org, request.state.user = org, user
        return await call_next(request)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/v1/status")
    def status(request: Request):
        return {"mode": settings.mode, "simulated": settings.simulated,
                "search_provider_configured": settings.simulated or settings.serpapi_configured,
                "max_budget_per_hunt": settings.max_budget_per_hunt,
                "max_concurrent_per_org": settings.max_concurrent_per_org,
                "running": jobs.running(request.state.org), "goals": list(hunt_mod.GOALS)}

    # ---- Market areas (areas.py): the tree is free, an expansion is paid (autocomplete) -------------------

    @app.get("/v1/areas/{goal}")
    def areas_tree(goal: str, request: Request):
        store = Store(org_db(request.state.org))
        try:
            return {"tree": areas.tree(_goal(goal), store), "mode": settings.mode}
        finally:
            store.close()

    @app.post("/v1/areas/{goal}/plan")
    def areas_plan(goal: str, body: AreaBody):
        try:
            return areas.plan(_goal(goal), body.label)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/v1/areas/{goal}/expand")
    def areas_expand(goal: str, body: AreaBody, request: Request):
        if not KEY_RE.match(body.idempotency_key):
            raise HTTPException(400, "invalid_idempotency_key")
        org = request.state.org
        job, created = jobs.create(org, request.state.user, body.idempotency_key, "expand",
                                   {"goal": goal, "label": _clean(body.label)})
        if not created:
            return {**(job["snapshot"] or {}), "duplicate": True, "mode": settings.mode}
        ext = externals()
        store = Store(org_db(org))
        try:
            calls = {"n": 0}

            def autocomplete(phrase):
                calls["n"] += 1
                return ext.autocomplete(phrase)
            out = areas.expand(_goal(goal), body.label, autocomplete, store)
            out = {**out, "spent": {"autocomplete": calls["n"], "searches": 0}, "mode": ext.mode}
            jobs.update(job["id"], status="finita", snapshot=out)
            return out
        except ValueError as e:
            jobs.update(job["id"], status="errore", error=str(e))
            raise HTTPException(400, str(e))
        except Exception as e:  # noqa: BLE001 - provider failure: said, never retried silently
            jobs.update(job["id"], status="errore", error=type(e).__name__)
            raise HTTPException(502, "search_provider_error")
        finally:
            store.close()

    # ---- The hunt (hunt.py) ---------------------------------------------------------------------------

    @app.get("/v1/hunts/suggestions")
    def suggestions(request: Request):
        store = Store(org_db(request.state.org))
        try:
            return {"suggestions": hunt_mod.suggest_seeds(store)}
        finally:
            store.close()

    @app.post("/v1/hunts/plan")
    def hunt_plan(body: HuntBody, request: Request):
        if body.budget > settings.max_budget_per_hunt:
            raise HTTPException(400, "budget_above_service_cap")
        try:
            p = hunt_mod.plan(body.seed, body.budget, _goal(body.goal))
        except ValueError as e:
            raise HTTPException(400, str(e))
        # how many combinations were already executed for this organization (never paid again)
        store = Store(org_db(request.state.org))
        try:
            h = hunt_mod.Hunt(body.seed, body.budget, search=lambda q: [], autocomplete=lambda s: [], store=store, goal=body.goal)
            already = sum(c.status == "già fatta" for c in h.combos.values())
        finally:
            store.close()
        return {**p, "already_done": already, "mode": settings.mode,
                "max_paid_calls": body.budget}

    @app.post("/v1/hunts")
    def hunt_start(body: HuntStart, request: Request):
        org, user = request.state.org, request.state.user
        if not KEY_RE.match(body.idempotency_key):
            raise HTTPException(400, "invalid_idempotency_key")
        if body.budget > settings.max_budget_per_hunt:
            raise HTTPException(400, "budget_above_service_cap")
        goal, seed = _goal(body.goal), _clean(body.seed)
        try:      # the seed is checked before anything is recorded
            hunt_mod.Hunt(seed, body.budget, search=lambda q: [], autocomplete=lambda s: [], goal=goal)
        except ValueError as e:
            raise HTTPException(400, str(e))
        with start_lock:
            found = jobs.find(org, body.idempotency_key)
            if found:      # the same confirmation sent twice: the job it already started, no second spend
                return {"job_id": found["id"], "status": found["status"], "duplicate": True}
            if jobs.running(org) >= settings.max_concurrent_per_org:
                raise HTTPException(429, "too_many_running_hunts")
            ext = externals()
            job, _ = jobs.create(org, user, body.idempotency_key, "hunt", {"seed": seed, "budget": body.budget, "goal": goal})

        def work():
            store = Store(org_db(org))
            try:
                hh = hunt_mod.Hunt(seed, body.budget, ext.search, ext.autocomplete, store=store, goal=goal)
                live_hunts[job["id"]] = hh
                jobs.update(job["id"], status="in corso", snapshot=view(hh, store))

                def progress(_i, _n):
                    jobs.update(job["id"], snapshot=view(hh, store))
                hh.run(progress)
                jobs.update(job["id"], status=hh.status, snapshot=view(hh, store))
            except Exception as e:  # noqa: BLE001 - the hunt keeps what it found, the error is said
                cur = live_hunts.get(job["id"])
                jobs.update(job["id"], status="errore", error=type(e).__name__,
                            snapshot=view(cur, store) if cur else None)
            finally:
                store.close()

        threading.Thread(target=work, daemon=True, name=f"hunt-{job['id']}").start()
        return {"job_id": job["id"], "status": "in coda", "duplicate": False, "mode": ext.mode}

    def view(h: hunt_mod.Hunt, store: Store) -> dict:
        snap = h.snapshot()
        try:
            verdicts = learning.feedback(store, h.goal)
        except Exception:  # noqa: BLE001
            verdicts = {}
        for lead in snap["lead_list"]:
            lead["reading"] = reading_view(lead["text"])
            lead["verdict"] = verdicts.get(lead["url"])
        snap["mode"] = settings.mode
        return snap

    @app.get("/v1/hunts/{job_id}")
    def hunt_view(job_id: str, request: Request):
        job = jobs.get(request.state.org, job_id)
        if not job:
            raise HTTPException(404, "not_found")
        return {"job_id": job["id"], "status": job["status"], "error": job["error"], "params": job["params"],
                "terminal": job["status"] in TERMINAL, "hunt": job["snapshot"], "mode": settings.mode}

    @app.post("/v1/hunts/{job_id}/stop")
    def hunt_stop(job_id: str, request: Request):
        job = jobs.get(request.state.org, job_id)
        if not job:
            raise HTTPException(404, "not_found")
        h = live_hunts.get(job_id)
        if h:
            h.stop_requested = True
        return {"stopping": bool(h) and job["status"] not in TERMINAL}

    # ---- Learning (learning.py) -----------------------------------------------------------------------

    @app.post("/v1/learning/{goal}/feedback")
    def feedback(goal: str, body: FeedbackBody, request: Request):
        if body.verdict not in (None, *learning.VERDICTS):
            raise HTTPException(400, "invalid_verdict")
        store = Store(org_db(request.state.org))
        try:
            learning.set_feedback(store, body.url, _goal(goal), body.verdict)
        finally:
            store.close()
        return {"url": body.url, "verdict": body.verdict}

    @app.get("/v1/learning/{goal}")
    def learning_stats(goal: str, request: Request):
        store = Store(org_db(request.state.org))
        try:
            return {**learning.stats(store, _goal(goal)), "priors": learning.priors(store, goal)}
        finally:
            store.close()

    # ---- Intent analysis of one text (demand.py, free) ---------------------------------------------------

    @app.post("/v1/classify")
    def classify(body: ClassifyBody):
        return reading_view(body.text)

    return app


app = create_app() if os.environ.get("DH_CREATE_APP", "true") != "false" else None
