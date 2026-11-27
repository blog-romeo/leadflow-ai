"""
================================================================================
BuyerML — Le aree di mercato: what to hunt, explored as a tree that keeps growing
================================================================================
The Caccia page starts from a goal (clienti | lavoro), not from a word. Each goal has a tree of market
areas (seed/market_areas.json: the starting vocabulary, NOT a closed list). Every node can be:

  - opened      its children: from the starting vocabulary, plus the terms discovered before;
  - expanded    Google's autocomplete around it (SerpApi: paid, one call per phrase, confirmed first).
                The new terms are saved in buyerml.db (table concepts) under that node, with the kind of
                link (variante: contains the node's words; correlato: does not), and can be expanded again;
  - hunted      it becomes the seed of a hunt (hunt.py) with that goal.

Free: the tree, the discovered terms, the counts of the hunts already done on each node.
================================================================================
"""

from __future__ import annotations

import json
import os
import re
import time

import demand
from autocomplete_dorking import split_intent

AREAS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed", "market_areas.json")
MAX_NEW = 12            # terms kept per expansion
SCHEMA = """
CREATE TABLE IF NOT EXISTS concepts (
    goal        TEXT NOT NULL,
    label       TEXT NOT NULL,
    norm        TEXT NOT NULL,
    parent      TEXT NOT NULL,      -- the parent's normalised label
    rel         TEXT NOT NULL,      -- variante | correlato
    source      TEXT NOT NULL,      -- autocomplete
    found_at    TEXT NOT NULL,
    PRIMARY KEY (goal, norm)
);
"""
# words that turn a suggestion into something nobody buys or offers: studying, definitions, news, prices of courses
NOISE = re.compile(
    r"\b(corso|corsi|cos'?è|cosa (è|significa)|significato|definizione|wikipedia|pdf|libro|libri|esempi|esempio|"
    r"tesi|universit[àa]|laurea|master|quiz|news|notizie|film|meme|gratis download|youtube|reddit|tutorial|"
    r"what is|meaning|course|courses|salary|stipendio)\b", re.IGNORECASE)
NOT_FOR = {"clienti": re.compile(r"\b(lavoro|offerte di lavoro|stipendio|concorso|jobs?|careers?)\b", re.IGNORECASE),
           "lavoro": re.compile(r"\b(prezzo|prezzi|costo|preventivo|vendita|usato)\b", re.IGNORECASE)}
# the phrases asked to Google for one node: the node alone (what people type around it) and with the goal's verb
PHRASES = {"clienti": ("{}", "cerco {}"), "lavoro": ("cercasi {}", "offerta lavoro {}")}
VERB_INSIDE = re.compile(r"\b(cerco|cerchiamo|cercasi|cercando|offerta lavoro|offerte lavoro)\b", re.IGNORECASE)
VERBS = ("cerco", "cerchiamo", "sto cercando", "stiamo cercando", "cercasi", "offerta lavoro", "offerte lavoro", "lavoro")


def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^\w#+./ -]", " ", s.lower()).split())


def load(path: str = AREAS_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def ensure_schema(store) -> None:
    store.db.executescript(SCHEMA)
    store.db.commit()


def discovered(store, goal: str) -> list[dict]:
    ensure_schema(store)
    return [dict(r) for r in store.db.execute(
        "SELECT label, norm, parent, rel, source, found_at FROM concepts WHERE goal = ? ORDER BY found_at, rowid", (goal,))]


def _hunt_stats(store, goal: str) -> dict[str, dict]:
    """norm(seed) -> {searches, leads} for the hunts already done with this goal. Free: rules only."""
    import hunt
    from label_demand import post_text
    origin = hunt.GOALS[goal]["origin"]
    classes = hunt.GOALS[goal]["classes"]
    out: dict[str, dict] = {}
    for r in store.db.execute("SELECT origin_trend, COUNT(*) n FROM searches WHERE origin_trend LIKE ? GROUP BY origin_trend",
                              (origin + ":%",)):
        out[_norm(r["origin_trend"].split(":", 1)[1])] = {"searches": r["n"], "leads": 0}
    seen: set[str] = set()
    for r in store.db.execute("SELECT title, snippet, origin_trend FROM leads WHERE origin_trend LIKE ? AND on_channel = 1"
                              " ORDER BY found_at DESC LIMIT 2000", (origin + ":%",)):
        text = post_text({"title": r["title"] or "", "snippet": r["snippet"] or ""})
        key = _norm(r["origin_trend"].split(":", 1)[1])
        if not text or (key, _norm(text)) in seen or key not in out:
            continue
        seen.add((key, _norm(text)))
        if demand.read(text).lead_class in classes:
            out[key]["leads"] += 1
    return out


def tree(goal: str, store=None, areas: dict | None = None) -> dict:
    """The goal's tree, with the discovered terms under their parent and, per node, the hunts already done."""
    areas = areas or load()
    if goal not in areas["goals"]:
        raise ValueError(f"Obiettivo sconosciuto: {goal}")
    found = discovered(store, goal) if store is not None else []
    stats = _hunt_stats(store, goal) if store is not None else {}
    by_parent: dict[str, list[dict]] = {}
    for c in found:
        by_parent.setdefault(c["parent"], []).append(c)
    placed: set[str] = set()

    def node(label: str, rel: str, source: str, children: list[dict]) -> dict:
        key = _norm(label)
        placed.add(key)
        kids = [node(c["label"], c["rel"], "elenco", c.get("children", [])) for c in children]
        kids += [node(c["label"], c["rel"], c["source"], []) for c in by_parent.get(key, []) if c["norm"] not in placed]
        s = stats.get(key, {})
        return {"label": label, "rel": rel, "source": source, "children": kids,
                "hunted": s.get("searches", 0), "leads": s.get("leads", 0)}

    g = areas["goals"][goal]
    return node(g["label"], "obiettivo", "elenco", g["children"])


def find(root: dict, label: str) -> dict | None:
    if _norm(root["label"]) == _norm(label):
        return root
    for c in root["children"]:
        hit = find(c, label)
        if hit:
            return hit
    return None


def plan(goal: str, label: str) -> dict:
    if goal not in PHRASES:
        raise ValueError(f"Obiettivo sconosciuto: {goal}")
    label = " ".join(label.split())
    if not label:
        raise ValueError("Scegli un'area da esplorare.")
    phrases = [p.format(label) for p in PHRASES[goal]]
    return {"goal": goal, "label": label, "phrases": phrases, "calls": len(phrases),
            "cost": f"{len(phrases)} ricerche SerpApi (suggerimenti di Google per: {', '.join(phrases)})."}


def clean(goal: str, label: str, suggestions: list[str], known: set[str]) -> list[dict]:
    """The suggestions worth keeping as new terms: the verb removed, no noise, nothing already known."""
    out, seen = [], set(known)
    for s in suggestions:
        _, rest = split_intent(s, list(VERBS))
        rest = " ".join(rest.split()).strip(" ?!.")
        key = _norm(rest)
        if VERB_INSIDE.search(rest):          # "software cerco siem": Google echoing the phrase, not a term
            continue
        if len(key) < 3 or key in seen or NOISE.search(rest) or NOT_FOR[goal].search(rest) or len(rest.split()) > 6:
            continue
        seen.add(key)
        words = set(_norm(label).split())
        out.append({"label": rest, "rel": "variante" if words <= set(key.split()) else "correlato"})
        if len(out) >= MAX_NEW:
            break
    return out


def expand(goal: str, label: str, autocomplete, store, now=lambda: time.strftime("%Y-%m-%d %H:%M:%S")) -> dict:
    """Ask Google's autocomplete around a node (paid: one call per phrase) and save the new terms under it."""
    p = plan(goal, label)
    ensure_schema(store)
    root = tree(goal, store)
    known = set()

    def walk(n):
        known.add(_norm(n["label"]))
        for c in n["children"]:
            walk(c)
    walk(root)
    suggestions: list[str] = []
    for phrase in p["phrases"]:
        suggestions += autocomplete(phrase)
    new = clean(goal, p["label"], suggestions, known)
    for c in new:
        store.db.execute("INSERT OR IGNORE INTO concepts (goal, label, norm, parent, rel, source, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (goal, c["label"], _norm(c["label"]), _norm(p["label"]), c["rel"], "autocomplete", now()))
    store.db.commit()
    return {"goal": goal, "label": p["label"], "calls": p["calls"], "suggestions": len(suggestions), "added": new}
