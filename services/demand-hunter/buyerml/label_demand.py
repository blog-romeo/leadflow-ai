"""
================================================================================
BuyerML — Labels for the real posts: Claude labels, a person checks a sample
================================================================================
The posts collected by dork_runner.py (buyerml.db, table leads) are read by Claude with the
DEMAND_SCHEMA contract of demand.py. Those labels ("silver": good, not checked) train the local
models (train_demand.py). A person checks a stratified sample; the checked posts become the real
test set (fixtures/demand_real.json) and are never used for training.

    python label_demand.py                                   # how many posts, how many Claude requests (nothing spent)
    python label_demand.py --max 200 --yes                   # label up to 200 posts (Claude, paid)
    python label_demand.py --sample-review 300 review.csv    # stratified sample for a person to check
    python label_demand.py --import-review review.csv        # checked sample -> fixtures/demand_real.json

Labels go to data/demand_labels.jsonl, one post per line, appended: a post already labelled is skipped,
so a run can stop and start again. The rules' reading (free) is stored next to Claude's.
================================================================================
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
from datetime import datetime, timezone

import demand

HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = os.path.join(HERE, "data", "demand_labels.jsonl")
REAL_SET = os.path.join(HERE, "fixtures", "demand_real.json")
BATCH = 20                       # posts per Claude request (eval_demand.claude_reader uses the same)

_TITLE_TAIL = re.compile(r"\s*[|\-–]\s*Facebook\s*$", re.I)


def post_text(lead: dict) -> str:
    """The text a reader sees: Google's title (without '| Facebook') and the snippet. The same function
    is used for labelling, training and later for reading, so the model always sees the same kind of text."""
    title = _TITLE_TAIL.sub("", (lead.get("title") or "").strip())
    snippet = (lead.get("snippet") or "").strip()
    if title and snippet and title.lower() not in snippet.lower():
        return f"{title}. {snippet}"
    return snippet or title


def load_labels(path: str = LABELS) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def pending_posts(leads: list[dict], labelled: list[dict]) -> list[dict]:
    """Posts on Facebook groups not yet labelled, one per distinct text (Google repeats a post under several URLs)."""
    done_urls = {l["url"] for l in labelled}
    done_texts = {" ".join(l["text"].lower().split()) for l in labelled}
    out, seen = [], set()
    for lead in leads:
        if lead.get("channel") != "facebook_groups" or lead["url"] in done_urls:
            continue
        text = post_text(lead)
        key = " ".join(text.lower().split())
        if len(key) < 15 or key in done_texts or key in seen:
            continue
        seen.add(key)
        out.append({"url": lead["url"], "text": text, "search_text": lead.get("search_text", "")})
    return out


def label(posts: list[dict], reader, path: str = LABELS, batch: int = BATCH) -> int:
    """Reads posts with `reader` (texts -> Reading dicts) one batch at a time, appending each batch,
    so an error after N batches keeps the N batches already paid for."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    written = 0
    for start in range(0, len(posts), batch):
        chunk = posts[start:start + batch]
        readings = reader([p["text"] for p in chunk])
        rules = [demand.read(p["text"]).to_dict() for p in chunk]
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with open(path, "a", encoding="utf-8") as f:
            for p, r, rr in zip(chunk, readings, rules):
                f.write(json.dumps({**p, "claude": r, "rules": rr, "labelled_at": now}, ensure_ascii=False) + "\n")
        written += len(chunk)
    return written


# ---- the human check ---------------------------------------------------------------------------------

REVIEW_FIELDS = ("url", "text", "demand", "author_role", "stage", "intents", "market", "tech", "budget", "urgent",
                 "claude_score", "group", "note")


def sample_for_review(labelled: list[dict], n: int, seed: int = 7) -> list[dict]:
    """A third each: leads Claude scores high (quality check), the middle (ambiguous cases), the posts
    Claude reads as no demand (missed requests). If a group is short, the others fill the gap."""
    rnd = random.Random(seed)
    groups = {"alto": [], "medio": [], "negativo": []}
    for l in labelled:
        c = l["claude"]
        g = "negativo" if c["demand"] == "no" else "alto" if c["lead_score"] >= 66 else "medio"
        groups[g].append(l)
    for g in groups.values():
        rnd.shuffle(g)
    picked, per = [], n // 3
    for name in groups:
        picked += [(name, l) for l in groups[name][:per]]
    rest = [(name, l) for name in groups for l in groups[name][per:]]
    rnd.shuffle(rest)
    picked += rest[:max(0, n - len(picked))]
    rows = []
    for name, l in picked:
        c = l["claude"]
        # prefilled with Claude's reading: the person corrects what is wrong (faster; the cost is
        # some trust in Claude, so the 'negativo' third is there to catch what it missed)
        rows.append({"url": l["url"], "text": l["text"], "demand": c["demand"], "author_role": c["author_role"],
                     "stage": c["stage"], "intents": " | ".join(c["intent_types"]), "market": c["taxonomy_node"] or "",
                     "tech": " | ".join(c["technology"]), "budget": int(c["budget_declared"]),
                     "urgent": int(c["urgency"] != "low"), "claude_score": c["lead_score"], "group": name, "note": ""})
    return rows


def write_review(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=REVIEW_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def _split(value: str) -> list[str]:
    return [x.strip() for x in (value or "").split("|") if x.strip()]


def import_review(path: str, out: str = REAL_SET, start_id: int = 1001) -> int:
    """The checked CSV -> the fixtures format of demand_eval.json, source 'reale'. A wrong value stops
    the import with the row number, so nothing half-valid reaches the test set."""
    tax = demand.default_taxonomy()
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    examples, errors = [], []
    for n, r in enumerate(rows, start=2):
        intents = _split(r["intents"])
        market = r["market"].strip() or None
        problems = [f"demand={r['demand']}"] if r["demand"] not in ("yes", "weak", "no") else []
        problems += [f"author_role={r['author_role']}"] if r["author_role"] not in demand.ROLES else []
        problems += [f"stage={r['stage']}"] if r["stage"] not in demand.STAGES else []
        problems += [f"intent={i}" for i in intents if i not in demand.INTENTS]
        problems += [f"market={market}"] if market and market not in tax.nodes else []
        if problems:
            errors.append(f"row {n}: {', '.join(problems)}")
            continue
        examples.append({"id": start_id + len(examples), "text": r["text"], "lang": demand.detect_language(r["text"]),
                         "demand": r["demand"], "author_role": r["author_role"], "intents": intents,
                         "stage": r["stage"], "market": market, "tech": _split(r["tech"]),
                         "budget": r["budget"].strip() in ("1", "true", "si", "sì", "yes"),
                         "urgent": r["urgent"].strip() in ("1", "true", "si", "sì", "yes"),
                         "case": f"reale_{r.get('group') or 'campione'}", "source": "reale", "url": r["url"],
                         "note": r.get("note", "")})
    if errors:
        raise ValueError("review not imported:\n" + "\n".join(errors))
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"_about": "Post reali controllati da una persona (label_demand.py --import-review). "
                             "Set di prova: mai usati per addestrare (train_demand.py li esclude).",
                   "examples": examples}, f, ensure_ascii=False, indent=1)
    return len(examples)


def main() -> None:
    ap = argparse.ArgumentParser(description="Claude labels for the real posts; a person checks a sample")
    ap.add_argument("--max", type=int, default=200, help="max posts to label in this run")
    ap.add_argument("--yes", action="store_true", help="confirm the Claude requests")
    ap.add_argument("--sample-review", nargs=2, metavar=("N", "CSV"))
    ap.add_argument("--import-review", metavar="CSV")
    a = ap.parse_args()

    if a.sample_review:
        rows = sample_for_review(load_labels(), int(a.sample_review[0]))
        write_review(rows, a.sample_review[1])
        print(f"{len(rows)} posts written to {a.sample_review[1]}: correct the columns demand…urgent, then --import-review")
        return
    if a.import_review:
        print(f"{import_review(a.import_review)} checked posts written to {REAL_SET}")
        return

    from buyerml_store import Store
    store = Store()
    posts = pending_posts(store.leads(), load_labels())[:a.max]
    requests = -(-len(posts) // BATCH)
    print(f"{len(posts)} posts to label -> {requests} Claude requests ({BATCH} posts each). Database: {store.path}")
    if not posts or not a.yes:
        print("Nothing sent." + (" Re-run with --yes to proceed." if posts else ""))
        return
    import eval_demand
    n = label(posts, eval_demand.claude_reader(BATCH))
    print(f"{n} posts labelled, appended to {LABELS}")


if __name__ == "__main__":
    main()
