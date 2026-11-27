"""Tests of the Demand Hunter service. Simulated data only: no network, no SerpApi, nothing paid.

    cd services/demand-hunter && python -m unittest discover -s tests -t .
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
import uuid

os.environ.setdefault("DH_CREATE_APP", "false")
os.environ.setdefault("MOCK_MODE", "true")

from fastapi.testclient import TestClient  # noqa: E402

from app import security  # noqa: E402
from app.externals import Externals, simulated  # noqa: E402
from app.main import create_app, reading_view  # noqa: E402
from app.settings import Settings  # noqa: E402

SECRET = "s" * 48
ORG_A = str(uuid.uuid4())
ORG_B = str(uuid.uuid4())
USER = str(uuid.uuid4())


def settings(d: str, **kw) -> Settings:
    base = dict(secret=SECRET, data_dir=d, simulated=True, serpapi_configured=False, max_budget_per_hunt=40,
                max_concurrent_per_org=1, signature_window_s=300)
    base.update(kw)
    return Settings(**base)


class Signed:
    """A client that signs like the Netlify gateway (netlify/functions/_shared/demand-hunter/gateway.ts)."""

    def __init__(self, client: TestClient, org: str, user: str = USER, secret: str = SECRET):
        self.c, self.org, self.user, self.secret = client, org, user, secret

    def headers(self, method: str, path: str, body: bytes, ts: int | None = None, nonce: str | None = None) -> dict:
        ts_s = str(int(time.time()) if ts is None else ts)
        nonce = nonce or uuid.uuid4().hex
        return {"x-dh-timestamp": ts_s, "x-dh-nonce": nonce, "x-dh-org": self.org, "x-dh-user": self.user,
                "x-dh-signature": security.sign(self.secret, ts_s, nonce, method, path, self.org, self.user, body),
                "content-type": "application/json"}

    def get(self, path: str, **kw):
        return self.c.get(path, headers=self.headers("GET", path, b"", **kw))

    def post(self, path: str, body: dict, **kw):
        raw = json.dumps(body).encode()
        return self.c.post(path, content=raw, headers=self.headers("POST", path, raw, **kw))


def wait_done(api: Signed, job_id: str, timeout: float = 10) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        r = api.get(f"/v1/hunts/{job_id}").json()
        if r["terminal"]:
            return r
        time.sleep(0.05)
    raise AssertionError("hunt did not finish")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(settings(self.tmp.name))
        self.client = TestClient(self.app)
        self.a, self.b = Signed(self.client, ORG_A), Signed(self.client, ORG_B)

    def tearDown(self):
        self.tmp.cleanup()


class Authentication(Base):
    def test_health_is_public_and_says_nothing(self):
        r = self.client.get("/healthz")
        self.assertEqual(r.json(), {"ok": True})

    def test_unsigned_request_is_refused(self):
        self.assertEqual(self.client.get("/v1/status").status_code, 401)

    def test_wrong_secret_is_refused(self):
        bad = Signed(self.client, ORG_A, secret="x" * 48)
        self.assertEqual(bad.get("/v1/status").status_code, 401)

    def test_expired_timestamp_is_refused(self):
        self.assertEqual(self.a.get("/v1/status", ts=int(time.time()) - 3600).status_code, 401)

    def test_replayed_nonce_is_refused(self):
        nonce = uuid.uuid4().hex
        self.assertEqual(self.a.get("/v1/status", nonce=nonce).status_code, 200)
        self.assertEqual(self.a.get("/v1/status", nonce=nonce).status_code, 409)

    def test_org_cannot_be_swapped_after_signing(self):
        h = self.a.headers("GET", "/v1/status", b"")
        h["x-dh-org"] = ORG_B
        self.assertEqual(self.client.get("/v1/status", headers=h).status_code, 401)

    def test_body_cannot_be_changed_after_signing(self):
        raw = json.dumps({"text": "Cerco uno sviluppatore Laravel"}).encode()
        h = self.a.headers("POST", "/v1/classify", raw)
        r = self.client.post("/v1/classify", content=json.dumps({"text": "altro"}).encode(), headers=h)
        self.assertEqual(r.status_code, 401)

    def test_short_secret_means_not_configured(self):
        app = create_app(settings(self.tmp.name, secret="short"))
        r = Signed(TestClient(app), ORG_A, secret="short").get("/v1/status")
        self.assertEqual(r.status_code, 503)

    def test_status_never_returns_secrets(self):
        body = self.a.get("/v1/status").text
        self.assertNotIn(SECRET, body)
        self.assertIn('"simulated":true', body.replace(" ", ""))


class Budget(Base):
    def test_budget_above_the_service_cap_is_refused(self):
        r = self.a.post("/v1/hunts/plan", {"seed": "Laravel", "budget": 41})
        self.assertEqual(r.status_code, 400)
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 41, "idempotency_key": uuid.uuid4().hex})
        self.assertEqual(r.status_code, 400)

    def test_plan_is_free_and_says_the_maximum(self):
        r = self.a.post("/v1/hunts/plan", {"seed": "Laravel", "budget": 10}).json()
        self.assertEqual(r["max_paid_calls"], 10)
        self.assertGreater(r["combos"], 0)
        self.assertEqual(r["mode"], "simulated")

    def test_a_hunt_never_spends_more_than_its_budget(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 7, "idempotency_key": uuid.uuid4().hex}).json()
        done = wait_done(self.a, r["job_id"])
        spent = done["hunt"]["spent"]
        self.assertLessEqual(spent["searches"] + spent["autocomplete"], 7)
        self.assertEqual(done["status"], "finita")

    def test_the_same_confirmation_never_starts_two_hunts(self):
        key = uuid.uuid4().hex
        first = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 3, "idempotency_key": key}).json()
        again = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 3, "idempotency_key": key}).json()
        self.assertEqual(first["job_id"], again["job_id"])
        self.assertTrue(again["duplicate"])
        wait_done(self.a, first["job_id"])

    def test_one_running_hunt_per_organization(self):
        slow_calls = []

        def slow_search(q):
            slow_calls.append(q)
            time.sleep(0.2)
            return []
        app = create_app(settings(self.tmp.name), externals_factory=lambda: Externals(slow_search, lambda s: [], "simulated"))
        api = Signed(TestClient(app), ORG_A)
        first = api.post("/v1/hunts", {"seed": "Laravel", "budget": 5, "idempotency_key": uuid.uuid4().hex})
        self.assertEqual(first.status_code, 200)
        second = api.post("/v1/hunts", {"seed": "React", "budget": 5, "idempotency_key": uuid.uuid4().hex})
        self.assertEqual(second.status_code, 429)
        api.post(f"/v1/hunts/{first.json()['job_id']}/stop", {})
        wait_done(api, first.json()["job_id"])

    def test_live_mode_without_provider_spends_nothing(self):
        app = create_app(settings(self.tmp.name, simulated=False))
        api = Signed(TestClient(app), ORG_A)
        r = api.post("/v1/hunts", {"seed": "Laravel", "budget": 3, "idempotency_key": uuid.uuid4().hex})
        self.assertEqual(r.status_code, 503)


class Isolation(Base):
    def test_a_job_is_invisible_to_another_organization(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 3, "idempotency_key": uuid.uuid4().hex}).json()
        wait_done(self.a, r["job_id"])
        self.assertEqual(self.b.get(f"/v1/hunts/{r['job_id']}").status_code, 404)
        self.assertEqual(self.b.post(f"/v1/hunts/{r['job_id']}/stop", {}).status_code, 404)

    def test_learning_and_dedup_are_per_organization(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 5, "idempotency_key": uuid.uuid4().hex}).json()
        wait_done(self.a, r["job_id"])
        self.assertGreater(self.a.get("/v1/learning/clienti").json()["totals"]["searches"], 0)
        self.assertEqual(self.b.get("/v1/learning/clienti").json()["totals"]["searches"], 0)
        # searches already done by A are "già fatta" for A only
        self.assertGreater(self.a.post("/v1/hunts/plan", {"seed": "Laravel", "budget": 5}).json()["already_done"], 0)
        self.assertEqual(self.b.post("/v1/hunts/plan", {"seed": "Laravel", "budget": 5}).json()["already_done"], 0)

    def test_same_idempotency_key_in_two_organizations_is_two_jobs(self):
        key = uuid.uuid4().hex
        ja = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 2, "idempotency_key": key}).json()
        jb = self.b.post("/v1/hunts", {"seed": "Laravel", "budget": 2, "idempotency_key": key}).json()
        self.assertNotEqual(ja["job_id"], jb["job_id"])
        wait_done(self.a, ja["job_id"]); wait_done(self.b, jb["job_id"])


class Classification(Base):
    def test_a_buyer_is_a_lead_with_evidence(self):
        r = reading_view("Stiamo cercando uno sviluppatore Laravel per il nostro gestionale, budget 4000 euro")
        self.assertEqual(r["author_role"], "buyer")
        self.assertEqual(r["lead_class"], "cliente")
        self.assertGreaterEqual(r["lead_score"], 70)
        self.assertTrue(any(e["signal"] == "budget" for e in r["evidence"]))

    def test_a_seller_is_never_a_lead(self):
        r = self.a.post("/v1/classify", {"text": "Sono uno sviluppatore Laravel, realizzo gestionali su misura, contattami"}).json()
        self.assertNotEqual(r["lead_class"], "cliente")
        self.assertEqual(r["author_role"], "seller")

    def test_hunt_leads_carry_the_reading(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 8, "idempotency_key": uuid.uuid4().hex}).json()
        done = wait_done(self.a, r["job_id"])
        leads = done["hunt"]["lead_list"]
        self.assertTrue(leads)
        for lead in leads:
            self.assertIn("esempio-simulato", lead["url"])          # simulated data is recognisable as such
            self.assertEqual(lead["reading"]["lead_class"], "cliente")
            self.assertTrue(lead["reading"]["evidence"])


class Dedup(Base):
    def test_off_channel_results_and_repeated_posts_are_not_leads(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 10, "idempotency_key": uuid.uuid4().hex}).json()
        leads = wait_done(self.a, r["job_id"])["hunt"]["lead_list"]
        self.assertFalse(any("example.com" in l["url"] for l in leads))
        texts = [" ".join(l["text"].lower().split()) for l in leads]
        self.assertEqual(len(texts), len(set(texts)))
        urls = [l["url"] for l in leads]
        self.assertEqual(len(urls), len(set(urls)))

    def test_a_second_hunt_does_not_pay_the_same_searches(self):
        sim, calls = simulated(), []

        def counting(q):
            calls.append(q)
            return sim.search(q)
        app = create_app(settings(self.tmp.name), externals_factory=lambda: Externals(counting, sim.autocomplete, "simulated"))
        api = Signed(TestClient(app), ORG_A)
        j1 = api.post("/v1/hunts", {"seed": "Laravel", "budget": 4, "idempotency_key": uuid.uuid4().hex}).json()
        wait_done(api, j1["job_id"])
        first = list(calls)
        j2 = api.post("/v1/hunts", {"seed": "Laravel", "budget": 4, "idempotency_key": uuid.uuid4().hex}).json()
        wait_done(api, j2["job_id"])
        self.assertFalse(set(first) & set(calls[len(first):]))


class Feedback(Base):
    def test_feedback_changes_the_learning(self):
        r = self.a.post("/v1/hunts", {"seed": "Laravel", "budget": 8, "idempotency_key": uuid.uuid4().hex}).json()
        lead = wait_done(self.a, r["job_id"])["hunt"]["lead_list"][0]
        before = self.a.get("/v1/learning/clienti").json()["totals"]["leads"]
        ok = self.a.post("/v1/learning/clienti/feedback", {"url": lead["url"], "verdict": "sbagliato"})
        self.assertEqual(ok.status_code, 200)
        after = self.a.get("/v1/learning/clienti").json()
        self.assertEqual(after["totals"]["leads"], before - 1)
        self.assertEqual(after["totals"]["feedback"], {"sbagliato": 1})
        # the verdict of A is not seen by B
        self.assertEqual(self.b.get("/v1/learning/clienti").json()["totals"]["feedback"], {})

    def test_unknown_verdict_is_refused(self):
        r = self.a.post("/v1/learning/clienti/feedback", {"url": "https://www.facebook.com/groups/x/posts/1", "verdict": "forse"})
        self.assertEqual(r.status_code, 400)

    def test_feedback_can_be_removed(self):
        url = "https://www.facebook.com/groups/esempio-simulato/posts/1"
        self.a.post("/v1/learning/clienti/feedback", {"url": url, "verdict": "giusto"})
        self.a.post("/v1/learning/clienti/feedback", {"url": url, "verdict": None})
        self.assertEqual(self.a.get("/v1/learning/clienti").json()["totals"]["feedback"], {})


class Areas(Base):
    def test_tree_is_free_and_expansion_is_idempotent(self):
        tree = self.a.get("/v1/areas/clienti").json()["tree"]
        self.assertEqual(len(tree["children"]), 8)
        key = uuid.uuid4().hex
        first = self.a.post("/v1/areas/clienti/expand", {"label": "Cybersecurity", "idempotency_key": key}).json()
        self.assertEqual(first["spent"]["autocomplete"], 2)
        again = self.a.post("/v1/areas/clienti/expand", {"label": "Cybersecurity", "idempotency_key": key}).json()
        self.assertTrue(again["duplicate"])
        # "corso" is noise for BuyerML (areas.NOISE): never a new term
        self.assertFalse(any("corso" in c["label"] for c in first["added"]))

    def test_discovered_concepts_stay_in_their_organization(self):
        self.a.post("/v1/areas/clienti/expand", {"label": "Cybersecurity", "idempotency_key": uuid.uuid4().hex})

        def labels(n):
            return {n["label"]} | set().union(*[labels(c) for c in n["children"]]) if n["children"] else {n["label"]}
        a = labels(self.a.get("/v1/areas/clienti").json()["tree"])
        b = labels(self.b.get("/v1/areas/clienti").json()["tree"])
        self.assertTrue(a - b)


if __name__ == "__main__":
    unittest.main()
