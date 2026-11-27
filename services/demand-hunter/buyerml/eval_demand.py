"""
================================================================================
BuyerML — measuring a reader of the demand on labelled posts (fixtures/demand_eval.json)
================================================================================
Every reader (the free rules in demand.py, a Hugging Face model, Claude, a future fine-tuned
classifier) is measured the same way before it is trusted:

  demand        precision / recall / F1 of "yes" (a real need), and of "yes or weak"
  traps         how many sellers, job seekers, learners, keyword-only posts and non-IT
                requests are wrongly read as demand (the false positives that cost money)
  role          accuracy of who is writing (buyer, seller, job seeker, learner, neutral)
  intents       micro precision / recall / F1 over the eight intents (several per post)
  stage         exact and within-one-step accuracy
  market        exact taxonomy node, and first level under IT
  top leads     precision among the posts scored 75 or more

    python eval_demand.py                         # the rules
    python eval_demand.py --errors                # ... and every mistake
    python eval_demand.py --reader hf-binary:j-hartmann/purchase-intention-english-roberta-large
    python eval_demand.py --reader hf-zeroshot:MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7
    python eval_demand.py --reader hf-knn:intfloat/multilingual-e5-small   # leave-one-out on the dataset
    python eval_demand.py --reader claude --yes   # Claude with demand.DEMAND_SCHEMA (paid: ~1 request per 20 posts)

Hugging Face readers need `transformers` (and `sentence-transformers` for hf-knn), which are not in
requirements.txt on purpose: they are only for this measurement.
================================================================================
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.path.join(HERE, "fixtures", "demand_eval.json")
TRAP_CASES = {"seller", "job_seeker", "learner", "keyword_trap", "non_tech", "generic_discussion"}


def load(path: str = DATASET) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)["examples"]


# ---- readers: each returns, per text, a dict with at least "demand" (yes|weak|no) ----------------

def rules_reader(texts: list[str], _examples=None) -> list[dict]:
    from demand import read
    return [read(t).to_dict() for t in texts]


def hf_binary_reader(model: str):
    """A yes/no purchase-intention classifier (the two models we started from)."""
    from transformers import pipeline
    clf = pipeline("text-classification", model=model, top_k=None, truncation=True)
    positive = {"yes", "intent", "label_1", "positive", "purchase"}

    def run(texts, _examples=None):
        out = []
        for scores in clf(texts, batch_size=8):
            p = sum(s["score"] for s in scores if s["label"].lower() in positive)
            out.append({"demand": "yes" if p >= 0.5 else "no", "p_yes": round(p, 3)})
        return out
    return run


ZS_ROLES = {  # hypothesis → (demand, role)
    "The author is looking for a developer, a freelancer, a consultant, a software or a technical service.": ("yes", "buyer"),
    "The author describes a business problem that software or automation could solve.": ("yes", "buyer"),
    "The author is offering or advertising their own services or product.": ("no", "seller"),
    "The author is looking for a job.": ("no", "job_seeker"),
    "The author is learning or studying.": ("no", "learner"),
    "This is a general discussion, news or an opinion.": ("no", "neutral"),
}
ZS_INTENTS = {
    "purchase": "The author wants to buy or choose a software product.",
    "service_demand": "The author needs someone to provide a technical service.",
    "project": "The author wants to start or build a project, an app or a platform.",
    "hiring": "The author wants to hire a developer, a freelancer or a technical partner.",
    "automation": "The author wants to automate a manual task or process.",
    "technical_problem": "The author has a technical problem to fix.",
    "integration": "The author wants to connect or integrate different systems.",
    "consulting": "The author is looking for expert advice or consulting.",
}


def hf_zeroshot_reader(model: str):
    """NLI zero-shot: the role among six hypotheses, then the intents as independent hypotheses."""
    from transformers import pipeline
    zs = pipeline("zero-shot-classification", model=model)

    def run(texts, _examples=None):
        out = []
        for t in texts:
            r = zs(t, list(ZS_ROLES), hypothesis_template="{}", multi_label=False)
            demand, role = ZS_ROLES[r["labels"][0]]
            intents = []
            if demand == "yes":
                ri = zs(t, list(ZS_INTENTS.values()), hypothesis_template="{}", multi_label=True)
                back = {v: k for k, v in ZS_INTENTS.items()}
                intents = [back[l] for l, s in zip(ri["labels"], ri["scores"]) if s >= 0.8]
            out.append({"demand": demand, "author_role": role, "intent_types": intents, "p_top": round(r["scores"][0], 3)})
        return out
    return run


def hf_knn_reader(model: str, k: int = 5):
    """Embeddings + k nearest labelled posts, leave-one-out: what a small labelled set already buys."""
    from sentence_transformers import SentenceTransformer
    enc = SentenceTransformer(model)
    prefix = "query: " if "e5" in model.lower() else ""

    def run(texts, examples):
        import numpy as np
        v = enc.encode([prefix + t for t in texts], normalize_embeddings=True)
        sims = v @ v.T
        out = []
        for i in range(len(texts)):
            sims[i, i] = -1
            nn = np.argsort(-sims[i])[:k]
            demand = Counter(examples[j]["demand"] for j in nn).most_common(1)[0][0]
            role = Counter(examples[j]["author_role"] for j in nn).most_common(1)[0][0]
            out.append({"demand": demand, "author_role": role, "neighbours": [int(examples[j]["id"]) for j in nn]})
        return out
    return run


def claude_reader(batch_size: int = 20):
    """Claude with the DEMAND_SCHEMA contract; the score and the removal of inventions happen in demand.from_model."""
    import anthropic
    from demand import DEMAND_SCHEMA, DEMAND_SYSTEM, from_model, taxonomy_for_prompt
    from themes import _ask_claude_json
    client = anthropic.Anthropic()

    def run(texts, _examples=None):
        out = []
        for start in range(0, len(texts), batch_size):
            chunk = texts[start:start + batch_size]
            payload = {"tassonomia": taxonomy_for_prompt(), "post": [{"id": i, "text": t} for i, t in enumerate(chunk)]}
            data = _ask_claude_json(client, DEMAND_SYSTEM, json.dumps(payload, ensure_ascii=False), DEMAND_SCHEMA)
            by_id = {r["id"]: r for r in data["results"]}
            for i, t in enumerate(chunk):
                r = by_id.get(i) or {"author_role": "neutral", "stage": "conversation"}
                out.append(from_model(t, r).to_dict())
        return out
    return run


def hybrid_reader(model_spec: str):
    """The rules veto (sellers, job seekers, learners, opinions, non-IT), a model adds the needs the rules miss."""
    model = make_reader(model_spec)

    def run(texts, examples=None):
        rules = rules_reader(texts)
        other = model(texts, examples)
        out = []
        for r, m in zip(rules, other):
            vetoed = r["author_role"] in ("seller", "job_seeker", "learner") or r["market"] != "IT" or \
                any(e["signal"] in ("opinion", "negated_ask") for e in r["evidence"])
            if r["demand"] == "no" and not vetoed and m["demand"] == "yes":
                r = {**r, "demand": "yes", "stage": "need", "author_role": "buyer", "reader": "hybrid"}
            out.append(r)
        return out
    return run


def make_reader(spec: str):
    if spec.startswith("hybrid:"):
        return hybrid_reader(spec.partition(":")[2])
    if spec == "rules":
        return rules_reader
    if spec == "claude":
        return claude_reader()
    if spec.startswith("trained:"):          # trained:models/xlmr-large+models/mmbert-base (train_demand.py)
        from train_demand import ensemble_reader
        return ensemble_reader(spec.partition(":")[2].split("+"))
    kind, _, model = spec.partition(":")
    return {"hf-binary": hf_binary_reader, "hf-zeroshot": hf_zeroshot_reader, "hf-knn": hf_knn_reader}[kind](model)


# ---- metrics -----------------------------------------------------------------------------------------

def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0}


def evaluate(examples: list[dict], preds: list[dict]) -> dict:
    from demand import STAGES
    res: dict = {"n": len(examples)}

    def binary(gold_pos, pred_pos):
        tp = sum(g and p for g, p in zip(gold_pos, pred_pos))
        fp = sum((not g) and p for g, p in zip(gold_pos, pred_pos))
        fn = sum(g and (not p) for g, p in zip(gold_pos, pred_pos))
        return prf(tp, fp, fn)

    res["demand_yes"] = binary([e["demand"] == "yes" for e in examples], [p["demand"] == "yes" for p in preds])
    res["demand_yes_or_weak"] = binary([e["demand"] != "no" for e in examples], [p["demand"] != "no" for p in preds])
    res["demand_3class_accuracy"] = round(sum(e["demand"] == p["demand"] for e, p in zip(examples, preds)) / len(examples), 3)
    traps = [(e, p) for e, p in zip(examples, preds) if e["case"] in TRAP_CASES and e["demand"] == "no"]
    res["traps_read_as_demand"] = f"{sum(p['demand'] == 'yes' for _, p in traps)}/{len(traps)}"

    if all("author_role" in p for p in preds):
        res["role_accuracy"] = round(sum(e["author_role"] == p["author_role"] for e, p in zip(examples, preds)) / len(examples), 3)
    if all("intent_types" in p for p in preds):
        tp = fp = fn = 0
        for e, p in zip(examples, preds):
            g, q = set(e["intents"]) if e["demand"] != "no" else set(), set(p["intent_types"])
            tp, fp, fn = tp + len(g & q), fp + len(q - g), fn + len(g - q)
        res["intents_micro"] = prf(tp, fp, fn)
    if all("stage" in p for p in preds):
        idx = {s: i for i, s in enumerate(STAGES)}
        res["stage_accuracy"] = round(sum(e["stage"] == p["stage"] for e, p in zip(examples, preds)) / len(examples), 3)
        res["stage_within_one"] = round(sum(abs(idx[e["stage"]] - idx[p["stage"]]) <= 1 for e, p in zip(examples, preds)) / len(examples), 3)
    if all("taxonomy_path" in p for p in preds):
        with_market = [(e, p) for e, p in zip(examples, preds) if e["market"]]
        from demand import default_taxonomy
        tax = default_taxonomy()

        def top(node):
            path = tax.path(node) if node else []
            return path[1]["id"] if len(path) > 1 else (path[0]["id"] if path else None)
        res["market_exact"] = round(sum(e["market"] == p["taxonomy_node"] for e, p in with_market) / len(with_market), 3)
        res["market_top_level"] = round(sum(top(e["market"]) == top(p["taxonomy_node"]) for e, p in with_market) / len(with_market), 3)
    if all("lead_score" in p for p in preds):
        top_leads = [(e, p) for e, p in zip(examples, preds) if p["lead_score"] >= 75]
        res["top_leads_precision"] = f"{sum(e['demand'] == 'yes' for e, _ in top_leads)}/{len(top_leads)}"
        res["top_leads_recall_of_high_intent"] = f"{sum(p['lead_score'] >= 75 for e, p in zip(examples, preds) if e['stage'] in ('high_intent', 'active_project'))}/" \
                                                 f"{sum(e['stage'] in ('high_intent', 'active_project') for e in examples)}"
    return res


def errors(examples: list[dict], preds: list[dict]) -> list[str]:
    lines = []
    for e, p in zip(examples, preds):
        bad = [f"demand {e['demand']}→{p['demand']}"] if e["demand"] != p["demand"] else []
        if "author_role" in p and e["author_role"] != p["author_role"]:
            bad.append(f"role {e['author_role']}→{p['author_role']}")
        if "stage" in p and e["stage"] != p["stage"]:
            bad.append(f"stage {e['stage']}→{p['stage']}")
        if bad:
            lines.append(f"#{e['id']:>3} [{e['case']}] {'; '.join(bad)}\n      {e['text'][:110]}")
    return lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[2])
    ap.add_argument("--reader", default="rules")
    ap.add_argument("--dataset", default=DATASET)
    ap.add_argument("--lang", choices=["it", "en"])
    ap.add_argument("--errors", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--yes", action="store_true", help="confirm the Claude requests (reader 'claude')")
    a = ap.parse_args(argv)
    examples = [e for e in load(a.dataset) if not a.lang or e["lang"] == a.lang]
    if a.reader == "claude" and not a.yes:
        print(f"Claude: {-(-len(examples) // 20)} requests for {len(examples)} posts. Add --yes to run them.")
        return 0
    preds = make_reader(a.reader)([e["text"] for e in examples], examples)
    res = {"reader": a.reader, **evaluate(examples, preds)}
    print(json.dumps(res, ensure_ascii=False, indent=None if a.json else 2))
    if a.errors:
        print("\n".join(errors(examples, preds)) or "nessun errore")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    sys.exit(main())
