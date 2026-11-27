"""
================================================================================
BuyerML — Queries for the first collection of real posts (demand.py)
================================================================================
The structure that converts best so far (field experience): a direct search verb + the object, short
exact phrases — site:facebook.com/groups "stiamo cercando" "sviluppatore Laravel". These are the A1
expressions of seed.json crossed with IT objects of the taxonomy (it_taxonomy.json).

Writes a commands CSV in the format of autocomplete_dorking.py, executed by dork_runner.py, which
saves every result in buyerml.db and never spends without --yes:

    python demand_queries.py --csv demand_dorks.csv                       # 5 verbs x 50 objects
    python dork_runner.py demand_dorks.csv --channel facebook_groups --max 20          # estimate
    python dork_runner.py demand_dorks.csv --channel facebook_groups --max 20 --yes    # run

Order: every object with the first verb, then every object with the second, and so on, so that a
partial run (--max) already covers all the objects.
================================================================================
"""

from __future__ import annotations

import argparse
import csv
import json

from demand import default_taxonomy, match_market
from dorking import facebook_query

ORIGIN = "raccolta_domanda"

# The direct, transactional search verbs (A1). "offriamo collaborazione", "lavoro remoto" and
# "si ricerca" are left out on purpose: they bring sellers and job ads (measured with demand.read).
VERBS = ("stiamo cercando", "sto cercando", "cerchiamo", "cerco", "cercasi")

# The objects: what is being searched for, in the words people write. Each one must be recognised
# by the taxonomy (test_demand_pipeline.py checks it), so a new object is a new alias first.
OBJECTS = (
    # people
    "sviluppatore", "programmatore", "software house", "web developer", "sviluppatore app",
    "sviluppatore Laravel", "programmatore PHP", "sviluppatore Python", "sviluppatore Java",
    "sviluppatore React", "sviluppatore Node", "sviluppatore Flutter", "sviluppatore iOS", "sviluppatore Android",
    "sviluppatore full stack", "sviluppatore backend", "sviluppatore blockchain", "sviluppatore Solidity",
    "sistemista", "consulente informatico", "penetration tester", "data analyst", "esperto di intelligenza artificiale",
    # things
    "gestionale", "gestionale su misura", "software su misura", "app mobile", "sito web", "sito e-commerce",
    "CRM", "ERP", "Odoo", "Shopify", "WordPress", "chatbot", "agente AI", "automazione", "n8n", "Zapier", "RPA",
    "integrazione API", "smart contract", "web3", "sicurezza informatica", "cloud", "AWS", "DevOps",
    "database", "Power BI", "firmware",
)


def commands(verbs=VERBS, objects=OBJECTS) -> list[dict]:
    """One row per (verb, object), in the order described above, in the dork_runner.py CSV format."""
    tax = default_taxonomy()
    rows = []
    for verb in verbs:
        for obj in objects:
            node = match_market(obj, tax)["node"]
            rows.append({
                "search_text": facebook_query(verb, obj),
                "channel": "facebook_groups",
                "combination_id": f"demand|{verb}|{obj}",
                "intents": verb,
                "categories": json.dumps({"taxonomy_node": node, "object": obj}, ensure_ascii=False),
                "trend_word": "",
                "discard_words": "",
                "origin_trend": ORIGIN,
            })
    return rows


def write_csv(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description="Queries for the first collection of real posts")
    ap.add_argument("--csv", default="demand_dorks.csv")
    ap.add_argument("--verbs", type=int, default=len(VERBS), help="use only the first N verbs")
    a = ap.parse_args()
    rows = commands(VERBS[:a.verbs])
    write_csv(rows, a.csv)
    print(f"{len(rows)} queries ({a.verbs} verbs x {len(OBJECTS)} objects) written to {a.csv}")
    print(f"Next: python dork_runner.py {a.csv} --channel facebook_groups --max 20   (estimate, nothing spent)")


if __name__ == "__main__":
    main()
