"""
================================================================================
BuyerML — query generation and the Query Rotation Engine (spec v1.0, §9, §10, §17)
================================================================================
Everything (trends, discovery, validation, the Mercati–Keyword table) converges on one
output: a pair "intent expression" + "keyword", Componente A + Componente B. Never more
than two terms. Only two channels, with different destinations:

  facebook          site:facebook.com/groups "{A}" "{B}"                      → needs
  linkedin_profile  site:linkedin.com/in "{ruolo}"                            → prospects (command A)
  linkedin_post     site:linkedin.com/posts ("{intent1}" OR "{intent2}") "{solution}"  (command B)

Generation makes every combination available (dork_query, not executed). The rotation
decides what runs in a cycle, inside the budget: the markets the person chose (all of them, in the order
of choice), quotas per market with a minimum share, the 60/25/15 split between
monitoring, expansion and exploration, keyword priority from the measured yield (or an
exploration prior while a keyword has few results), A1/A4 weighing more, least recently
used expressions first, nothing repeated within MIN_REQUERY_DAYS. A result found by more
queries counts once (url_hash). The parameters live in the database (config), editable.
================================================================================
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from urllib.parse import urlparse, urlunparse

from markets import MarketTable, normalize

CHANNELS = ("facebook", "linkedin_profile", "linkedin_post")
# the channel name the reading pipeline (leads, classification) already knows
LEAD_CHANNEL = {"facebook": "facebook_groups", "linkedin_profile": "linkedin_profiles", "linkedin_post": "linkedin_posts"}
CHANNEL_DOMAIN = {"facebook": "facebook.com", "linkedin_profile": "linkedin.com", "linkedin_post": "linkedin.com"}

# §17: initial values, to be tuned on real data
DEFAULTS = {
    "BUDGET_SERPAPI_SEARCH_FB": 20, "BUDGET_SERPAPI_SEARCH_LI": 10, "RESULTS_PER_QUERY": 10,
    "SIGNAL_BOOST": 0.5, "MIN_MARKET_SHARE": 0.05,
    "SPLIT_MONITOR": 0.60, "SPLIT_EXPAND": 0.25, "SPLIT_EXPLORE": 0.15,
    "MIN_RESULTS_FOR_PERF": 20, "ACTIVITY_BOOST": 1.3, "MIN_REQUERY_DAYS": 14,
    "W1": 0.2, "W2": 0.3, "W3": 0.3, "W4": 0.2, "EXPLORATION_PRIOR": 0.5, "TREND_BONUS": 0.3,
    "LI_POST_SHARE": 0.2,
    # §7.4, §8.4 (trends.py)
    "N_RECENT": 4, "N_BASE": 12, "Z_MIN": 2.0, "MIN_INTEREST": 10, "MIN_BASE": 5, "RISING_MIN_PCT": 200,
    "RELATED_PER_CYCLE": 5, "VALIDATION_MIN_SIGNALS": 2, "PERSIST_CYCLES": 2, "STALE_CYCLES": 6,
    "MIN_FB_RELEVANT": 3, "YIELD_MIN": 0.10,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS dork_query (
    id                   INTEGER PRIMARY KEY,
    channel              TEXT NOT NULL CHECK (channel IN ('facebook','linkedin_profile','linkedin_post')),
    query_string         TEXT NOT NULL UNIQUE,
    intent_expression_id INTEGER REFERENCES intent_expression(id),
    keyword_id           INTEGER REFERENCES keyword(id),
    variant              TEXT,                      -- the keyword_variant used as Componente B, if any
    role_id              INTEGER REFERENCES role(id),
    market_id            TEXT REFERENCES market(id),
    last_run_at          TEXT,
    runs                 INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cycle (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    budget      TEXT,
    summary     TEXT
);
CREATE TABLE IF NOT EXISTS dork_run (
    id            INTEGER PRIMARY KEY,
    query_id      INTEGER NOT NULL REFERENCES dork_query(id),
    cycle_id      INTEGER NOT NULL,
    ran_at        TEXT NOT NULL,
    results_count INTEGER NOT NULL,
    cost_units    INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dork_result (
    id             INTEGER PRIMARY KEY,
    url            TEXT NOT NULL,
    url_hash       TEXT NOT NULL UNIQUE,
    channel        TEXT NOT NULL,
    title          TEXT,
    snippet        TEXT,
    first_query_id INTEGER REFERENCES dork_query(id),
    found_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dork_result_query (
    result_id INTEGER NOT NULL REFERENCES dork_result(id),
    query_id  INTEGER NOT NULL REFERENCES dork_query(id),
    PRIMARY KEY (result_id, query_id)
);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS result_verdict (       -- a person's judgement on a result: it outranks the reading
    url        TEXT PRIMARY KEY,
    verdict    TEXT NOT NULL CHECK (verdict IN ('confirmed','rejected')),
    judged_at  TEXT NOT NULL
);
"""


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _q(text: str) -> str:
    """One component between double quotes, single spaces, case as in the seed."""
    return '"' + " ".join(str(text).replace('"', "").split()) + '"'


# ---- §9.1 the exact grammar ------------------------------------------------------------------

def facebook_query(expression: str, keyword: str) -> str:
    return f"site:facebook.com/groups {_q(expression)} {_q(keyword)}"


def linkedin_profile_query(role: str) -> str:
    return f"site:linkedin.com/in {_q(role)}"


def linkedin_post_query(intent1: str, intent2: str, solution: str) -> str:
    return f"site:linkedin.com/posts ({_q(intent1)} OR {_q(intent2)}) {_q(solution)}"


def normalize_url(url: str) -> str:
    p = urlparse(url.strip())
    host = p.netloc.lower().split(":")[0]
    host = host[4:] if host.startswith("www.") else host
    host = host[2:] if host.startswith("m.") else host
    return urlunparse(("https", host, p.path.rstrip("/"), "", "", ""))


def url_hash(url: str) -> str:
    return hashlib.sha256(normalize_url(url).encode()).hexdigest()


def on_channel(url: str, channel: str) -> bool:
    host = urlparse(url).netloc.lower().split(":")[0]
    domain = CHANNEL_DOMAIN[channel]
    return host == domain or host.endswith("." + domain)


class Dorking:
    def __init__(self, db):
        self.db = db
        self.db.executescript(SCHEMA)
        self.db.commit()
        self.table = MarketTable(db)

    # ---- §17 parameters ----------------------------------------------------------------------

    def params(self) -> dict:
        stored = {r[0]: json.loads(r[1]) for r in self.db.execute("SELECT key, value FROM config")}
        return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}

    def set_params(self, values: dict, actor: str = "operatore") -> dict:
        for k, v in values.items():
            if k not in DEFAULTS:
                raise ValueError(f"parametro sconosciuto: {k}")
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                raise ValueError(f"{k} deve essere un numero non negativo")
            self.db.execute("INSERT OR REPLACE INTO config VALUES (?, ?)", (k, json.dumps(v)))
            self.table.audit(actor, "config", "config", k, {"to": v})
        self.db.commit()
        return self.params()

    # ---- search preferences: where to search and which ways of asking (one place, read by every path) ----

    PREF_CHANNELS = ("facebook", "linkedin")
    PREF_GROUPS = ("A1", "A2", "A3", "A4", "A5")

    def prefs(self) -> dict:
        row = self.db.execute("SELECT value FROM config WHERE key = 'PREFS'").fetchone()
        stored = json.loads(row[0]) if row else {}
        return {"channels": stored.get("channels") or list(self.PREF_CHANNELS),
                "intent_groups": stored.get("intent_groups") or list(self.PREF_GROUPS)}

    def set_prefs(self, channels: list[str] | None = None, intent_groups: list[str] | None = None, actor: str = "operatore") -> dict:
        cur = self.prefs()
        if channels is not None:
            chosen = sorted({c for c in channels if c in self.PREF_CHANNELS})
            if not chosen:
                raise ValueError("serve almeno un canale: gruppi Facebook o LinkedIn")
            cur["channels"] = chosen
        if intent_groups is not None:
            chosen = sorted({g for g in intent_groups if g in self.PREF_GROUPS})
            if not chosen:
                raise ValueError("serve almeno un gruppo di espressioni d'intento")
            cur["intent_groups"] = chosen
        self.db.execute("INSERT OR REPLACE INTO config VALUES ('PREFS', ?)", (json.dumps(cur),))
        self.table.audit(actor, "prefs", "config", "PREFS", cur)
        self.db.commit()
        return cur

    # ---- §9 generation: every combination available, nothing executed --------------------------

    def _save(self, channel: str, query: str, expression_id=None, keyword_id=None, variant=None, role_id=None,
              market_id=None) -> int:
        self.db.execute("INSERT OR IGNORE INTO dork_query (channel, query_string, intent_expression_id, keyword_id, variant,"
                        " role_id, market_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (channel, query, expression_id, keyword_id, variant, role_id, market_id))
        return self.db.execute("SELECT id FROM dork_query WHERE query_string = ?", (query,)).fetchone()[0]

    @staticmethod
    def facebook_b(k: dict) -> list[str | None]:
        """The Componenti B of a keyword on Facebook: itself (natural, or technical marked usable) and its variants."""
        if k["register"] != "natural" and not k["fb_usable"]:
            return []
        return [None] + [v["text"] for v in k["variants"]]

    def generate_for_keyword(self, keyword_id: int) -> int:
        k = self.table.keyword(keyword_id)
        market = k["markets"][0] if k["markets"] else None
        n = 0
        for variant in self.facebook_b(k):
            for e in self.table.expressions():
                self._save("facebook", facebook_query(e["text"], variant or k["text"]), e["id"], k["id"], variant, market_id=market)
                n += 1
        self.db.commit()
        return n

    def generate_all(self) -> dict:
        """Every active keyword's pairs, every active role, the LinkedIn post command (idempotent)."""
        fb = sum(self.generate_for_keyword(k["id"])
                 for k in self.table.keywords(statuses=("validated", "validating", "candidate")))
        for r in self.table.roles():
            self._save("linkedin_profile", linkedin_profile_query(r["title"]), role_id=r["id"])
        for intents, solution in self._post_commands():
            self._save("linkedin_post", linkedin_post_query(*intents, solution))
        self.db.commit()
        return {"facebook": fb, "linkedin_profile": len(self.table.roles()), "linkedin_post": len(self._post_commands())}

    def _post_commands(self) -> list[tuple[tuple[str, str], str]]:
        seed = self._seed()
        intents = seed.get("linkedin_post_intents", [])
        pairs = [(intents[i], intents[i + 1]) for i in range(0, len(intents) - 1, 2)]
        return [(p, s) for p in pairs for s in seed.get("linkedin_post_solutions", [])]

    @staticmethod
    def _seed() -> dict:
        from markets import SEED_PATH
        with open(SEED_PATH, encoding="utf-8") as f:
            return json.load(f)

    def queries(self, channel: str | None = None, keyword_id: int | None = None) -> list[dict]:
        where, params = ["1 = 1"], []
        if channel:
            where.append("q.channel = ?")
            params.append(channel)
        if keyword_id:
            where.append("q.keyword_id = ?")
            params.append(keyword_id)
        rows = self.db.execute(
            "SELECT q.*, e.text AS expression, e.intent_group, e.strength, k.text AS keyword, r.title AS role"
            " FROM dork_query q LEFT JOIN intent_expression e ON e.id = q.intent_expression_id"
            " LEFT JOIN keyword k ON k.id = q.keyword_id LEFT JOIN role r ON r.id = q.role_id"
            f" WHERE {' AND '.join(where)} ORDER BY q.id", params)
        return [dict(r) for r in rows]

    # ---- §10 the rotation ---------------------------------------------------------------------

    def cycle_no(self) -> int:
        """The cycle being planned: the cycles already run, plus one (the quiz's guided searches are not cycles)."""
        return self.db.execute("SELECT COUNT(*) FROM cycle WHERE COALESCE(json_extract(budget, '$.kind'), 'cycle') = 'cycle'").fetchone()[0] + 1

    def active_markets(self, cycle_no: int, p: dict) -> list[dict]:
        """The markets the person chose (market.selected), in the order of choice, all from the first cycle
        (S03-R03): no market is favoured by the code. None chosen: none searched."""
        chosen = [r[0] for r in self.db.execute("SELECT id FROM market WHERE selected = 1 ORDER BY selected_order, id")]
        by_id = {m["id"]: m for m in self.table.markets()}
        return [by_id[i] for i in chosen]

    def strong_signals(self, market_id: str) -> int:
        """Signals of the last 2 cycles on the market's keywords (the signal table arrives with Trend Detection)."""
        if not self.db.execute("SELECT 1 FROM sqlite_master WHERE name = 'signal'").fetchone():
            return 0
        return self.db.execute("SELECT COUNT(*) FROM signal WHERE keyword_id IN (SELECT keyword_id FROM keyword_market"
                               " WHERE market_id = ?) AND detected_at >= datetime('now', '-14 days')", (market_id,)).fetchone()[0]

    def performance(self, keyword_id: int) -> dict:
        """
        §5 keyword_performance. The reading of the posts gives relevant = declared or symptom, concrete
        need = declared, commercial intent = declared by a company; a person's verdict outranks it:
        "rejected" is never relevant, "confirmed" always is.
        """
        relevant = ("(v.verdict = 'confirmed' OR (v.verdict IS NULL AND tl.signal IN ('declared','symptom')))")
        row = self.db.execute(
            "SELECT COUNT(DISTINCT r.id),"
            f" COUNT(DISTINCT CASE WHEN {relevant} THEN r.id END),"
            " COUNT(DISTINCT CASE WHEN tl.signal = 'declared' AND COALESCE(v.verdict, '') != 'rejected' THEN r.id END),"
            " COUNT(DISTINCT CASE WHEN tl.signal = 'declared' AND tl.is_business = 1 AND COALESCE(v.verdict, '') != 'rejected' THEN r.id END),"
            " COUNT(DISTINCT CASE WHEN v.verdict = 'rejected' THEN r.id END), COUNT(DISTINCT CASE WHEN v.verdict IS NOT NULL THEN r.id END)"
            " FROM dork_query q JOIN dork_result_query rq ON rq.query_id = q.id JOIN dork_result r ON r.id = rq.result_id"
            " LEFT JOIN theme_leads tl ON tl.lead_url = r.url LEFT JOIN result_verdict v ON v.url = r.url"
            " WHERE q.keyword_id = ?", (keyword_id,)).fetchone()
        return {"results": row[0], "relevant": row[1], "concrete_needs": row[2], "commercial_intent": row[3], "useful_contacts": 0,
                "rejected": row[4], "judged": row[5]}

    def set_verdict(self, url: str | list[str], verdict: str | None, actor: str = "operatore") -> None:
        """A person says a result is pertinent or not (None takes the judgement back). Every change is in the audit log."""
        urls = [url] if isinstance(url, str) else list(url)
        if verdict not in (None, "confirmed", "rejected"):
            raise ValueError("il giudizio è: pertinente (confirmed) o non pertinente (rejected)")
        for u in urls:   # one post may have several addresses: the judgement covers them all
            if not self.db.execute("SELECT 1 FROM dork_result WHERE url = ?", (u,)).fetchone() and \
                    not self.db.execute("SELECT 1 FROM leads WHERE url = ?", (u,)).fetchone():
                raise KeyError(u)
        for u in urls:
            if verdict is None:
                self.db.execute("DELETE FROM result_verdict WHERE url = ?", (u,))
            else:
                self.db.execute("INSERT OR REPLACE INTO result_verdict VALUES (?, ?, ?)", (u, verdict, _now()))
            self.table.audit(actor, "verdict", "result", u, {"verdict": verdict})
        self.db.commit()

    def _trend_rising(self, k: dict) -> bool:
        if not k["seed_term_id"]:
            return False
        from themes import RISING_STAGES
        row = self.db.execute("SELECT result FROM seed_checks WHERE term_id = ? AND kind = 'trends' ORDER BY checked_at DESC, rowid DESC LIMIT 1",
                              (k["seed_term_id"],)).fetchone()
        return bool(row) and json.loads(row[0]).get("stage") in RISING_STAGES

    def priority(self, k: dict, p: dict) -> tuple[float, str]:
        """The keyword's rotation priority and why, in words."""
        perf = self.performance(k["id"])
        if perf["results"] >= p["MIN_RESULTS_FOR_PERF"]:
            rate = lambda x: x / perf["results"]  # noqa: E731
            value = (p["W1"] * rate(perf["relevant"]) + p["W2"] * rate(perf["concrete_needs"])
                     + p["W3"] * rate(perf["commercial_intent"]) + p["W4"] * rate(perf["useful_contacts"]))
            why = f"resa misurata su {perf['results']} risultati"
        else:
            value = p["EXPLORATION_PRIOR"] + (p["TREND_BONUS"] if self._trend_rising(k) else 0)
            why = "nuova: va provata" + (" · in crescita su Google" if self._trend_rising(k) else "")
        if k["kw_type"] == "activity_problem":
            value *= p["ACTIVITY_BOOST"]
            why += " · descrive un'attività"
        return round(value, 4), why

    def _recent(self, p: dict) -> set[str]:
        return {r[0] for r in self.db.execute(
            "SELECT query_string FROM dork_query WHERE last_run_at IS NOT NULL AND last_run_at >= datetime('now', 'localtime', ?)",
            (f"-{int(p['MIN_REQUERY_DAYS'])} days",))}

    @staticmethod
    def _split(n: int, shares: list[float]) -> list[int]:
        """n units split by shares, largest remainder."""
        total = sum(shares) or 1
        raw = [n * s / total for s in shares]
        out = [math.floor(x) for x in raw]
        for i in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: n - sum(out)]:
            out[i] += 1
        return out

    def _buckets(self, market_id: str, focus: set[int] | None) -> dict[str, list[tuple[dict, str | None]]]:
        """monitor: validated keywords · expand: keywords in verification and the variants · explore: candidates."""
        out = {"monitor": [], "expand": [], "explore": []}
        for k in self.table.keywords(market=market_id, statuses=("validated", "validating", "candidate")):
            if focus is not None and k["id"] not in focus:
                continue
            bs = self.facebook_b(k)
            if not bs:
                continue
            if k["validation_status"] == "validated":
                out["monitor"].append((k, None))
                out["expand"] += [(k, v) for v in bs if v]
            elif k["validation_status"] == "validating":
                out["expand"] += [(k, v) for v in bs]
            else:
                out["explore"] += [(k, v) for v in bs]
        return out

    def _pick_pairs(self, items: list[tuple[dict, str | None]], n: int, p: dict, recent: set[str], taken: set[str],
                    groups: tuple[str, ...] | None = None) -> list[dict]:
        """
        n pairs from the bucket: keywords by priority, then for each keyword the expression not used for the
        longest time (never used first), A1/A4 (strength 3) before the others; round after round.
        """
        if n <= 0 or not items:
            return []
        exprs = [e for e in self.table.expressions() if not groups or e["intent_group"] in groups]
        last = {}
        for r in self.db.execute("SELECT keyword_id, intent_expression_id, variant, MAX(last_run_at) FROM dork_query"
                                 " WHERE channel = 'facebook' AND last_run_at IS NOT NULL GROUP BY 1, 2, 3"):
            last[(r[0], r[1], r[2])] = r[3]
        ranked = sorted(((self.priority(k, p), k, v) for k, v in items), key=lambda x: (-x[0][0], x[1]["id"], x[2] or ""))
        weave = self._weave(exprs)
        queues = []
        for i, ((prio, why), k, v) in enumerate(ranked):
            b = v or k["text"]
            # never used (or used longest ago) first; then the woven order, shifted by one for every keyword:
            # in one cycle the keywords get different expressions and the A groups alternate
            pos = {e["id"]: (j - i) % len(weave) for j, e in enumerate(weave)}
            order = sorted(exprs, key=lambda e: (last.get((k["id"], e["id"], v)) or "", -e["strength"], pos[e["id"]]))
            queues.append((k, v, prio, why, [e for e in order if facebook_query(e["text"], b) not in recent]))
        out = []
        while len(out) < n and any(q[4] for q in queues):
            for k, v, prio, why, q in queues:
                while q and facebook_query(q[0]["text"], v or k["text"]) in taken:
                    q.pop(0)
                if not q or len(out) >= n:
                    continue
                e = q.pop(0)
                query = facebook_query(e["text"], v or k["text"])
                taken.add(query)
                out.append({"channel": "facebook", "query": query, "keyword_id": k["id"], "keyword": k["text"], "variant": v,
                            "expression_id": e["id"], "expression": e["text"], "intent_group": e["intent_group"],
                            "priority": prio, "why": why})
        return out

    @staticmethod
    def _weave(exprs: list[dict]) -> list[dict]:
        """Strongest first (A1/A4, then A2/A5, then A3), the groups of the same strength taken in turn: A1, A4, A1, A4…"""
        out = []
        for strength in sorted({e["strength"] for e in exprs}, reverse=True):
            groups = {}
            for e in exprs:
                if e["strength"] == strength:
                    groups.setdefault(e["intent_group"], []).append(e)
            lists = [groups[g] for g in sorted(groups)]
            for j in range(max(len(x) for x in lists)):
                out += [x[j] for x in lists if j < len(x)]
        return out

    def plan_cycle(self, budget: dict | None = None, focus: list[int] | None = None, cycle_no: int | None = None,
                   channels=CHANNELS, groups: tuple[str, ...] | None = None) -> dict:
        """
        The queries of the next cycle (nothing executed, nothing written). budget: {"facebook": n, "linkedin": n};
        focus: only these keywords (the quiz), in their markets, without the progressive activation.
        """
        p = self.params()
        cycle_no = cycle_no or self.cycle_no()
        budget = budget or {"facebook": int(p["BUDGET_SERPAPI_SEARCH_FB"]), "linkedin": int(p["BUDGET_SERPAPI_SEARCH_LI"])}
        recent = self._recent(p)
        taken: set[str] = set()
        focus_set = set(focus) if focus is not None else None
        if focus_set is not None:
            ids = {m for k in focus_set for m in self.table.keyword(k)["markets"]}
            markets = [self.table.market(m) for m in sorted(ids)]
        else:
            markets = self.active_markets(cycle_no, p)
        fb = []
        quotas = {}
        if "facebook" in channels and markets and budget.get("facebook", 0) > 0:
            weights = []
            for m in markets:
                w = 1 + p["SIGNAL_BOOST"] * self.strong_signals(m["id"])   # equal weight, raised only by measured signals
                weights.append(w)
            total = budget["facebook"]
            floor = math.ceil(p["MIN_MARKET_SHARE"] * total) if len(markets) * math.ceil(p["MIN_MARKET_SHARE"] * total) <= total else 0
            share = self._split(total - floor * len(markets), weights)
            for m, s in zip(markets, share):
                quotas[m["id"]] = s + floor
            spare = 0
            for m in markets:
                buckets = self._buckets(m["id"], focus_set)
                n = quotas[m["id"]] + spare
                names = [b for b in ("monitor", "expand", "explore") if buckets[b]]
                shares = [p[f"SPLIT_{b.upper()}"] for b in names]
                got = []
                for b, nb in zip(names, self._split(n, shares) if names else []):
                    picked = self._pick_pairs(buckets[b], nb, p, recent, taken, groups)
                    for x in picked:
                        x.update(market_id=m["id"], bucket=b)
                    got += picked
                # a bucket with fewer pairs than its share passes them to the others of the market
                for b in names:
                    if len(got) >= n:
                        break
                    more = self._pick_pairs(buckets[b], n - len(got), p, recent, taken, groups)
                    for x in more:
                        x.update(market_id=m["id"], bucket=b)
                    got += more
                spare = n - len(got)
                fb += got
        li = []
        n_li = budget.get("linkedin", 0)
        if n_li > 0:
            want_post = "linkedin_post" in channels
            want_profile = "linkedin_profile" in channels
            last = {r[0]: r[1] for r in self.db.execute("SELECT query_string, last_run_at FROM dork_query WHERE last_run_at IS NOT NULL")}
            posts = sorted([c for c in self._post_commands() if linkedin_post_query(*c[0], c[1]) not in recent],
                           key=lambda c: last.get(linkedin_post_query(*c[0], c[1])) or "")
            n_post = 0 if not want_post else (n_li if not want_profile else round(n_li * p["LI_POST_SHARE"]))
            n_post = min(n_post, len(posts))                      # what the post command cannot use goes to the profiles
            n_profile = n_li - n_post if want_profile else 0
            if n_profile:
                roles = sorted(self.table.roles(), key=lambda r: (last.get(linkedin_profile_query(r["title"])) or "", r["id"]))
                for r in roles:
                    q = linkedin_profile_query(r["title"])
                    if q not in recent and len(li) < n_profile:
                        li.append({"channel": "linkedin_profile", "query": q, "role_id": r["id"], "role": r["title"],
                                   "why": "ruolo seed" if r["origin"] == "seed" else "ruolo simile (DNA)"})
            for intents, solution in posts[:n_post]:
                li.append({"channel": "linkedin_post", "query": linkedin_post_query(*intents, solution),
                           "why": "chi chiede automazione in un post"})
        return {"cycle_no": cycle_no, "markets": [{"id": m["id"], "name": m["name"], "quota": quotas.get(m["id"], 0)} for m in markets],
                "budget": budget, "queries": fb + li,
                "counts": {c: sum(1 for x in fb + li if x["channel"] == c) for c in CHANNELS}}

    # ---- execution: SerpApi Google Search, never facebook.com or linkedin.com directly ------------

    def execute(self, planned: list[dict], store, search, kind: str = "cycle", progress=None, steps: int | None = None) -> dict:
        """
        Runs the planned queries in one cycle. Results go to dork_result (dedup by url_hash, the same result
        from several queries counted once) and to the leads the reading already knows. A failed search counts
        against the budget and is not saved.
        """
        cycle_id = self.db.execute("INSERT INTO cycle (started_at, budget) VALUES (?, ?)",
                                   (_now(), json.dumps({"kind": kind, "queries": len(planned)}))).lastrowid
        self.db.commit()
        out = {"executed": 0, "results": 0, "new_results": 0, "new_leads": 0, "off_channel": 0, "failed": []}
        for i, x in enumerate(planned, 1):
            if progress:
                progress(i, steps or len(planned))
            ch = x["channel"]
            qid = self._save(ch, x["query"], x.get("expression_id"), x.get("keyword_id"), x.get("variant"), x.get("role_id"),
                             x.get("market_id"))
            self.db.commit()
            try:
                results = search(x["query"])
            except Exception as e:  # noqa: BLE001 - one search failing does not stop the cycle
                out["failed"].append({"query": x["query"], "error": str(e)[:200]})
                continue
            hidden = {r[0] for r in self.db.execute("SELECT url_hash FROM suppression")} if self.db.execute(
                "SELECT 1 FROM sqlite_master WHERE name = 'suppression'").fetchone() else set()
            # off the channel, or asked not to be contacted again (§16: excluded for ever)
            kept = [r for r in results if on_channel(r["url"], ch) and url_hash(r["url"]) not in hidden]
            off = len(results) - len(kept)
            now = _now()
            self.db.execute("INSERT INTO dork_run (query_id, cycle_id, ran_at, results_count) VALUES (?, ?, ?, ?)",
                            (qid, cycle_id, now, len(kept)))
            self.db.execute("UPDATE dork_query SET last_run_at = ?, runs = runs + 1 WHERE id = ?", (now, qid))
            for r in kept:
                h = url_hash(r["url"])
                cur = self.db.execute("INSERT OR IGNORE INTO dork_result (url, url_hash, channel, title, snippet, first_query_id, found_at)"
                                      " VALUES (?, ?, ?, ?, ?, ?, ?)", (r["url"], h, ch, r.get("title", ""), r.get("snippet", ""), qid, now))
                out["new_results"] += cur.rowcount
                rid = self.db.execute("SELECT id FROM dork_result WHERE url_hash = ?", (h,)).fetchone()[0]
                self.db.execute("INSERT OR IGNORE INTO dork_result_query VALUES (?, ?)", (rid, qid))
            self.db.commit()
            lead_origin = (f"kw:{x['keyword_id']}" if x.get("keyword_id") else f"role:{x['role_id']}" if x.get("role_id") else "li:post")
            out["new_leads"] += store.save_search({"search_text": x["query"], "channel": LEAD_CHANNEL[ch],
                                                   "combination_id": x.get("intent_group") or ch, "origin_trend": lead_origin},
                                                  [{**r, "channel": LEAD_CHANNEL[ch]} for r in kept], off_channel=off)
            out["executed"] += 1
            out["results"] += len(kept)
            out["off_channel"] += off
        for x in planned:
            if x.get("keyword_id"):
                prio, _ = self.priority(self.table.keyword(x["keyword_id"]), self.params())
                self.db.execute("UPDATE keyword SET rotation_priority = ? WHERE id = ?", (prio, x["keyword_id"]))
        self.db.execute("UPDATE cycle SET finished_at = ?, summary = ? WHERE id = ?",
                        (_now(), json.dumps({k: v for k, v in out.items() if k != "failed"}), cycle_id))
        self.db.commit()
        return {**out, "cycle_id": cycle_id}
