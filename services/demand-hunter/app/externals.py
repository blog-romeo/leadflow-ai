"""The two paid calls of a hunt (Google search and Google autocomplete, both through SerpApi).

live       the original BuyerML functions: dork_runner.search_google and the autocomplete of
           buyerml_seo_aeo_workflow (SerpApi). Only Google results are read: no Facebook or LinkedIn
           page is ever opened, no login, nothing is sent anywhere.
simulated  deterministic, offline, free. Every URL contains "esempio-simulato" and every response of the
           service says mode="simulated": simulated leads are never presented as real.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Callable


@dataclass
class Externals:
    search: Callable[[str], list[dict]]
    autocomplete: Callable[[str], list[str]]
    mode: str


class NotConfigured(Exception):
    pass


# Synthetic posts, written for the simulation (not real people). {o} is the object searched.
_SIM_POSTS = (
    "Stiamo cercando uno sviluppatore {o} per il nostro gestionale, budget 4000 euro, urgente",
    "Cerco un'agenzia che ci aiuti con {o} per la nostra azienda, chi mi consiglia?",
    "Sono uno sviluppatore {o} freelance, realizzo progetti su misura, contattatemi",
    "Cerchiamo un consulente {o} per integrare il CRM con il sito, entro fine mese",
    "Corso gratuito di {o} per principianti, iscrizioni aperte",
    "Qualcuno conosce un fornitore affidabile per {o}? Siamo una PMI di 20 persone",
)


def _h(s: str) -> int:
    return int(hashlib.sha256(s.encode()).hexdigest()[:8], 16)


def simulated() -> Externals:
    def search(query: str) -> list[dict]:
        obj = (re.findall(r'"([^"]+)"', query) or ["software"])[-1]
        h = _h(query)
        picks = [(h + i * 3) % len(_SIM_POSTS) for i in range(1 + h % 3)]
        slug = re.sub(r"[^a-z0-9]+", "-", obj.lower()).strip("-")[:30]
        out = [{"url": f"https://www.facebook.com/groups/esempio-simulato/posts/{p}-{slug}",
                "title": "", "snippet": _SIM_POSTS[p].format(o=obj)} for p in picks]
        out.append({"url": f"https://example.com/esempio-simulato/{h % 1000}", "title": "", "snippet": "risultato fuori canale"})
        return out

    def autocomplete(phrase: str) -> list[str]:
        p = " ".join(phrase.lower().split())
        return [f"{p} per pmi", f"{p} freelance", f"{p} corso"]

    return Externals(search, autocomplete, "simulated")


def live() -> Externals:
    import buyerml_seo_aeo_workflow as wf
    from dork_runner import search_google

    if wf.MOCK_MODE:
        raise NotConfigured("MOCK_MODE must be false for live searches")
    if not wf.SERPAPI_KEY or wf.SERPAPI_KEY == "YOUR_SERPAPI_KEY":
        raise NotConfigured("SERPAPI_KEY missing")

    def autocomplete(phrase: str) -> list[str]:
        return [s["query"] for s in wf.KeywordExpansion()._fetch_autocomplete(phrase)]

    return Externals(search_google, autocomplete, "live")


def make(simulated_mode: bool) -> Externals:
    return simulated() if simulated_mode else live()
