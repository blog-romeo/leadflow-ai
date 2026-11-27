"""
================================================================================
BuyerML — Autocomplete Dorking Scraper (bridge Layer 1 Trend Terms -> Layer 2)
================================================================================
Turns a trend found by Layer 1 into ready-to-paste dorking commands, using
Google Autocomplete twice:

    A. Layer 1      trend -> autocomplete + questions -> awareness + real intent
                    (reuses KeywordExpansion, AwarenessMapper, IntentDetector)
    B. Filter       keep transactional / navigational / commercial investigation
    C. Dork AC      autocomplete on "intent + term" (e.g. "sto cercando chatbot
                    whatsapp") -> the phrasings people really type -> new objects
    D. Combine      channel x intent OR-group x objects x trend x discard,
                    assembled by build_command() in the fixed order of the
                    Dorking Engine Command Specification (dorkng.pdf, Part 6)

How to use it:
    python autocomplete_dorking.py "chatbot whatsapp"
    python autocomplete_dorking.py "chatbot whatsapp" --csv dorks.csv

With MOCK_MODE = True (set in buyerml_seo_aeo_workflow.py) the demo trend
"chatbot whatsapp" runs on invented sample data: it shows the mechanism,
not real autocomplete results.

Not done here (next steps): executing the dorks, scoring results, feeding
yield back into the priorities (memorandum, sections 10-11).
================================================================================
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import re
from dataclasses import dataclass, field
from typing import Iterator

import requests

import buyerml_seo_aeo_workflow as wf
from buyerml_seo_aeo_workflow import (
    AwarenessMapper,
    IntentDetector,
    KeywordExpansion,
    SearchIntent,
)
from buyerml_store import Store


# ==============================================================================
# COMMAND GRAMMAR — dorkng.pdf, Parts 1-6
# ==============================================================================

# Part 2 — one location line per channel. Spec v1.0 §9: only Facebook groups and LinkedIn are
# searched (Reddit, forums, freelancer sites and plain Google were removed on 19 Oct 2026).
CHANNELS = {
    "facebook_groups": "site:facebook.com/groups",
    "linkedin_posts": "site:linkedin.com/posts",
}

# Part 3 — the 30 combinations: id -> (is_direct, category slots in fixed order).
# Direct combinations also get the intent OR-group in front of the slots.
COMBINATIONS: dict[str, tuple[bool, tuple[str, ...]]] = {
    "COMBO_01": (True, ("product",)),
    "COMBO_02": (True, ("service",)),
    "COMBO_03": (True, ("technology",)),
    "COMBO_04": (False, ("product", "problem")),
    "COMBO_05": (False, ("product", "function")),
    "COMBO_06": (False, ("product", "technology")),
    "COMBO_07": (False, ("product", "industry")),
    "COMBO_08": (False, ("technology", "problem")),
    "COMBO_09": (False, ("technology", "function")),
    "COMBO_10": (False, ("technology", "industry")),
    "COMBO_11": (False, ("service", "industry")),
    "COMBO_12": (False, ("problem", "solution")),
    "COMBO_13": (False, ("problem", "technology")),
    "COMBO_14": (False, ("industry", "problem")),
    "COMBO_15": (False, ("industry", "solution")),
    "COMBO_16": (False, ("role", "technology")),
    "COMBO_17": (False, ("role", "industry")),
    "COMBO_18": (False, ("company", "technology")),
    "COMBO_19": (False, ("company", "problem")),
    "COMBO_20": (False, ("company", "project")),
    "COMBO_21": (True, ("product", "function")),
    "COMBO_22": (True, ("technology", "service")),
    "COMBO_23": (False, ("product", "function", "technology")),
    "COMBO_24": (False, ("product", "problem", "technology")),
    "COMBO_25": (False, ("product", "function", "industry")),
    "COMBO_26": (False, ("technology", "problem", "industry")),
    "COMBO_27": (True, ("product", "technology", "industry")),
    "COMBO_28": (True, ("problem", "solution", "technology")),
    "COMBO_29": (False, ("product", "problem", "function", "technology", "industry")),
    "COMBO_30": (True, ("product", "problem", "function", "technology", "industry")),
    # Not one of the 30: the memorandum's "direct intent + object" structure.
    # Objects coming from autocomplete are free phrases ("esperto chatbot
    # whatsapp") not yet classified as product / service / technology, so
    # they get their own slot instead of being mislabeled as COMBO_01-03.
    "DIRECT_OBJECT": (True, ("object",)),
}

# Part 4 — MOD_DISCARD: "2-5 terms (long strings are silently truncated)"
MAX_DISCARD = 5

# Direct intents (memorandum, section 8). They are variants to be measured,
# not perfect synonyms. Order matters: the scraper seeds autocomplete with the
# first max_dork_intents, so distinct phrasings come before near-synonyms.
INTENTS = {
    "it": [
        "sto cercando",
        "qualcuno conosce",
        "abbiamo bisogno di",
        "cerchiamo",
        "stiamo cercando",
        "cerco un fornitore",
        "siamo alla ricerca di",
    ],
    "en": [
        "looking for",
        "we need",
        "seeking",
        "we require",
        "need help with",
        "looking to hire",
        "recommendations for",
    ],
}

# Part 4 — standard discard set. "en" is verbatim from the spec; "it" is a
# proposed translation, to be validated on real results.
DISCARD_SETS = {
    "en": [
        "looking for a job", "job seeking", "currently looking for work",
        "available for work", "send your resume", "apply now", "join our team",
        "internship", "traineeship program", "we offer our services", "we sell",
        "promoting our service", "contact us for a free demo", "discover our offer",
    ],
    "it": [
        "cerco lavoro", "disponibile per lavoro", "invia il tuo cv", "candidati ora",
        "unisciti al nostro team", "stage", "tirocinio", "offriamo i nostri servizi",
        "vendiamo", "contattaci per una demo gratuita",
    ],
}

# Default per command: one term per false-positive family
# (job seekers, sellers, recruiting), well under MAX_DISCARD.
DEFAULT_DISCARD = {
    "it": ["cerco lavoro", "offriamo i nostri servizi", "invia il tuo cv"],
    "en": ["looking for a job", "we offer our services", "send your resume"],
}

# The 22 seed roles (LIN.pdf, section 2.1). Note: the role list in dorkng.pdf
# Part 5 is mis-pasted ("Manager Freelancer", "Operations HR Manager").
SEED_ROLES = [
    "Manager", "Freelancer", "Operations", "HR Manager", "CEO", "CTO",
    "Project & Operations Manager", "Founder & CEO", "Senior IT Technology Specialist",
    "Social Media Manager", "Accountant", "CIO/CTO & Founder",
    "Business Development Manager", "Partner / Tax Law Firm", "Co-Founder",
    "Chief Operating Officer", "Business Process Manager", "Business Operations",
    "ERM Senior Executive", "Chief Strategy & Innovation Officer", "Executive Manager",
    "Healthcare Facility Management Officer / HR Acquisition",
]


def _quote(word: str) -> str:
    clean = word.replace('"', "").strip()
    if not clean:
        raise ValueError("empty word in command")
    return f'"{clean}"'


def build_command(
    channel: str,
    combination_id: str,
    intent_words: list[str],
    category_words: dict[str, str],
    trend_word: str | None = None,
    discard_words: list[str] | tuple[str, ...] = (),
) -> str:
    """
    dorkng.pdf Part 6. Fixed assembly order, regardless of channel/combination:
    [site:/inurl: line] [intent OR-group if direct] [category slots, combo order]
    [trend slot if present] [discard exclusions]

    is_direct is not a parameter: it is read from COMBINATIONS, so a command
    can never disagree with its combination. The output has no "q:" prefix —
    that is notation in the spec, not text to send to Google.
    """
    if channel not in CHANNELS:
        raise ValueError(f"unknown channel: {channel}")
    if combination_id not in COMBINATIONS:
        raise ValueError(f"unknown combination: {combination_id}")
    is_direct, slots = COMBINATIONS[combination_id]

    missing = [s for s in slots if not category_words.get(s)]
    unexpected = sorted(set(category_words) - set(slots))
    if missing or unexpected:
        raise ValueError(
            f"{combination_id} needs slots {list(slots)}; "
            f"missing {missing}, unexpected {unexpected}"
        )
    if len(discard_words) > MAX_DISCARD:
        raise ValueError(f"at most {MAX_DISCARD} discard terms, got {len(discard_words)}")

    parts = [CHANNELS[channel]] if CHANNELS[channel] else []

    if is_direct:
        if not intent_words:
            raise ValueError(f"{combination_id} is direct: intent_words required")
        intents = [_quote(w) for w in intent_words]
        parts.append(intents[0] if len(intents) == 1 else "(" + " OR ".join(intents) + ")")
    elif intent_words:
        raise ValueError(f"{combination_id} is indirect: it never contains intent")

    parts.extend(_quote(category_words[s]) for s in slots)
    if trend_word:
        parts.append(_quote(trend_word))
    parts.extend("-" + _quote(w) for w in discard_words)
    return " ".join(parts)


def build_profile_lookup(role: str) -> str:
    """dorkng.pdf Part 5 — OUTPUT2_PROFILE_LOOKUP (LinkedIn role arm, uses DNA roles)."""
    return f"site:linkedin.com/in {_quote(role)}"


# ==============================================================================
# COMBINATORIAL GENERATION
# ==============================================================================

@dataclass
class DorkCommand:
    search_text: str
    channel: str
    combination_id: str
    intents: list[str]
    categories: dict[str, str]
    trend_word: str | None
    discard_words: list[str]
    origin_trend: str = ""

    def to_row(self) -> dict:
        return {
            "search_text": self.search_text,
            "channel": self.channel,
            "combination_id": self.combination_id,
            "intents": " | ".join(self.intents),
            "categories": json.dumps(self.categories, ensure_ascii=False),
            "trend_word": self.trend_word or "",
            "discard_words": " | ".join(self.discard_words),
            "origin_trend": self.origin_trend,
        }


def _intent_groups(intents: list[str], max_or: int) -> Iterator[tuple[str, ...]]:
    """Single intents first (each variant measurable on its own), then OR-groups."""
    for k in range(1, min(max_or, len(intents)) + 1):
        yield from itertools.combinations(intents, k)


def count_commands(
    category_lists: dict[str, list[str]],
    intents: list[str],
    channels: list[str],
    combination_ids: list[str],
    max_or: int = 2,
) -> int:
    """How many commands generate_commands() would yield — check before running."""
    n_groups = sum(math.comb(len(intents), k) for k in range(1, min(max_or, len(intents)) + 1))
    total = 0
    for combo_id in combination_ids:
        is_direct, slots = COMBINATIONS[combo_id]
        if not all(category_lists.get(s) for s in slots):
            continue
        words = math.prod(len(category_lists[s]) for s in slots)
        total += (n_groups if is_direct else 1) * words * len(channels)
    return total


def generate_commands(
    category_lists: dict[str, list[str]],
    intents: list[str],
    channels: list[str],
    combination_ids: list[str],
    max_or: int = 2,
    trend_word: str | None = None,
    discard_words: list[str] | tuple[str, ...] = (),
    origin_trend: str = "",
) -> Iterator[DorkCommand]:
    """
    Every combination of: combination x intent group (direct only) x one word
    per category slot x channel. Combinations whose slots have no words are
    skipped. Lazy, because the space grows multiplicatively.
    """
    for combo_id in combination_ids:
        is_direct, slots = COMBINATIONS[combo_id]
        if not all(category_lists.get(s) for s in slots):
            continue
        groups = list(_intent_groups(intents, max_or)) if is_direct else [()]
        for group in groups:
            for words in itertools.product(*(category_lists[s] for s in slots)):
                categories = dict(zip(slots, words))
                # MOD_TREND adds nothing if the trend is already inside a slot
                trend = trend_word
                if trend and any(trend.lower() in w.lower() for w in words):
                    trend = None
                for channel in channels:
                    yield DorkCommand(
                        search_text=build_command(
                            channel, combo_id, list(group), categories, trend, discard_words
                        ),
                        channel=channel,
                        combination_id=combo_id,
                        intents=list(group),
                        categories=categories,
                        trend_word=trend,
                        discard_words=list(discard_words),
                        origin_trend=origin_trend,
                    )


# ==============================================================================
# STEP A-B — Layer 1 terms, filtered by intent
# ==============================================================================

@dataclass
class TrendTerm:
    query: str
    intent: str
    awareness: str
    source: str  # "trend" | "keyword" | "question"
    keep_reason: str = ""  # "intent" | "solution term" when kept for dorking


# A Layer 1 term that names a solution ("chatbot whatsapp business") is a dork
# object even when Google calls the search "informational". Excluded: questions
# and study/developer searches, which do not come from buyers.
_QUESTION_START = re.compile(
    r"^(come|cosa|cos['’]è|che cos|perch[eé]|quando|dove|chi|quale|quali|quanto|"
    r"how|what|why|when|where|who|which)\b"
)
_STUDY_WORDS = re.compile(
    r"(?<!\w)(github|open source|tutorial|guida|corso|wikipedia|pdf|esempio|esempi|significato|"
    r"definizione|example|examples|course|guide)(?!\w)"
)


def is_solution_term(query: str) -> bool:
    q = query.lower().strip()
    return bool(q) and not q.endswith("?") and not _QUESTION_START.search(q) and not _STUDY_WORDS.search(q)


# Invented sample data for the demo trend (MOCK_MODE only).
DEMO_TREND_TERMS = {
    "chatbot whatsapp": [
        TrendTerm("chatbot whatsapp", SearchIntent.TRANSACTIONAL.value, "Solution Aware", "trend"),
        TrendTerm("chatbot whatsapp business", SearchIntent.NAVIGATIONAL.value, "Product Aware", "keyword"),
        TrendTerm("chatbot whatsapp ai", SearchIntent.TRANSACTIONAL.value, "Solution Aware", "keyword"),
        TrendTerm("migliori chatbot whatsapp", SearchIntent.COMMERCIAL_INVESTIGATION.value, "Product Aware", "keyword"),
        TrendTerm("come creare un chatbot whatsapp", SearchIntent.INFORMATIONAL.value, "Solution Aware", "question"),
    ],
}

DEMO_DORK_AUTOCOMPLETE = {
    "sto cercando chatbot whatsapp": [
        "sto cercando un esperto chatbot whatsapp",
        "sto cercando uno sviluppatore chatbot whatsapp",
    ],
    "qualcuno conosce chatbot whatsapp": [
        "qualcuno conosce un'agenzia chatbot whatsapp",
        "qualcuno conosce un ai developer per chatbot whatsapp",
    ],
    "sto cercando chatbot whatsapp ai": [
        "stiamo cercando chatbot expert whatsapp ai",
    ],
    "abbiamo bisogno di chatbot whatsapp": [
        "chatbot whatsapp gratis",
    ],
}


def collect_trend_terms(trend: str, max_checks: int | None = None,
                        errors: list[str] | None = None) -> list[TrendTerm]:
    """
    Layer 1 for one trend: the trend itself + Trends queries + autocomplete +
    questions, each with awareness and real SERP intent. Terms whose ads belong
    to forbidden industries are dropped (Layer 0 rule). One SERP call per term,
    so only the first max_checks terms (in Layer 1 priority order) are checked.
    """
    if wf.MOCK_MODE and trend.lower() in DEMO_TREND_TERMS:
        return list(DEMO_TREND_TERMS[trend.lower()])[:max_checks]

    errors = errors if errors is not None else []
    expansion = KeywordExpansion()
    keywords = ([{"query": trend, "type": "trend"}] + expansion.expand(trend))[:max_checks]
    errors.extend(expansion.errors)
    mapper, detector = AwarenessMapper(), IntentDetector()
    terms = []
    for kw in keywords:
        try:
            serp = detector.detect(kw["query"])
        except requests.RequestException as e:
            errors.append(f"intent of {kw['query']!r}: {e}")  # one term lost, not the whole run
            continue
        if not serp["domain_relevant"]:
            continue
        terms.append(TrendTerm(
            query=kw["query"],
            intent=serp["real_serp_intent"],
            awareness=mapper.classify(kw["query"])["awareness"],
            source=kw.get("type", "keyword"),
        ))
    return terms


# ==============================================================================
# STEP C — autocomplete on dork phrases
# ==============================================================================

_LEADING_ARTICLE = re.compile(
    r"^(?:(?:un|uno|una|il|lo|la|i|gli|le|dei|degli|delle|a|an|the|some)\s+|(?:un'|l')\s*)",
    re.IGNORECASE,
)


def split_intent(phrase: str, intents: list[str]) -> tuple[str | None, str]:
    """
    "qualcuno conosce un'agenzia chatbot whatsapp"
        -> ("qualcuno conosce", "agenzia chatbot whatsapp")
    Longest matching intent wins. No known intent -> (None, phrase).
    """
    text = " ".join(phrase.lower().split())
    for intent in sorted(intents, key=len, reverse=True):
        if text.startswith(intent + " "):
            rest = _LEADING_ARTICLE.sub("", text[len(intent):].strip()).strip()
            return (intent, rest) if rest else (None, text)
    return None, text


def fetch_autocomplete(seed: str) -> list[str]:
    if wf.MOCK_MODE:
        # unknown seeds return nothing: the repo's generic mock ("<seed> software")
        # would produce meaningless dork phrases
        return DEMO_DORK_AUTOCOMPLETE.get(seed.lower(), [])
    return [s["query"] for s in KeywordExpansion()._fetch_autocomplete(seed)]


@dataclass
class DorkPhrase:
    seed: str
    suggestion: str
    intent: str
    object: str


# ==============================================================================
# PIPELINE
# ==============================================================================

@dataclass
class DorkingRun:
    trend: str
    trend_terms: list[TrendTerm]
    kept_terms: list[TrendTerm]
    phrases: list[DorkPhrase]
    unmatched: list[str]  # suggestions with no known intent: review by hand,
                          # they may contain new intent phrasings
    intents: list[str]
    objects: list[str]
    command_count: int
    commands: list[DorkCommand] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # searches that failed and were skipped


def _unique(items) -> list[str]:
    seen, out = set(), []
    for item in items:
        if item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
    return out


class AutocompleteDorkingScraper:
    """Bridge between Layer 1 (Trend Terms) and Layer 2 (Dorking)."""

    def __init__(
        self,
        language: str = wf.LANGUAGE,
        channels: list[str] | None = None,
        include_commercial_investigation: bool = True,
        include_solution_terms: bool = True,
        max_or: int = 2,
        discard_words: list[str] | None = None,
        max_intent_checks: int = 12,
        max_dork_terms: int = 6,
        max_dork_intents: int = 3,
    ):
        """
        The three max_* limits bound the SerpApi searches of one run
        (see estimate_searches): intent checks on Layer 1 terms, and
        Layer 1 terms x intents used as dork autocomplete seeds.
        """
        self.language = language
        self.intents = INTENTS[language]
        self.channels = channels or list(CHANNELS)
        self.allowed_intents = {SearchIntent.TRANSACTIONAL.value, SearchIntent.NAVIGATIONAL.value}
        if include_commercial_investigation:
            self.allowed_intents.add(SearchIntent.COMMERCIAL_INVESTIGATION.value)
        self.include_solution_terms = include_solution_terms
        self.max_or = max_or
        self.discard_words = DEFAULT_DISCARD[language] if discard_words is None else discard_words
        self.max_intent_checks = max_intent_checks
        self.max_dork_terms = max_dork_terms
        self.max_dork_intents = max_dork_intents

    def estimate_searches(self) -> int:
        """Maximum SerpApi searches for one trend in real mode (mock mode uses none)."""
        prefixes = KeywordExpansion.QUESTION_PREFIXES.get(wf.LANGUAGE, KeywordExpansion.QUESTION_PREFIXES["en"])
        expansion = 3 + len(prefixes)  # Trends related + autocomplete + People also ask + question openers
        return expansion + self.max_intent_checks + self.max_dork_terms * self.max_dork_intents

    def run(self, trend: str, trend_word: str | None = None, limit: int | None = None) -> DorkingRun:
        # A-B — Layer 1 terms, keep transactional / navigational / commercial investigation
        errors: list[str] = []
        trend_terms = collect_trend_terms(trend, max_checks=self.max_intent_checks, errors=errors)
        kept = []
        for t in trend_terms:
            if t.intent in self.allowed_intents:
                t.keep_reason = "intent"
            elif (self.include_solution_terms and t.intent == SearchIntent.INFORMATIONAL.value
                  and is_solution_term(t.query)):
                t.keep_reason = "solution term"
            else:
                continue
            kept.append(t)

        # C — autocomplete on "intent + term" (first intents x first kept terms);
        # suggestions are still matched against every known intent
        phrases, unmatched = [], []
        seed_pairs = itertools.product(self.intents[:self.max_dork_intents], kept[:self.max_dork_terms])
        for intent, term in seed_pairs:
            seed = f"{intent} {term.query}"
            try:
                suggestions = fetch_autocomplete(seed)
            except requests.RequestException as e:
                errors.append(f"dork autocomplete for {seed!r}: {e}")
                continue
            for suggestion in suggestions:
                found_intent, obj = split_intent(suggestion, self.intents)
                if found_intent:
                    phrases.append(DorkPhrase(seed, suggestion, found_intent, obj))
                else:
                    unmatched.append(suggestion)

        # Prefer phrasings observed in autocomplete; fall back to the seed
        # lexicon / Layer 1 terms when autocomplete returned nothing usable.
        intents = _unique(p.intent for p in phrases) or self.intents
        objects = _unique(p.object for p in phrases) or _unique(t.query for t in kept)

        # D — all combinations, direct intent + object
        category_lists = {"object": objects}
        combos = ["DIRECT_OBJECT"]
        total = count_commands(category_lists, intents, self.channels, combos, self.max_or)
        generator = generate_commands(
            category_lists, intents, self.channels, combos, self.max_or,
            trend_word=trend_word, discard_words=self.discard_words, origin_trend=trend,
        )
        commands = list(itertools.islice(generator, limit))

        return DorkingRun(
            trend=trend,
            trend_terms=trend_terms,
            kept_terms=kept,
            phrases=phrases,
            unmatched=_unique(unmatched),
            intents=intents,
            objects=objects,
            command_count=total,
            commands=commands,
            errors=errors,
        )


def export_csv(commands: list[DorkCommand], path: str) -> None:
    """One row per command; search_text is the Overview's search_text field."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(DorkCommand.__dataclass_fields__))
        writer.writeheader()
        for cmd in commands:
            writer.writerow(cmd.to_row())


def main() -> None:
    parser = argparse.ArgumentParser(description="BuyerML Autocomplete Dorking Scraper")
    parser.add_argument("trend", nargs="?", default=None, help='default: "chatbot whatsapp"')
    parser.add_argument("--from-feedback", action="store_true",
                        help="take the trend from the next Dorking term saved in buyerml.db (link 17)")
    parser.add_argument("--channels", default=None,
                        help="comma-separated, e.g. facebook_groups,linkedin_posts (default: all 7)")
    parser.add_argument("--no-save", action="store_true",
                        help="real mode: do not save terms to buyerml.db")
    parser.add_argument("--export-trends", metavar="JSON",
                        help="write saved trends for the Layer 3 engine (link 16) and exit")
    parser.add_argument("--language", default=wf.LANGUAGE, choices=sorted(INTENTS))
    parser.add_argument("--trend-word", default=None)
    parser.add_argument("--max-or", type=int, default=2)
    parser.add_argument("--no-solution-terms", action="store_true",
                        help="keep only terms with a buying intent, not informational solution names")
    parser.add_argument("--no-commercial", action="store_true",
                        help="drop commercial_investigation terms")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--csv", default=None, help="write commands to this CSV file")
    parser.add_argument("--max-intent-checks", type=int, default=12)
    parser.add_argument("--max-dork-terms", type=int, default=6)
    parser.add_argument("--max-dork-intents", type=int, default=3)
    parser.add_argument("--yes", action="store_true",
                        help="real mode: confirm spending the estimated SerpApi searches")
    args = parser.parse_args()

    if args.export_trends:
        store = Store()
        print(f"{store.export_trends_json(args.export_trends)} trends written to {args.export_trends}")
        return
    if args.from_feedback:
        feedback = Store().next_feedback_terms(1)
        if not feedback:
            print("No Dorking terms waiting in buyerml.db.")
            return
        args.trend = feedback[0]
    args.trend = args.trend or "chatbot whatsapp"

    print("=" * 80)
    print(f"BuyerML — Autocomplete Dorking Scraper · trend: {args.trend!r}"
          + ("  [MOCK DATA]" if wf.MOCK_MODE else ""))
    print("=" * 80)

    scraper = AutocompleteDorkingScraper(
        language=args.language,
        include_commercial_investigation=not args.no_commercial,
        include_solution_terms=not args.no_solution_terms,
        max_or=args.max_or,
        max_intent_checks=args.max_intent_checks,
        max_dork_terms=args.max_dork_terms,
        max_dork_intents=args.max_dork_intents,
        channels=args.channels.split(",") if args.channels else None,
    )
    if not wf.MOCK_MODE:
        print(f"\nReal mode: up to {scraper.estimate_searches()} SerpApi searches for this trend.")
        if not args.yes:
            print("Nothing sent. Re-run with --yes to proceed.")
            return
    run = scraper.run(args.trend, trend_word=args.trend_word, limit=args.limit)

    print(f"\n[A] Layer 1 terms: {len(run.trend_terms)}")
    for t in run.trend_terms:
        mark = f"keep ({t.keep_reason})" if t in run.kept_terms else "drop"
        print(f"  {mark:<21} {t.query:<40} {t.intent:<26} {t.awareness}")

    print(f"\n[C] Dork phrases from autocomplete: {len(run.phrases)}")
    for p in run.phrases:
        print(f"  {p.suggestion:<55} -> intent={p.intent!r} object={p.object!r}")
    if run.unmatched:
        print("  To review by hand (no known intent):")
        for s in run.unmatched:
            print(f"    - {s}")

    print(f"\n[D] {len(run.intents)} intents x {len(run.objects)} objects x "
          f"{len(scraper.channels)} channels, OR-groups up to {args.max_or}"
          f" -> {run.command_count} commands")
    for cmd in run.commands[:10]:
        print(f"  {cmd.search_text}")
    if len(run.commands) > 10:
        print(f"  ... {len(run.commands) - 10} more")

    if run.errors:
        print(f"\n{len(run.errors)} searches failed and were skipped:")
        for e in run.errors:
            print(f"  - {e[:200]}")

    if args.csv:
        export_csv(run.commands, args.csv)
        print(f"\nWritten {len(run.commands)} commands to {args.csv}")

    # demo data stays out of the Terms Dataset
    if not wf.MOCK_MODE and not args.no_save:
        store = Store()
        saved = store.save_run(run)
        print(f"\nSaved to {store.path}: {saved['layer1']} new Layer 1 terms, "
              f"{saved['dorking']} new Dorking terms (back to Layer 1 with --from-feedback), "
              f"{saved['review']} to review")


if __name__ == "__main__":
    main()
