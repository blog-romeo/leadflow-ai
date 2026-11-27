"""Server-side configuration. Every value comes from the environment; nothing secret is ever returned by the API."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


@dataclass(frozen=True)
class Settings:
    secret: str
    data_dir: str
    simulated: bool
    serpapi_configured: bool
    max_budget_per_hunt: int
    max_concurrent_per_org: int
    signature_window_s: int

    @property
    def mode(self) -> str:
        return "simulated" if self.simulated else "live"


def load() -> Settings:
    simulated = os.environ.get("DH_SIMULATED", "true").strip().lower() != "false"
    serp = os.environ.get("SERPAPI_KEY", "").strip()
    return Settings(
        secret=os.environ.get("DEMAND_HUNTER_SERVICE_SECRET", "").strip(),
        data_dir=os.environ.get("DH_DATA_DIR", "/data"),
        simulated=simulated,
        serpapi_configured=bool(serp) and serp != "YOUR_SERPAPI_KEY",
        max_budget_per_hunt=_int("DH_MAX_BUDGET_PER_HUNT", 100, 1, 500),   # 500 = HUNT_MAX_BUDGET of BuyerML api.py
        max_concurrent_per_org=_int("DH_MAX_CONCURRENT_PER_ORG", 1, 1, 5),
        signature_window_s=_int("DH_SIGNATURE_WINDOW_S", 300, 30, 900),
    )
