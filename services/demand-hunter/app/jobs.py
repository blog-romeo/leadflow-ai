"""Persistent jobs of the service.

A hunt runs in a background thread with its own SQLite connection (as in BuyerML api.py). Its state is
written to service.db after every paid call, so the gateway can read the final state even after a restart.
A job that was running when the process stopped is marked "interrotta" on the next start: what it found
stays, it is never resumed silently (resuming would spend again without a new confirmation).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    org             TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL,
    params          TEXT NOT NULL,
    snapshot        TEXT,
    error           TEXT,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL,
    UNIQUE (org, idempotency_key)
);
"""
TERMINAL = ("finita", "fermata", "errore", "interrotta")


class JobStore:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(SCHEMA)
            c.execute("UPDATE jobs SET status = 'interrotta', error = 'service_restarted', updated_at = ?"
                      " WHERE status IN ('in coda', 'in corso')", (time.time(),))

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    def create(self, org: str, user: str, key: str, kind: str, params: dict) -> tuple[dict, bool]:
        """(job, created). The same idempotency key for the same org returns the existing job: no second spend."""
        with self._lock, self._conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE org = ? AND idempotency_key = ?", (org, key)).fetchone()
            if row:
                return self._row(row), False
            now = time.time()
            job_id = uuid.uuid4().hex
            c.execute("INSERT INTO jobs (id, org, user_id, idempotency_key, kind, status, params, created_at, updated_at)"
                      " VALUES (?, ?, ?, ?, ?, 'in coda', ?, ?, ?)", (job_id, org, user, key, kind, json.dumps(params), now, now))
            return self._row(c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()), True

    def update(self, job_id: str, status: str | None = None, snapshot: dict | None = None, error: str | None = None) -> None:
        with self._lock, self._conn() as c:
            sets, args = ["updated_at = ?"], [time.time()]
            if status is not None:
                sets.append("status = ?"); args.append(status)
            if snapshot is not None:
                sets.append("snapshot = ?"); args.append(json.dumps(snapshot, ensure_ascii=False))
            if error is not None:
                sets.append("error = ?"); args.append(error[:300])
            c.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", (*args, job_id))

    def find(self, org: str, key: str) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE org = ? AND idempotency_key = ?", (org, key)).fetchone()
            return self._row(row) if row else None

    def get(self, org: str, job_id: str) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE id = ? AND org = ?", (job_id, org)).fetchone()
            return self._row(row) if row else None

    def running(self, org: str) -> int:
        with self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM jobs WHERE org = ? AND status IN ('in coda', 'in corso')", (org,)).fetchone()[0]

    @staticmethod
    def _row(r: sqlite3.Row) -> dict:
        d = dict(r)
        d["params"] = json.loads(d["params"])
        d["snapshot"] = json.loads(d["snapshot"]) if d["snapshot"] else None
        return d
