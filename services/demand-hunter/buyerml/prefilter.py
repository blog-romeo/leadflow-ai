"""
================================================================================
BuyerML — the free pre-filter before Claude reads the posts (spec §11: discard tutorials, news,
advertising, service offers and jobs)
================================================================================
Plain rules on the title and snippet catch the obvious noise, so Claude is not paid to read it.
The rules are built for precision: a post that asks for help is never discarded here (a doubt
goes to Claude). A request signal ("cerco", "qualcuno conosce", "consigli", a question mark …)
always wins over a noise rule. Measured on backend/fixtures/labelled_posts.json (≥ 30 posts
labelled by hand).
================================================================================
"""

from __future__ import annotations

import re

# who is asking: if any of these is there, the post goes to Claude whatever else it says
ASKING = re.compile(
    r"\b(cerco|cerchiamo|sto cercando|stiamo cercando|ci serve|mi serve|abbiamo bisogno|ho bisogno|qualcuno (conosce|usa|ha)|"
    r"consigli|consigliate|chi mi consiglia|esiste (un|una)|c'è un|come posso|come faccio|come fate|vi organizzate)\b|\?",
    re.IGNORECASE)

RULES: list[tuple[str, re.Pattern]] = [
    ("tutorial", re.compile(r"\b(guida( completa)?:|tutorial|video ?corso|webinar|passo passo|step by step|"
                            r"in \d+ minuti con|ecco come (creare|fare|usare))", re.IGNORECASE)),
    ("pubblicita", re.compile(r"\b(offerta lancio|in offerta|sconto|promo(zione)?|primo mese gratis|prova gratuita di|"
                              r"\d+\s?€ al mese|€\s?\d+ al mese|acquista ora|scopri il nostro|il nostro (gestionale|software|crm))", re.IGNORECASE)),
    ("offerta_servizi", re.compile(r"\b(offro|offriamo) (i miei|il mio|servizi|consulenz|sviluppo)|\bscrivimi in privato\b|"
                                   r"\bcontattami per\b|\b(sviluppatore|consulente|agenzia) freelance:|\brealizzo (siti|app|automazioni)", re.IGNORECASE)),
    ("lavoro", re.compile(r"\b(cercasi|assumiamo|si assume|offerta di lavoro|posizione aperta|inviare (il )?cv)\b.{0,40}"
                          r"\b(addett[oa]|impiegat[oa]|commess[oa]|stagista|tirocinante|part[- ]time|full[- ]time|cv|candidat)", re.IGNORECASE)),
    ("notizia", re.compile(r"\b(nuove regole|nuovo regolamento|cosa cambia per|è stato annunciato|annuncia|ha lanciato)\b", re.IGNORECASE)),
]


def prefilter(title: str, snippet: str = "") -> str | None:
    """The discard reason of an obvious noise post, or None (Claude reads it)."""
    text = f"{title or ''} {snippet or ''}"
    jobs = RULES[3][1].search(text)
    if ASKING.search(text) and not jobs:
        return None
    for reason, rule in RULES:
        if rule.search(text):
            return reason
    return None
