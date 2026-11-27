"""
================================================================================
BuyerML — Quello che la caccia impara (the learning database)
================================================================================
Every hunt is written down, so the system gets sharper with use, without changing how a hunt works:

  hunt_runs       one row per hunt: goal, seed, budget, spent, leads, when
  hunt_tries      one row per combination tried: verb, object, its linguistic pattern, results, leads
  hunt_posts      one row per post read: the text, the class the rules gave, the score, which query found it
  lead_feedback   your verdict on a lead (giusto | sbagliato): the ground truth, it overrides the rules

From these: the lead rate (leads per search) of each verb, object, pattern and verb + pattern, counting a lead
marked "sbagliato" as no lead and one marked "giusto" as a confirmed lead. The rates become gentle priors for the
next hunts (hunt.py): a verb or object that converted before is tried earlier, never skipped because of history.

Patterns: the shape of the object, e.g. "ruolo + tecnologia" ("sviluppatore Laravel"), "prodotto" ("CRM"),
"caso d'uso" ("gestione inventario"). The kind comes from the market areas (areas.py), else from the taxonomy.
Free: nothing here calls Google or Claude.
================================================================================
"""

from __future__ import annotations

import time

import demand

SCHEMA = """
CREATE TABLE IF NOT EXISTS hunt_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    goal        TEXT NOT NULL,
    seed        TEXT NOT NULL,
    budget      INTEGER NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    status      TEXT,
    searches    INTEGER DEFAULT 0,
    autocomplete INTEGER DEFAULT 0,
    leads       INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hunt_tries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER,
    goal        TEXT NOT NULL,
    seed        TEXT NOT NULL,
    verb        TEXT NOT NULL,
    object      TEXT NOT NULL,
    origin      TEXT,
    kind        TEXT NOT NULL,
    pattern     TEXT NOT NULL,
    query       TEXT NOT NULL,
    results     INTEGER NOT NULL,
    leads       INTEGER NOT NULL,
    at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hunt_posts (
    url         TEXT NOT NULL,
    run_id      INTEGER,
    goal        TEXT NOT NULL,
    query       TEXT NOT NULL,
    verb        TEXT NOT NULL,
    object      TEXT NOT NULL,
    text        TEXT NOT NULL,
    lead_class  TEXT NOT NULL,
    is_lead     INTEGER NOT NULL,
    score       INTEGER NOT NULL,
    role        TEXT,
    at          TEXT NOT NULL,
    PRIMARY KEY (url, goal)
);
CREATE TABLE IF NOT EXISTS lead_feedback (
    url         TEXT NOT NULL,
    goal        TEXT NOT NULL,
    verdict     TEXT NOT NULL,      -- giusto | sbagliato
    at          TEXT NOT NULL,
    PRIMARY KEY (url, goal)
);
"""
VERDICTS = ("giusto", "sbagliato")
MIN_HISTORY = 3          # searches before a verb or object's history changes its priority
PRIOR_RANGE = (0.6, 1.8)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def ensure(store) -> None:
    store.db.executescript(SCHEMA)
    store.db.commit()


# ---- the shape of an object ---------------------------------------------------------------------

_KINDS: dict[str, str] | None = None


def _area_kinds() -> dict[str, str]:
    global _KINDS
    if _KINDS is None:
        import areas
        kinds: dict[str, str] = {}

        def walk(n):
            for c in n.get("children", []):
                kinds.setdefault(areas._norm(c["label"]), c["rel"])
                walk(c)
        for g in areas.load()["goals"].values():
            walk(g)
        _KINDS = kinds
    return _KINDS


def kind_of(term: str) -> str:
    import areas
    key = areas._norm(term)
    rel = _area_kinds().get(key)
    if rel and rel not in ("sinonimo", "variante", "correlato", "sottoargomento"):
        return rel
    m = demand.match_market(term, demand.default_taxonomy())
    if m["technology"]:
        return "tecnologia"
    if m["node"]:
        return "area IT"
    return "termine"


def pattern_of(obj: str) -> tuple[str, str]:
    """(kind, pattern) of an object: "sviluppatore Laravel" -> ("ruolo + tecnologia", ...)."""
    words = obj.split()
    if words and demand.PROVIDER.fullmatch(words[0]) and len(words) > 1:
        rest = " ".join(words[1:])
        kind = f"ruolo + {kind_of(rest)}"
    elif demand.PROVIDER.fullmatch(obj):
        kind = "ruolo"
    else:
        kind = kind_of(obj)
    return kind, kind


# ---- writing ------------------------------------------------------------------------------------

def start_run(store, goal: str, seed: str, budget: int) -> int:
    ensure(store)
    cur = store.db.execute("INSERT INTO hunt_runs (goal, seed, budget, started_at, status) VALUES (?, ?, ?, ?, 'in corso')",
                           (goal, seed, budget, _now()))
    store.db.commit()
    return cur.lastrowid


def end_run(store, run_id: int, status: str, spent: dict, leads: int) -> None:
    store.db.execute("UPDATE hunt_runs SET ended_at = ?, status = ?, searches = ?, autocomplete = ?, leads = ? WHERE id = ?",
                     (_now(), status, spent.get("searches", 0), spent.get("autocomplete", 0), leads, run_id))
    store.db.commit()


def record_try(store, run_id: int | None, goal: str, seed: str, verb: str, obj: str, origin: str, query: str,
               posts: list[dict]) -> None:
    """One combination tried, with every post read (url, text, reading, is_lead)."""
    ensure(store)
    kind, pattern = pattern_of(obj)
    leads = sum(p["is_lead"] for p in posts)
    store.db.execute("INSERT INTO hunt_tries (run_id, goal, seed, verb, object, origin, kind, pattern, query, results, leads, at)"
                     " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (run_id, goal, seed, verb, obj, origin, kind, pattern, query, len(posts), leads, _now()))
    for p in posts:
        r = p["reading"]
        store.db.execute("INSERT OR IGNORE INTO hunt_posts (url, run_id, goal, query, verb, object, text, lead_class, is_lead,"
                         " score, role, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (p["url"], run_id, goal, query, verb, obj, p["text"], r.lead_class, int(p["is_lead"]), r.lead_score,
                          r.author_role, _now()))
    store.db.commit()


def set_feedback(store, url: str, goal: str, verdict: str | None) -> None:
    ensure(store)
    if verdict is None:
        store.db.execute("DELETE FROM lead_feedback WHERE url = ? AND goal = ?", (url, goal))
    elif verdict in VERDICTS:
        store.db.execute("INSERT OR REPLACE INTO lead_feedback (url, goal, verdict, at) VALUES (?, ?, ?, ?)",
                         (url, goal, verdict, _now()))
    else:
        raise ValueError(f"Giudizio sconosciuto: {verdict}")
    store.db.commit()


def feedback(store, goal: str) -> dict[str, str]:
    ensure(store)
    return {r["url"]: r["verdict"] for r in store.db.execute("SELECT url, verdict FROM lead_feedback WHERE goal = ?", (goal,))}


# ---- reading back -------------------------------------------------------------------------------

def stats(store, goal: str) -> dict:
    """Lead rate per verb, object, pattern and verb + pattern. A post marked "sbagliato" is not a lead;
    one marked "giusto" is a lead even if the rules missed it."""
    ensure(store)
    rows = store.db.execute(
        "SELECT p.verb, p.object, p.query, p.url, p.is_lead, f.verdict FROM hunt_posts p LEFT JOIN lead_feedback f"
        " ON f.url = p.url AND f.goal = p.goal WHERE p.goal = ?", (goal,)).fetchall()
    tries = store.db.execute("SELECT verb, object, pattern, query FROM hunt_tries WHERE goal = ?", (goal,)).fetchall()
    pattern = {t["object"]: t["pattern"] for t in tries}
    groups: dict[str, dict[str, dict]] = {"verbs": {}, "objects": {}, "patterns": {}, "verb_patterns": {}}

    def keys(verb: str, obj: str) -> dict[str, str]:
        pat = pattern.get(obj) or pattern_of(obj)[1]
        return {"verbs": verb, "objects": obj, "patterns": pat, "verb_patterns": f"«{verb}» + {pat}"}

    seen_queries: set[str] = set()
    for t in tries:
        if t["query"] in seen_queries:
            continue
        seen_queries.add(t["query"])
        for g, k in keys(t["verb"], t["object"]).items():
            s = groups[g].setdefault(k, {"key": k, "searches": 0, "posts": 0, "leads": 0, "confirmed": 0, "wrong": 0})
            s["searches"] += 1
    for r in rows:
        lead = (r["is_lead"] and r["verdict"] != "sbagliato") or r["verdict"] == "giusto"
        for g, k in keys(r["verb"], r["object"]).items():
            s = groups[g].setdefault(k, {"key": k, "searches": 0, "posts": 0, "leads": 0, "confirmed": 0, "wrong": 0})
            s["posts"] += 1
            s["leads"] += int(bool(lead))
            s["confirmed"] += int(r["verdict"] == "giusto")
            s["wrong"] += int(r["verdict"] == "sbagliato" and bool(r["is_lead"]))
    total_leads = sum(int(bool((r["is_lead"] and r["verdict"] != "sbagliato") or r["verdict"] == "giusto")) for r in rows)
    base = (total_leads + 1) / (len(seen_queries) + 2)
    out = {}
    for g, items in groups.items():
        for s in items.values():
            s["rate"] = round(s["leads"] / s["searches"], 2) if s["searches"] else 0.0
            # ranked by a smoothed rate: one lucky search does not beat ten good ones
            s["score"] = round((s["leads"] + 2 * base) / (s["searches"] + 2), 3)
        out[g] = sorted(items.values(), key=lambda s: (-s["score"], -s["leads"]))
    runs = store.db.execute("SELECT COUNT(DISTINCT COALESCE(CAST(run_id AS TEXT), 'prima:' || seed)) n FROM hunt_tries"
                            " WHERE goal = ?", (goal,)).fetchone()
    fb = store.db.execute("SELECT verdict, COUNT(*) n FROM lead_feedback WHERE goal = ? GROUP BY verdict", (goal,)).fetchall()
    out["totals"] = {"hunts": runs["n"], "searches": len(seen_queries), "posts": len(rows),
                     "leads": total_leads,
                     "feedback": {r["verdict"]: r["n"] for r in fb}}
    return out


def priors(store, goal: str) -> dict[str, dict[str, float]]:
    """A gentle factor per verb and per pattern from the past lead rates, relative to the average (1.0 = no change)."""
    s = stats(store, goal)
    total = s["totals"]
    base = (total["leads"] + 1) / (total["searches"] + 2)

    def factors(items):
        out = {}
        for it in items:
            if it["searches"] >= MIN_HISTORY:
                rate = it["score"]
                out[it["key"]] = round(min(PRIOR_RANGE[1], max(PRIOR_RANGE[0], rate / base)), 2)
        return out
    return {"verbs": factors(s["verbs"]), "patterns": factors(s["patterns"]), "objects": factors(s["objects"])}


def backfill(store) -> int:
    """Rebuild the learning tables from the hunts done before they existed (searches + leads of 'caccia:'). Free."""
    import hunt
    from label_demand import post_text
    ensure(store)
    done = {r["query"] for r in store.db.execute("SELECT query FROM hunt_tries")}
    added = 0
    for goal, g in hunt.GOALS.items():
        rows = store.db.execute("SELECT search_text, combination_id, origin_trend FROM searches WHERE origin_trend LIKE ?",
                                (g["origin"] + ":%",)).fetchall()
        for s in rows:
            if s["search_text"] in done or not (s["combination_id"] or "").startswith("caccia|"):
                continue
            _, verb, obj = s["combination_id"].split("|", 2)
            seed = s["origin_trend"].split(":", 1)[1]
            posts = []
            for l in store.db.execute("SELECT url, title, snippet FROM leads WHERE search_text = ? AND on_channel = 1",
                                      (s["search_text"],)):
                text = post_text({"title": l["title"] or "", "snippet": l["snippet"] or ""})
                if text:
                    r = demand.read(text)
                    posts.append({"url": l["url"], "text": text, "reading": r, "is_lead": r.lead_class in g["classes"]})
            record_try(store, None, goal, seed, verb, obj, "storico", s["search_text"], posts)
            added += 1
    return added
