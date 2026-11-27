"""
================================================================================
BuyerML — shared store for the links between layers (SQLite, one local file)
================================================================================
    terms     the Terms Dataset: Layer 1 terms + terms found by Dorking
              (link 17: Dorking terms flow back into Layer 1 as new seeds)
    searches  every dork actually executed, with how many results it returned
    leads     the results of those dorks: posts/pages with a declared need
              (link 15: Layer 2 -> saved contacts)

File: buyerml.db next to this script (git-ignored), or BUYERML_DB.
Exports: leads to CSV, trends to JSON for the Layer 3 engine (link 16).
================================================================================
"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
import time
from urllib.parse import urlparse

DEFAULT_DB = os.environ.get(
    "BUYERML_DB", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "buyerml.db")  # repo root
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS terms (
    term          TEXT PRIMARY KEY,   -- lowercase, used for dedup
    display       TEXT NOT NULL,
    source        TEXT NOT NULL,      -- layer1:trend|keyword|question, dorking:object, dorking:review
    origin_trend  TEXT NOT NULL,
    intent        TEXT DEFAULT '',
    awareness     TEXT DEFAULT '',
    first_seen    TEXT NOT NULL,
    used_as_seed  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS searches (
    search_text     TEXT PRIMARY KEY,
    channel         TEXT,
    combination_id  TEXT,
    origin_trend    TEXT,
    executed_at     TEXT NOT NULL,
    results_count   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
    url           TEXT PRIMARY KEY,
    title         TEXT,
    snippet       TEXT,
    channel       TEXT,
    search_text   TEXT,
    origin_trend  TEXT,
    found_at      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'new'   -- new | qualified | contacted | false_positive
);
"""

# Google often ignores site: when exact phrases find little (Phase 1: 24 of 94
# results were on the requested site). Results are checked against this domain.
CHANNEL_DOMAINS = {
    "facebook_groups": "facebook.com",
    "linkedin_posts": "linkedin.com",
    "freelancer": "freelancer.com",
    "upwork": "upwork.com",
    "reddit": "reddit.com",
}


# The channels still searched (spec v1.0): a result on another known site is no longer kept.
# The domains above stay, to label the posts already saved.
SEARCHED_CHANNELS = ("facebook_groups", "linkedin_posts")


def channel_of(url: str) -> str | None:
    """The known channel whose site hosts this url (reddit.com -> reddit), or None."""
    host = urlparse(url).netloc.lower().split(":")[0]
    for channel, domain in CHANNEL_DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            return channel
    return None


def on_channel(url: str, channel: str) -> bool:
    """True if the result is on the channel's site; channels without a site (forums, Google) accept all."""
    domain = CHANNEL_DOMAINS.get(channel)
    if not domain:
        return True
    host = urlparse(url).netloc.lower().split(":")[0]
    return host == domain or host.endswith("." + domain)


# Terms that go back into Layer 1 automatically. "dorking:review" (autocomplete
# suggestions with no known intent) stay for a human to look at.
FEEDBACK_SOURCES = ("dorking:object",)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class Store:
    def __init__(self, path: str = DEFAULT_DB):
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        columns = {r[1] for r in self.db.execute("PRAGMA table_info(searches)")}
        if "off_channel_count" not in columns:
            try:
                self.db.execute("ALTER TABLE searches ADD COLUMN off_channel_count INTEGER DEFAULT 0")
            except sqlite3.OperationalError as e:   # another connection added it a moment ago
                if "duplicate column" not in str(e):
                    raise
        columns = {r[1] for r in self.db.execute("PRAGMA table_info(leads)")}
        if "on_channel" not in columns:
            try:
                self.db.execute("ALTER TABLE leads ADD COLUMN on_channel INTEGER")
            except sqlite3.OperationalError as e:   # another connection added it a moment ago
                if "duplicate column" not in str(e):
                    raise
        # leads saved before the check: a result on another known channel gets its
        # real channel; one on any other site is marked off-channel (on_channel = 0)
        for row in self.db.execute(
            "SELECT url, channel FROM leads WHERE on_channel IS NULL OR on_channel = 0"
        ).fetchall():
            if on_channel(row["url"], row["channel"] or ""):
                self.db.execute("UPDATE leads SET on_channel = 1 WHERE url = ?", (row["url"],))
            elif real := channel_of(row["url"]):
                self.db.execute("UPDATE leads SET channel = ?, on_channel = 1 WHERE url = ?", (real, row["url"]))
            else:
                self.db.execute("UPDATE leads SET on_channel = 0 WHERE url = ?", (row["url"],))
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ---- terms -----------------------------------------------------------

    def add_term(self, term: str, source: str, origin_trend: str,
                 intent: str = "", awareness: str = "") -> bool:
        """Adds a term once (first source wins). True if it was new."""
        cur = self.db.execute(
            "INSERT OR IGNORE INTO terms (term, display, source, origin_trend, intent, awareness, first_seen)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (term.lower().strip(), term.strip(), source, origin_trend, intent, awareness, _now()),
        )
        self.db.commit()
        return cur.rowcount == 1

    def save_run(self, run) -> dict:
        """Saves an AutocompleteDorkingScraper run: Layer 1 terms + terms found by Dorking."""
        counts = {"layer1": 0, "dorking": 0, "review": 0}
        for t in run.trend_terms:
            counts["layer1"] += self.add_term(t.query, f"layer1:{t.source}", run.trend, t.intent, t.awareness)
        for obj in run.objects:
            counts["dorking"] += self.add_term(obj, "dorking:object", run.trend)
        for suggestion in run.unmatched:
            counts["review"] += self.add_term(suggestion, "dorking:review", run.trend)
        # the trend itself has now been through Layer 1
        self.mark_used(run.trend)
        return counts

    def next_feedback_terms(self, limit: int = 1) -> list[str]:
        """Terms found by Dorking that have not yet been run through Layer 1."""
        placeholders = ",".join("?" for _ in FEEDBACK_SOURCES)
        rows = self.db.execute(
            f"SELECT display FROM terms WHERE used_as_seed = 0 AND source IN ({placeholders})"
            " ORDER BY first_seen, rowid LIMIT ?",
            (*FEEDBACK_SOURCES, limit),
        ).fetchall()
        return [r["display"] for r in rows]

    def mark_used(self, term: str) -> None:
        self.db.execute("UPDATE terms SET used_as_seed = 1 WHERE term = ?", (term.lower().strip(),))
        self.db.commit()

    # ---- searches and leads ---------------------------------------------------

    def was_executed(self, search_text: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM searches WHERE search_text = ?", (search_text,)
        ).fetchone() is not None

    def save_search(self, command: dict, results: list[dict], off_channel: int = 0) -> int:
        """
        Records an executed dork and its results as leads (only results on the
        channel's site; off_channel counts the ones dropped). Returns new leads.
        """
        self.db.execute(
            "INSERT OR REPLACE INTO searches (search_text, channel, combination_id, origin_trend, executed_at,"
            " results_count, off_channel_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (command["search_text"], command.get("channel", ""), command.get("combination_id", ""),
             command.get("origin_trend", ""), _now(), len(results), off_channel),
        )
        new = 0
        for r in results:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO leads (url, title, snippet, channel, search_text, origin_trend, found_at,"
                " on_channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (r["url"], r.get("title", ""), r.get("snippet", ""), r.get("channel") or command.get("channel", ""),
                 command["search_text"], command.get("origin_trend", ""), _now(),
                 int(on_channel(r["url"], r.get("channel") or command.get("channel", "")))),
            )
            new += cur.rowcount
        self.db.commit()
        return new

    def leads(self, status: str | None = None) -> list[dict]:
        query, params = "SELECT * FROM leads", ()
        if status:
            query, params = query + " WHERE status = ?", (status,)
        return [dict(r) for r in self.db.execute(query + " ORDER BY found_at", params)]

    # ---- exports -----------------------------------------------------------

    def export_leads_csv(self, path: str) -> int:
        rows = self.leads()
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["url", "title", "snippet", "channel", "on_channel", "search_text",
                                                   "origin_trend", "found_at", "status"], extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        return len(rows)

    def trends_for_layer3(self) -> list[dict]:
        """
        Link 16: each trend with its buying-intent Layer 1 terms, for the
        Layer 3 engine. Only transactional / navigational / commercial terms.
        """
        rows = self.db.execute(
            "SELECT origin_trend, display, intent, awareness FROM terms"
            " WHERE source LIKE 'layer1:%'"
            " AND intent IN ('transactional', 'navigational', 'commercial_investigation')"
            " ORDER BY origin_trend, first_seen, rowid"
        ).fetchall()
        trends: dict[str, dict] = {}
        for r in rows:
            entry = trends.setdefault(r["origin_trend"], {"trend": r["origin_trend"], "terms": []})
            entry["terms"].append({"term": r["display"], "intent": r["intent"], "awareness": r["awareness"]})
        return list(trends.values())

    def export_trends_json(self, path: str) -> int:
        trends = self.trends_for_layer3()
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"source": "BuyerML Layer 1", "exported_at": _now(), "trends": trends},
                      f, ensure_ascii=False, indent=2)
        return len(trends)
