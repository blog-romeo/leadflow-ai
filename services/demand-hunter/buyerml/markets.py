"""
================================================================================
BuyerML — the Mercati–Keyword table (spec v1.0, §5, §6, §13): the one source of truth
================================================================================
Every discovery ends here; every social query starts from here.

  market             M01..M15 (then M16...): active, to_confirm, candidate, paused
  keyword            Componente B: register natural (Facebook) or technical (Google),
                     kw_type technology / activity_problem / desired_outcome,
                     validation_status, origin and the reason it was added
  keyword_market     a keyword can live in several markets
  keyword_variant    plurals, synonyms, translations, colloquial forms
  intent_expression  Componente A: the 39 seed expressions in A1–A5 (+3 variants)
  fb_group           the known Facebook groups, classified from the name, not verified
  role               the 22 LinkedIn seed roles (the DNA arrives in a later slice)
  audit_log          every human action and every change of state

Keywords are never deleted: they are paused. The seed bank (seeds.py) stays as
it is; its usable terms are copied in (core → M07 validated, owner's words →
validated, Google suggestions and post variants → candidates). Long phrases and
questions stay out: a Componente B is what people write next to "sto cercando".
The words of the hidden-need module (source motore) stay out too.
================================================================================
"""

from __future__ import annotations

import json
import os
import time

import map_model

SEED_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed", "seed.json")

MARKET_STATUSES = ("active", "to_confirm", "candidate", "paused")
REGISTERS = ("natural", "technical")
KW_TYPES = ("technology", "activity_problem", "desired_outcome")
KW_STATUSES = ("candidate", "validating", "validated", "paused", "rejected")
KW_ORIGINS = ("seed", "trends_related", "trends_breakout", "ads_ideas", "fb_result", "li_result", "manual", "map_terms")
VARIANT_KINDS = ("synonym", "plural", "translation", "colloquial", "related")
INTENT_GROUPS = ("A1", "A2", "A3", "A4", "A5")
QUESTION_WORDS = ("come", "quanto", "quanti", "quale", "quali", "cosa", "che cosa", "perché", "perche", "dove", "chi")
MAX_B_WORDS = 4

SCHEMA = """
CREATE TABLE IF NOT EXISTS market (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT,
    status           TEXT NOT NULL CHECK (status IN ('active','to_confirm','candidate','paused')),
    activation_order INTEGER,
    activated_at     TEXT,
    origin           TEXT NOT NULL,              -- 'seed' | 'discovered'
    origin_reason    TEXT,
    created_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keyword (
    id                INTEGER PRIMARY KEY,
    text              TEXT NOT NULL,             -- the exact form, as people write it
    norm              TEXT NOT NULL,             -- lowercase, single spaces: the dedup key
    lang              TEXT NOT NULL DEFAULT 'it',
    register          TEXT NOT NULL CHECK (register IN ('natural','technical')),
    kw_type           TEXT NOT NULL CHECK (kw_type IN ('technology','activity_problem','desired_outcome')),
    validation_status TEXT NOT NULL CHECK (validation_status IN ('candidate','validating','validated','paused','rejected')),
    origin            TEXT NOT NULL,
    origin_ref        TEXT,
    origin_reason     TEXT NOT NULL,
    first_seen_at     TEXT NOT NULL,
    last_checked_at   TEXT,
    rotation_priority REAL NOT NULL DEFAULT 0,
    fb_usable         INTEGER NOT NULL DEFAULT 0, -- a technical keyword explicitly allowed on Facebook (§9.1)
    selected          INTEGER NOT NULL DEFAULT 0, -- chosen by the owner in the quiz (question 2)
    intent            TEXT NOT NULL DEFAULT '',
    intent_verified   INTEGER NOT NULL DEFAULT 0,
    seed_term_id      INTEGER,                   -- the seed bank term it was copied from
    UNIQUE (norm, lang)
);
CREATE TABLE IF NOT EXISTS keyword_market (
    keyword_id INTEGER NOT NULL REFERENCES keyword(id),
    market_id  TEXT NOT NULL REFERENCES market(id),
    PRIMARY KEY (keyword_id, market_id)
);
CREATE TABLE IF NOT EXISTS keyword_variant (
    id           INTEGER PRIMARY KEY,
    keyword_id   INTEGER NOT NULL REFERENCES keyword(id),
    text         TEXT NOT NULL,
    variant_kind TEXT NOT NULL CHECK (variant_kind IN ('synonym','plural','translation','colloquial','related')),
    UNIQUE (keyword_id, text)
);
CREATE TABLE IF NOT EXISTS intent_expression (
    id           INTEGER PRIMARY KEY,
    intent_group TEXT NOT NULL CHECK (intent_group IN ('A1','A2','A3','A4','A5')),
    text         TEXT NOT NULL UNIQUE,
    strength     INTEGER NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'seed',
    active       INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fb_group (
    id                    INTEGER PRIMARY KEY,
    name                  TEXT NOT NULL UNIQUE,
    url                   TEXT,
    lang                  TEXT,
    audience              TEXT,
    quality               INTEGER,
    verified_active       INTEGER,               -- NULL = not verified
    last_verified_at      TEXT,
    classification_reason TEXT
);
CREATE TABLE IF NOT EXISTS fb_group_market (
    group_id  INTEGER NOT NULL REFERENCES fb_group(id),
    market_id TEXT NOT NULL REFERENCES market(id),
    PRIMARY KEY (group_id, market_id)
);
CREATE TABLE IF NOT EXISTS role (
    id                     INTEGER PRIMARY KEY,
    title                  TEXT NOT NULL UNIQUE,
    origin                 TEXT NOT NULL CHECK (origin IN ('seed','dna_similarity','feedback','manual')),
    interest_in_automation INTEGER,
    function TEXT, seniority TEXT, decision_making TEXT, responsibility TEXT, orientation TEXT,
    activities             TEXT,                 -- JSON [{verb, object, context, purpose}]
    work_patterns          TEXT,                 -- JSON list
    dna                    TEXT,                 -- JSON list of 10 values 0..1
    cluster                TEXT CHECK (cluster IN ('A','B','C','D','E','F')),
    similarity_to_seed     REAL,
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','candidate','paused')),
    agent_key              TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    action    TEXT NOT NULL,
    entity    TEXT NOT NULL,
    entity_id TEXT,
    details   TEXT
);
CREATE TABLE IF NOT EXISTS markets_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

ACTIVITY_WORDS = ("gestione", "gestire", "automazione", "automatizzare", "eliminare", "inserimento", "follow-up",
                  "analisi", "preventiv", "prenotazion", "fatturazione", "assistenza", "manutenzione", "documentale")
OUTCOME_WORDS = ("ridurre", "efficienza", "ottimizzazione", "risparmiare", "evitare", "aumentare", "migliorare")


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def normalize(text: str) -> str:
    return " ".join(str(text).lower().split())


def tidy(text: str) -> str:
    return " ".join(str(text).split())


def usable_as_b(text: str, written_by_owner: bool = False) -> bool:
    """A Componente B is a short keyword people write, not a question or a long phrase (the owner's own words may be longer)."""
    n = normalize(text)
    if not n or (len(n.split()) > MAX_B_WORDS and not written_by_owner):
        return False
    words = n.split()
    if any(a == b for a, b in zip(words, words[1:])):   # "software software …": a broken suggestion, not a word people write
        return False
    return not any(n == q or n.startswith(q + " ") for q in QUESTION_WORDS)


def guess_type(text: str) -> str:
    n = normalize(text)
    if any(w in n for w in OUTCOME_WORDS):
        return "desired_outcome"
    if any(w in n for w in ACTIVITY_WORDS):
        return "activity_problem"
    return "technology"


class MarketTable:
    def __init__(self, db):
        self.db = db
        self.db.executescript(SCHEMA)
        self.db.commit()
        map_model.ensure_schema(db)   # the Mappa's tables and columns (strato 02)

    # ---- audit ------------------------------------------------------------------------------

    def audit(self, actor: str, action: str, entity: str, entity_id, details: dict | None = None) -> None:
        self.db.execute("INSERT INTO audit_log (at, actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
                        (_now(), actor, action, entity, str(entity_id), json.dumps(details or {}, ensure_ascii=False)))

    # ---- writing ----------------------------------------------------------------------------

    def add_keyword(self, text: str, register: str, kw_type: str, status: str, origin: str, reason: str,
                    markets: list[str] = (), origin_ref: str = "", seed_term_id: int | None = None,
                    actor: str = "system") -> int | None:
        """Adds a keyword (or links an existing one to more markets). Returns its id; None for an empty text."""
        if register not in REGISTERS or kw_type not in KW_TYPES or status not in KW_STATUSES or origin not in KW_ORIGINS:
            raise ValueError("registro, tipo, stato o origine non validi")
        if not str(reason).strip():
            raise ValueError("serve il motivo dell'inserimento")
        key = normalize(text)
        if not key:
            return None
        for m in markets:
            if not self.db.execute("SELECT 1 FROM market WHERE id = ?", (m,)).fetchone():
                raise ValueError(f"mercato {m} inesistente")
        row = self.db.execute("SELECT id FROM keyword WHERE norm = ? AND lang = 'it'", (key,)).fetchone()
        if row:
            kid = row[0]
            if seed_term_id:
                self.db.execute("UPDATE keyword SET seed_term_id = COALESCE(seed_term_id, ?) WHERE id = ?", (seed_term_id, kid))
        else:
            # OR IGNORE: two connections starting together may add the same keyword; the second one just links it
            cur = self.db.execute(
                "INSERT OR IGNORE INTO keyword (text, norm, register, kw_type, validation_status, origin, origin_ref, origin_reason,"
                " first_seen_at, seed_term_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tidy(text), key, register, kw_type, status, origin, origin_ref, reason, _now(), seed_term_id,
                 map_model.ORIGIN_PROVENANCE[origin]))
            kid = self.db.execute("SELECT id FROM keyword WHERE norm = ? AND lang = 'it'", (key,)).fetchone()[0]
            if cur.rowcount:
                self.audit(actor, "add", "keyword", kid, {"text": tidy(text), "origin": origin, "reason": reason})
        for m in markets:
            self.db.execute("INSERT OR IGNORE INTO keyword_market VALUES (?, ?)", (kid, m))
            map_model.link_keyword_market(self.db, kid, m)
        self.db.commit()
        return kid

    def add_variant(self, keyword_id: int, text: str, kind: str) -> None:
        if kind not in VARIANT_KINDS:
            raise ValueError(f"tipo di variante non valido: {kind}")
        self.db.execute("INSERT OR IGNORE INTO keyword_variant (keyword_id, text, variant_kind) VALUES (?, ?, ?)",
                        (keyword_id, tidy(text), kind))
        v = self.db.execute("SELECT v.id, v.variant_kind, k.origin, k.origin_ref FROM keyword_variant v JOIN keyword k"
                            " ON k.id = v.keyword_id WHERE v.keyword_id = ? AND v.text = ?", (keyword_id, tidy(text))).fetchone()
        map_model.link_variant(self.db, v["id"], keyword_id, v["variant_kind"], v["origin"], v["origin_ref"] or "")
        self.db.commit()

    def set_keyword_status(self, keyword_id: int, status: str, reason: str, actor: str = "operatore") -> dict:
        """Human transitions only here (validate, pause, resume, reject); the automatic ones arrive with §8.4."""
        if status not in KW_STATUSES:
            raise ValueError(f"stato non valido: {status}")
        k = self.keyword(keyword_id)
        if k["validation_status"] != status:
            self.db.execute("UPDATE keyword SET validation_status = ? WHERE id = ?", (status, keyword_id))
            self.audit(actor, "status", "keyword", keyword_id, {"from": k["validation_status"], "to": status, "reason": reason})
            self.db.commit()
        return self.keyword(keyword_id)

    def move_keyword(self, keyword_id: int, from_market: str, to_market: str, actor: str = "operatore") -> dict:
        self.keyword(keyword_id)
        if not self.db.execute("SELECT 1 FROM market WHERE id = ?", (to_market,)).fetchone():
            raise ValueError(f"mercato {to_market} inesistente")
        self.db.execute("DELETE FROM keyword_market WHERE keyword_id = ? AND market_id = ?", (keyword_id, from_market))
        self.db.execute("INSERT OR IGNORE INTO keyword_market VALUES (?, ?)", (keyword_id, to_market))
        map_model.unlink_keyword_market(self.db, keyword_id, from_market)
        map_model.link_keyword_market(self.db, keyword_id, to_market)
        self.audit(actor, "move", "keyword", keyword_id, {"from": from_market, "to": to_market})
        self.db.commit()
        return self.keyword(keyword_id)

    def select_only(self, keyword_ids: list[int]) -> None:
        self.db.execute("UPDATE keyword SET selected = 0")
        for kid in keyword_ids:
            self.db.execute("UPDATE keyword SET selected = 1 WHERE id = ?", (kid,))
        self.db.commit()

    def set_selected(self, keyword_ids: list[int]) -> None:
        for kid in keyword_ids:
            self.db.execute("UPDATE keyword SET selected = 1 WHERE id = ?", (kid,))
        self.db.commit()

    def set_intent(self, keyword_id: int, intent: str, verified: bool) -> None:
        self.db.execute("UPDATE keyword SET intent = ?, intent_verified = ? WHERE id = ?", (intent, int(verified), keyword_id))
        self.db.commit()

    def set_market(self, market_id: str, actor: str = "operatore", status: str | None = None,
                   activation_order: int | None = None) -> dict:
        m = self.market(market_id)
        if status is not None:
            if status not in MARKET_STATUSES:
                raise ValueError(f"stato non valido: {status}")
            activated = _now() if status == "active" and m["status"] != "active" else m["activated_at"]
            self.db.execute("UPDATE market SET status = ?, activated_at = ? WHERE id = ?", (status, activated, market_id))
            self.audit(actor, "status", "market", market_id, {"from": m["status"], "to": status})
        if activation_order is not None:
            self.db.execute("UPDATE market SET activation_order = ? WHERE id = ?", (activation_order, market_id))
            self.audit(actor, "order", "market", market_id, {"from": m["activation_order"], "to": activation_order})
        self.db.commit()
        return self.market(market_id)

    # ---- reading ----------------------------------------------------------------------------

    def market(self, market_id: str) -> dict:
        row = self.db.execute("SELECT * FROM market WHERE id = ?", (market_id,)).fetchone()
        if not row:
            raise KeyError(market_id)
        return dict(row)

    def markets(self) -> list[dict]:
        out = []
        for m in self.db.execute("SELECT * FROM market ORDER BY id"):
            m = dict(m)
            kws = self.keywords(market=m["id"])
            m["natural"] = [k["text"] for k in kws if k["register"] == "natural" and k["validation_status"] != "paused"]
            m["technical"] = [k["text"] for k in kws if k["register"] == "technical" and k["validation_status"] != "paused"]
            m["keywords"] = len(kws)
            m["candidates"] = sum(1 for k in kws if k["validation_status"] == "candidate")
            out.append(m)
        return out

    def _full(self, k: dict) -> dict:
        k["markets"] = [r[0] for r in self.db.execute("SELECT market_id FROM keyword_market WHERE keyword_id = ? ORDER BY market_id", (k["id"],))]
        k["variants"] = [dict(r) for r in self.db.execute("SELECT text, variant_kind FROM keyword_variant WHERE keyword_id = ? ORDER BY id", (k["id"],))]
        return k

    def keyword(self, keyword_id: int) -> dict:
        row = self.db.execute("SELECT * FROM keyword WHERE id = ?", (keyword_id,)).fetchone()
        if not row:
            raise KeyError(keyword_id)
        return self._full(dict(row))

    def find(self, text: str) -> dict | None:
        row = self.db.execute("SELECT * FROM keyword WHERE norm = ? AND lang = 'it'", (normalize(text),)).fetchone()
        return self._full(dict(row)) if row else None

    def keywords(self, market: str | None = None, register: str | None = None, statuses=None,
                 selected_only: bool = False) -> list[dict]:
        where, params = ["1 = 1"], []
        if market:
            where.append("id IN (SELECT keyword_id FROM keyword_market WHERE market_id = ?)")
            params.append(market)
        if register:
            where.append("register = ?")
            params.append(register)
        if statuses:
            where.append(f"validation_status IN ({','.join('?' * len(statuses))})")
            params += list(statuses)
        if selected_only:
            where.append("selected = 1")
        rows = self.db.execute(f"SELECT * FROM keyword WHERE {' AND '.join(where)} ORDER BY id", params)
        return [self._full(dict(r)) for r in rows]

    def expressions(self, active_only: bool = True) -> list[dict]:
        q = "SELECT * FROM intent_expression" + (" WHERE active = 1" if active_only else "") + " ORDER BY id"
        return [dict(r) for r in self.db.execute(q)]

    def groups(self) -> list[dict]:
        out = []
        for g in self.db.execute("SELECT * FROM fb_group ORDER BY id"):
            g = dict(g)
            g["markets"] = [r[0] for r in self.db.execute("SELECT market_id FROM fb_group_market WHERE group_id = ? ORDER BY market_id", (g["id"],))]
            out.append(g)
        return out

    def roles(self, statuses=("active",)) -> list[dict]:
        q = f"SELECT * FROM role WHERE status IN ({','.join('?' * len(statuses))}) ORDER BY id"
        return [dict(r) for r in self.db.execute(q, list(statuses))]

    def audit_trail(self, entity: str | None = None, entity_id=None, limit: int = 100) -> list[dict]:
        where, params = ["1 = 1"], []
        if entity:
            where.append("entity = ?")
            params.append(entity)
        if entity_id is not None:
            where.append("entity_id = ?")
            params.append(str(entity_id))
        rows = self.db.execute(f"SELECT * FROM audit_log WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?", params + [limit])
        return [{**dict(r), "details": json.loads(r["details"] or "{}")} for r in rows]

    def counts(self) -> dict:
        one = lambda q: self.db.execute(q).fetchone()[0]  # noqa: E731
        return {"markets": dict(self.db.execute("SELECT status, COUNT(*) FROM market GROUP BY status").fetchall()),
                "keywords": dict(self.db.execute("SELECT validation_status, COUNT(*) FROM keyword GROUP BY validation_status").fetchall()),
                "expressions": one("SELECT COUNT(*) FROM intent_expression"),
                "roles": one("SELECT COUNT(*) FROM role"), "groups": one("SELECT COUNT(*) FROM fb_group")}

    # ---- the seed and the copy from the seed bank ----------------------------------------------

    def load_seed(self, path: str = SEED_PATH) -> None:
        """§13.7, idempotent: what is already there is left as it is (the base is enriched, never replaced)."""
        with open(path, encoding="utf-8") as f:
            seed = json.load(f)
        now = _now()
        for m in seed["markets"]:
            self.db.execute("INSERT OR IGNORE INTO market (id, name, description, status, activation_order, activated_at,"
                            " origin, origin_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, 'seed', 'tabella iniziale (§13.1)', ?)",
                            (m["id"], m["name"], m.get("description"), m["status"], m.get("activation_order"),
                             now if m["status"] == "active" else None, now))
        activity = {normalize(k) for k in seed["activity_problem_keywords"]}
        for m in seed["markets"]:
            for register, key in (("natural", "natural"), ("technical", "technical")):
                for text in m[key]:
                    kw_type = "activity_problem" if normalize(text) in activity else "technology"
                    self.add_keyword(text, register, kw_type, "validated", "seed",
                                     f"seed {m['id']} · {'linguaggio reale' if register == 'natural' else 'termine tecnico'} (§13.1)",
                                     [m["id"]])
            for text in m.get("watch_examples", []):
                self.add_keyword(text, "technical", "technology", "candidate", "seed", f"esempio da monitorare in {m['id']} (§13.2)", [m["id"]])
        outcome = seed["desired_outcome_candidates"]
        for text in outcome["keywords"]:
            self.add_keyword(text, "natural", "desired_outcome", "candidate", "seed", "risultato desiderato, trasversale (§13.1)",
                             outcome["markets"])
        for group, g in seed["intent_expressions"].items():
            for text in g["items"]:
                self.db.execute("INSERT OR IGNORE INTO intent_expression (intent_group, text, strength, origin) VALUES (?, ?, ?, 'seed')",
                                (group, text, g["strength"]))
        for group, items in seed["intent_expression_variants"].items():
            for text in items:
                self.db.execute("INSERT OR IGNORE INTO intent_expression (intent_group, text, strength, origin) VALUES (?, ?, ?, 'seed_variant')",
                                (group, text, seed["intent_expressions"][group]["strength"]))
        for g in seed["fb_groups"]:
            for name in g["names"]:
                self.db.execute("INSERT OR IGNORE INTO fb_group (name, classification_reason) VALUES (?, 'dal nome del gruppo, non verificato')", (name,))
                gid = self.db.execute("SELECT id FROM fb_group WHERE name = ?", (name,)).fetchone()[0]
                for m in g["markets"]:
                    self.db.execute("INSERT OR IGNORE INTO fb_group_market VALUES (?, ?)", (gid, m))
        for title in seed["linkedin_seed_roles"]:
            self.db.execute("INSERT OR IGNORE INTO role (title, origin, interest_in_automation) VALUES (?, 'seed', 1)", (title,))
        self.db.commit()

    def sync_from_bank(self) -> dict:
        """
        Copies the usable seed bank terms into the table (idempotent, the bank is not touched):
        core → seed, validated · manuale → manual, validated · trend → trends_related, candidate ·
        post → fb_result, candidate. All in the primary market (map_model.primary_market). Questions, long phrases and the
        words of the hidden-need module (motore only) stay out. A term the owner removed pauses its keyword.
        """
        from seeds import SeedBank
        bank = SeedBank(self.db)
        rules = (("core", "seed", "validated", "base di buyerml.it"), ("manuale", "manual", "validated", "scritta da te"),
                 ("trend", "trends_related", "candidate", "suggerita da Google"),
                 ("post", "fb_result", "candidate", "variante letta in un post"))
        added = paused = 0
        for t in bank.terms(active_only=False):
            sources = {s["source"]: s for s in t["sources"]}
            rule = next((r for r in rules if r[0] in sources), None)
            linked = self.db.execute("SELECT id, validation_status, norm FROM keyword WHERE seed_term_id = ?", (t["id"],)).fetchone()
            if linked and not t["active"] and linked["validation_status"] != "paused":
                self.set_keyword_status(linked["id"], "paused", "tolta da te nella base", actor="system")
                paused += 1
                continue
            if linked and t["active"] and linked["norm"] != t["term"] and usable_as_b(t["display"], True) \
                    and not self.db.execute("SELECT 1 FROM keyword WHERE norm = ?", (t["term"],)).fetchone():
                self.db.execute("UPDATE keyword SET text = ?, norm = ? WHERE id = ?", (t["display"], t["term"], linked["id"]))
                self.audit("operatore", "edit", "keyword", linked["id"], {"from": linked["norm"], "to": t["term"]})
                self.db.commit()
                continue
            if linked or not rule or not t["active"] or not usable_as_b(t["display"], rule[0] == "manuale"):
                continue
            _, origin, status, reason = rule
            detail = sources[rule[0]].get("detail") or ""
            if self.find(t["display"]) is None:
                added += 1
            self.add_keyword(t["display"], "natural", guess_type(t["display"]), status, origin,
                             reason + (f" ({detail})" if detail and rule[0] == "post" else ""),
                             [map_model.primary_market(self.db)], origin_ref=detail, seed_term_id=t["id"])
        return {"added": added, "paused": paused}

    def _bank_fingerprint(self) -> str:
        one = lambda q: self.db.execute(q).fetchone()  # noqa: E731
        return json.dumps([list(one("SELECT COUNT(*), SUM(active), MAX(updated_at) FROM seed_terms")),
                           list(one("SELECT COUNT(*) FROM seed_term_sources"))])

    def ensure_ready(self) -> None:
        """Once per database the seed (§13.7); the copy from the seed bank whenever the bank changed."""
        try:
            if not self.db.execute("SELECT 1 FROM markets_meta WHERE key = 'seeded'").fetchone():
                self.load_seed()
                self.db.execute("INSERT OR REPLACE INTO markets_meta VALUES ('seeded', ?)", (_now(),))
                self.db.commit()
            fp = self._bank_fingerprint()
            row = self.db.execute("SELECT value FROM markets_meta WHERE key = 'bank'").fetchone()
            if not row or row[0] != fp:
                self.sync_from_bank()
                self.db.execute("INSERT OR REPLACE INTO markets_meta VALUES ('bank', ?)", (fp,))
                self.db.commit()
        except Exception:
            self.db.rollback()   # never leave the write lock behind
            raise
