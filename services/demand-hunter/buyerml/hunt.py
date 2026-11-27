"""
================================================================================
BuyerML — La caccia: every combination, tried where it pays (the "Caccia" page)
================================================================================
Like a keyword sheeter, but for dorks and with the leads at the end. From one object ("Laravel"):

  1. Expand (free)    direct search verbs x the object, its role forms ("sviluppatore Laravel"),
                      the taxonomy's words for the same need, the sibling technologies.
  2. Try (paid)       the best untried combination on Google (SerpApi, the same search as dork_runner.py),
                      site:facebook.com/groups "verb" "object".
  3. Read (free)      every Facebook result is read by demand.py: buyer or seller, stage, score.
  4. Learn            a verb or an object that brings leads rises; one that brings nothing after a few
                      tries is dropped. A combination that brought leads asks Google's autocomplete
                      for the phrasings people really type around it (paid: SerpApi too), which become
                      new objects.

Every SerpApi call (searches and autocomplete) counts against the budget; the hunt stops there.
Searches already executed before (any hunt, any page) are not paid again: they are skipped.
Results are saved as leads in buyerml.db (Store.save_search), like every other search.
================================================================================
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

import demand
import learning
from autocomplete_dorking import split_intent
from buyerml_store import on_channel
from dorking import facebook_query
from label_demand import post_text

VERBS = ("stiamo cercando", "sto cercando", "cerchiamo", "cerco", "cercasi")
# The two goals: the same hunt, different verbs and a different kind of lead (demand.Reading.lead_class).
GOALS = {
    "clienti": {"verbs": VERBS, "classes": ("cliente",), "origin": "caccia"},
    "lavoro": {"verbs": ("cercasi", "assumiamo", "stiamo cercando", "cerchiamo", "offerta di lavoro"),
               "classes": ("lavoro_it", "lavoro"), "origin": "caccia-lavoro"},
}
ROLE_FORMS = ("sviluppatore {}", "programmatore {}", "esperto {}")
ORIGIN_PRIOR = {"seed": 1.0, "ruolo": 0.9, "autocomplete": 0.8, "tassonomia": 0.6, "tecnologia vicina": 0.35}
AUTOCOMPLETE_SHARE = 0.2        # at most this share of the budget goes to autocomplete
DROP_OBJECT_AFTER = 3           # searches with no lead before an object is dropped
DROP_VERB_AFTER = 6
MAX_RELATED = 10
CHANNEL = "facebook_groups"


@dataclass
class Combo:
    verb: str
    obj: str
    origin: str
    parent: str = ""
    status: str = "da provare"        # da provare | provata | già fatta | abbandonata
    results: int = 0
    leads: int = 0
    priority: float = 0.0

    @property
    def query(self) -> str:
        return facebook_query(self.verb, self.obj)


@dataclass
class Stat:
    searches: int = 0
    results: int = 0
    leads: int = 0
    prior: float = 1.0
    dropped: bool = False

    def weight(self) -> float:
        # (leads + 1) / (searches + 2), x2 so that an untried one is 1.0: rises with leads, falls with empty tries
        return self.prior * 2 * (self.leads + 1) / (self.searches + 2)


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def _repeats(phrase: str) -> bool:
    """True when a word or a pair of words comes twice: an expansion of an expansion."""
    w = _norm(phrase).split()
    pairs = list(zip(w, w[1:]))
    return len(set(w)) < len(w) or len(set(pairs)) < len(pairs)


def related_objects(seed: str, tax: demand.Taxonomy | None = None) -> list[tuple[str, str]]:
    """(object, origin) for a seed: itself, its role forms when it is a technology or a field, the
    taxonomy's words for the same node, then the sibling technologies (lowest priority)."""
    tax = tax or demand.default_taxonomy()
    seed = " ".join(seed.split())
    out: list[tuple[str, str]] = [(seed, "seed")]
    m = demand.match_market(seed, tax)
    is_role = demand.PROVIDER.search(seed) is not None
    if not is_role and m["node"]:          # "sviluppatore cameriere" means nothing: role forms only for IT words
        out += [(f.format(seed), "ruolo") for f in ROLE_FORMS]
    node = tax.nodes.get(m["node"]) if m["node"] else None
    if node:
        aliases = [a for a in node["aliases"].get("it", []) if len(a) > 2]
        out += [(a, "tassonomia") for a in aliases[:4]]
        techs = [t for t in node.get("tech", []) if _norm(t) != _norm(seed)]
        out += [(t, "tecnologia vicina") for t in techs[:4]]
    seen, unique = set(), []
    for obj, origin in out:
        if _norm(obj) not in seen:
            seen.add(_norm(obj))
            unique.append((obj, origin))
    return unique[:1 + len(ROLE_FORMS) + MAX_RELATED]


class Hunt:
    def __init__(self, seed: str, budget: int, search, autocomplete, store=None, verbs=None,
                 reader=demand.read, now=time.strftime, goal: str = "clienti"):
        if not seed.strip():
            raise ValueError("Scrivi l'oggetto da cercare, per esempio Laravel.")
        if goal not in GOALS:
            raise ValueError(f"Obiettivo sconosciuto: {goal}")
        self.goal = goal
        verbs = verbs or GOALS[goal]["verbs"]
        self.seed = " ".join(seed.split())
        self.budget = int(budget)
        self._search, self._autocomplete, self.store, self.reader = search, autocomplete, store, reader
        # what earlier hunts taught (learning.py): a gentle factor per verb, object and pattern; none without a store
        self._priors = learning.priors(store, goal) if store is not None else {"verbs": {}, "objects": {}, "patterns": {}}
        self.run_id: int | None = None
        self.verbs = {v: Stat(prior=(1.0 - 0.05 * i) * self._priors["verbs"].get(v, 1.0)) for i, v in enumerate(verbs)}
        self.objects: dict[str, Stat] = {}
        self.combos: dict[str, Combo] = {}
        self.leads: dict[str, dict] = {}
        self.events: list[dict] = []
        self.spent = {"searches": 0, "autocomplete": 0}
        self.status = "pronta"
        self.stop_requested = False
        self._expand_queue: list[Combo] = []
        self._expanded: set[str] = set()
        self._seen_texts: set[str] = set()
        self._lock = threading.RLock()
        self._now = now
        for obj, origin in related_objects(self.seed):
            self._add_object(obj, origin)
        # the seed's own phrasing on Google is the first thing worth asking
        self._expand_queue.append(self.combos[_norm(facebook_query(verbs[0], self.seed))])

    # ---- the combinations ------------------------------------------------------------------------

    def _add_object(self, obj: str, origin: str, parent: str = "") -> int:
        key = _norm(obj)
        if key in self.objects:
            return 0
        learned = self._priors["objects"].get(obj) or (self._priors["patterns"].get(learning.pattern_of(obj)[1])
                                                        if self._priors["patterns"] else None) or 1.0
        self.objects[key] = Stat(prior=ORIGIN_PRIOR[origin] * learned)
        new = 0
        for verb in self.verbs:
            c = Combo(verb, obj, origin, parent)
            k = _norm(c.query)
            if k not in self.combos:
                if self.store is not None and self.store.was_executed(c.query):
                    c.status = "già fatta"
                self.combos[k] = c
                new += 1
        return new

    def _priority(self, c: Combo) -> float:
        return self.verbs[c.verb].weight() * self.objects[_norm(c.obj)].weight()

    def _next(self) -> Combo | None:
        best = None
        for c in self.combos.values():
            if c.status != "da provare":
                continue
            if self.verbs[c.verb].dropped or self.objects[_norm(c.obj)].dropped:
                c.status = "abbandonata"
                continue
            c.priority = round(self._priority(c), 3)
            if best is None or c.priority > best.priority:
                best = c
        return best

    def _log(self, kind: str, text: str, **extra) -> None:
        self.events.append({"at": self._now("%H:%M:%S"), "kind": kind, "text": text, **extra})
        del self.events[:-200]

    def _left(self) -> int:
        return self.budget - self.spent["searches"] - self.spent["autocomplete"]

    # ---- one step ---------------------------------------------------------------------------------

    def _autocomplete_allowed(self) -> bool:
        return self.spent["autocomplete"] < max(1, int(self.budget * AUTOCOMPLETE_SHARE))

    def _expand(self, c: Combo) -> None:
        phrase = f"{c.verb} {c.obj}"
        self._expanded.add(_norm(phrase))
        self.spent["autocomplete"] += 1
        suggestions = self._autocomplete(phrase)
        added = []
        for s in suggestions:
            verb, rest = split_intent(s, list(self.verbs))
            if verb is None:            # a suggestion that does not start with a search verb is another topic
                continue
            rest = re.sub(r"[?!.]+$", "", rest).strip()
            if _repeats(rest):
                continue                # "laravel per pmi per pmi": Google echoing itself, not a new phrasing
            if 1 <= len(rest.split()) <= 6 and _norm(rest) != _norm(phrase) and self._add_object(rest, "autocomplete", phrase):
                added.append(rest)
        self._log("espansione", f"Suggerimenti di Google per «{phrase}»: {len(added)} oggetti nuovi",
                  objects=added)

    def _try(self, c: Combo) -> None:
        self.spent["searches"] += 1
        results = self._search(c.query)
        kept = [r for r in results if on_channel(r["url"], CHANNEL)]
        found = []
        read_posts = []
        for r in kept:
            text = post_text(r)
            key = _norm(text)
            if not text or r["url"] in self.leads or key in self._seen_texts:   # the same post under another URL
                continue
            self._seen_texts.add(key)
            reading = self.reader(text)
            read_posts.append({"url": r["url"], "text": text, "reading": reading,
                               "is_lead": reading.lead_class in GOALS[self.goal]["classes"]})
            if reading.lead_class in GOALS[self.goal]["classes"]:
                self.leads[r["url"]] = {"url": r["url"], "text": text, "demand": reading.demand, "stage": reading.stage,
                                        "score": reading.lead_score, "intents": reading.intent_types,
                                        "node": reading.taxonomy_node, "technology": reading.technology, "lead_class": reading.lead_class,
                                        "query": c.query, "verb": c.verb, "object": c.obj, "found_at": self._now("%H:%M:%S")}
                found.append(r["url"])
        if self.store is not None:
            self.store.save_search({"search_text": c.query, "channel": CHANNEL, "combination_id": f"caccia|{c.verb}|{c.obj}",
                                    "origin_trend": f"{GOALS[self.goal]['origin']}:{self.seed}"}, kept, off_channel=len(results) - len(kept))
            learning.record_try(self.store, self.run_id, self.goal, self.seed, c.verb, c.obj, c.origin, c.query, read_posts)
        c.status, c.results, c.leads = "provata", len(kept), len(found)
        for stat in (self.verbs[c.verb], self.objects[_norm(c.obj)]):
            stat.searches += 1
            stat.results += len(kept)
            stat.leads += len(found)
        obj = self.objects[_norm(c.obj)]
        if not obj.leads and obj.searches >= DROP_OBJECT_AFTER:
            obj.dropped = True
            self._log("abbandono", f"«{c.obj}»: {obj.searches} ricerche senza lead, abbandonato")
        verb = self.verbs[c.verb]
        if not verb.leads and verb.searches >= DROP_VERB_AFTER and not verb.dropped:
            verb.dropped = True
            self._log("abbandono", f"«{c.verb}»: {verb.searches} ricerche senza lead, abbandonato")
        if found and _norm(f"{c.verb} {c.obj}") not in self._expanded:
            self._expand_queue.append(c)
        self._log("ricerca", f"{c.query} → {len(kept)} risultati, {len(found)} lead", query=c.query,
                  results=len(kept), leads=len(found))

    def step(self) -> bool:
        """One paid call (an autocomplete or a search). False when there is nothing left to do or no budget."""
        with self._lock:
            if self._left() <= 0 or self.stop_requested:
                return False
            # an expansion only while searches still have budget after it
            while self._expand_queue and self._autocomplete_allowed() and self._left() > 1:
                c = self._expand_queue.pop(0)
                if _norm(f"{c.verb} {c.obj}") in self._expanded:
                    continue
                self._expand(c)
                return True
            c = self._next()
            if c is None:
                return False
            self._try(c)
            return True

    def run(self, progress=None) -> dict:
        self.status = "in corso"
        if self.store is not None:
            self.run_id = learning.start_run(self.store, self.goal, self.seed, self.budget)
        self._log("inizio", f"Caccia a «{self.seed}»: {len(self.combos)} combinazioni, budget {self.budget}")
        try:
            while True:
                try:
                    if not self.step():
                        break
                except Exception as e:  # noqa: BLE001 - one failed call is said and stops the hunt, what was found stays
                    self._log("errore", f"Interrotta: {e}")
                    self.status = "errore"
                    raise
                if progress:
                    progress(self.budget - self._left(), self.budget)
        finally:
            if self.status == "in corso":
                self.status = "fermata" if self.stop_requested else "finita"
                left = sum(1 for c in self.combos.values() if c.status == "da provare")
                self._log("fine", f"{len(self.leads)} lead trovati; {left} combinazioni ancora da provare")
            if self.store is not None and self.run_id is not None:
                learning.end_run(self.store, self.run_id, self.status, self.spent, len(self.leads))
        return self.summary()

    # ---- what the page shows ---------------------------------------------------------------------

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        for c in self.combos.values():
            counts[c.status] = counts.get(c.status, 0) + 1
        return {"seed": self.seed, "goal": self.goal, "status": self.status, "budget": self.budget, "spent": dict(self.spent),
                "combos": len(self.combos), "by_status": counts, "leads": len(self.leads)}

    def snapshot(self, max_combos: int = 400) -> dict:
        with self._lock:
            pending = [c for c in self.combos.values() if c.status == "da provare"]
            for c in pending:
                c.priority = round(self._priority(c), 3)
            order = {"provata": 0, "da provare": 1, "già fatta": 2, "abbandonata": 3}
            combos = sorted(self.combos.values(), key=lambda c: (order[c.status], -c.leads, -c.priority))
            return {
                **self.summary(),
                "combos_list": [{"query": c.query, "verb": c.verb, "object": c.obj, "origin": c.origin, "status": c.status,
                                 "results": c.results, "leads": c.leads, "priority": c.priority} for c in combos[:max_combos]],
                "verbs": [{"text": v, **_stat(s)} for v, s in self.verbs.items()],
                "objects": sorted(({"text": next(c.obj for c in self.combos.values() if _norm(c.obj) == k), **_stat(s)}
                                   for k, s in self.objects.items()), key=lambda o: (-o["leads"], -o["weight"])),
                "lead_list": sorted(self.leads.values(), key=lambda l: -l["score"]),
                "events": self.events[-40:],
            }


def _stat(s: Stat) -> dict:
    return {"searches": s.searches, "results": s.results, "leads": s.leads, "dropped": s.dropped, "weight": round(s.weight(), 3)}


def plan(seed: str, budget: int, goal: str = "clienti") -> dict:
    """What a hunt would do, before spending: the combinations it starts from, the budget split."""
    h = Hunt(seed, budget, search=lambda q: [], autocomplete=lambda s: [], goal=goal)
    return {"seed": h.seed, "budget": h.budget, "goal": goal, "combos": len(h.combos), "objects": [o for o, _ in related_objects(h.seed)],
            "verbs": list(h.verbs), "autocomplete_max": max(1, int(budget * AUTOCOMPLETE_SHARE)),
            "cost": f"fino a {budget} ricerche SerpApi (comprese al massimo {max(1, int(budget * AUTOCOMPLETE_SHARE))} "
                    f"richieste di suggerimenti); le ricerche già fatte non si ripagano. Lettura dei post gratis (regole di BuyerML)."}


# ---- Suggested objects: what to hunt next, without typing (free: reads buyerml.db and the rules) ----

SUGGESTIONS = 8
MIN_NEW_SEARCHES = 5     # a suggestion must bring at least this many searches never done


def suggest_seeds(store=None, reader=None, limit: int = SUGGESTIONS) -> list[dict]:
    """The objects worth hunting next, best first, each with the reason. Nothing is paid:
      1. an object that brought leads in an earlier hunt, never hunted as a seed itself;
      2. a technology or need named in a buyer's post found earlier;
      3. the common IT requests (demand_queries.OBJECTS), in their order.
    Seeds already hunted are left out, so every suggestion is new searches."""
    from demand_queries import OBJECTS
    reader = reader or demand.read
    hunted: set[str] = set()
    winners: dict[str, dict] = {}
    asked: dict[str, dict] = {}
    if store is not None:
        hunted = {_norm(r[0].split(":", 1)[1]) for r in store.db.execute(
            "SELECT DISTINCT origin_trend FROM searches WHERE origin_trend LIKE 'caccia:%'")}
        rows = store.db.execute(
            "SELECT l.title, l.snippet, l.origin_trend, s.combination_id FROM leads l JOIN searches s"
            " ON s.search_text = l.search_text WHERE l.origin_trend LIKE 'caccia:%' AND l.on_channel = 1"
            " ORDER BY l.found_at DESC LIMIT 500").fetchall()
        seen_texts: set[str] = set()
        for r in rows:
            text = post_text({"title": r["title"] or "", "snippet": r["snippet"] or ""})
            if not text or _norm(text) in seen_texts:
                continue
            seen_texts.add(_norm(text))
            reading = reader(text)
            if reading.author_role != "buyer" or reading.demand not in ("yes", "weak"):
                continue
            if set(reading.intent_types) <= {"hiring"}:    # a job ad: not someone buying IT, not a reason to hunt
                continue
            seed = r["origin_trend"].split(":", 1)[1]
            obj = (r["combination_id"] or "").split("|")[-1]
            if obj:
                w = winners.setdefault(_norm(obj), {"seed": obj, "leads": 0, "from": seed})
                w["leads"] += 1
            for tech in reading.technology[:3]:
                asked.setdefault(_norm(tech), {"seed": tech, "posts": 0})["posts"] += 1
    out: list[dict] = []
    taken = set(hunted)
    tax = demand.default_taxonomy()

    def new_searches(seed: str) -> int:
        h = Hunt(seed, 1, search=lambda q: [], autocomplete=lambda s: [], store=store)
        return sum(c.status == "da provare" for c in h.combos.values())

    def add(seed: str, reason: str, source: str) -> None:
        if _norm(seed) in taken or len(out) >= limit:
            return
        taken.add(_norm(seed))
        if not demand.match_market(seed, tax)["node"]:          # outside IT: not a lead for BuyerML
            return
        if store is not None and new_searches(seed) < MIN_NEW_SEARCHES:   # its combinations are almost all done
            return
        out.append({"seed": seed, "reason": reason, "source": source})

    for w in sorted(winners.values(), key=lambda w: -w["leads"]):
        add(w["seed"], f"ha portato {w['leads']} lead nella caccia a «{w['from']}»", "vincente")
    for a in sorted(asked.values(), key=lambda a: -a["posts"]):
        add(a["seed"], f"chiesto in {a['posts']} post di chi cerca" if a["posts"] > 1 else "chiesto in un post di chi cerca", "dai post")
    for obj in OBJECTS:
        add(obj, "tra le richieste IT più comuni", "lista")
    return out
