"""
================================================================================
BuyerML — Dork runner (link 15: Layer 2 -> saved contacts)
================================================================================
Executes dorking commands on Google (SerpApi, one search per command) and saves
every result — the post or page where someone states a need — as a lead in
buyerml.db. Commands already executed are skipped.

    python autocomplete_dorking.py "chatbot whatsapp" --csv dorks.csv
    python dork_runner.py dorks.csv --channel facebook_groups --max 10          # estimate only
    python dork_runner.py dorks.csv --channel facebook_groups --max 10 --yes    # run
    python dork_runner.py --export-leads leads.csv
================================================================================
"""

from __future__ import annotations

import argparse
import csv

import requests

import buyerml_seo_aeo_workflow as wf
from buyerml_store import SEARCHED_CHANNELS, Store, channel_of, on_channel


def search_google(search_text: str) -> list[dict]:
    """Organic results of one dork: url, title, snippet."""
    params = {
        "engine": "google",
        "q": search_text,
        "hl": wf.LANGUAGE,
        "gl": wf.AREA.lower(),
        "google_domain": wf.GOOGLE_DOMAIN,
        "api_key": wf.SERPAPI_KEY,
    }
    # one automatic retry on timeout: SerpApi usually finishes the search and
    # serves the retry from its cache (Phase 1: Facebook groups, 3 of 4 timed out)
    for attempt in (1, 2):
        try:
            resp = requests.get(wf.SERPAPI_BASE_URL, params=params, timeout=60)
            break
        except requests.Timeout:
            if attempt == 2:
                raise
    resp.raise_for_status()
    return [
        {"url": r["link"], "title": r.get("title", ""), "snippet": r.get("snippet", "")}
        for r in resp.json().get("organic_results", []) if r.get("link")
    ]


def load_commands(path: str, channel: str | None = None) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if not channel or r["channel"] == channel]


def run_commands(commands: list[dict], store: Store, max_searches: int, search=None) -> dict:
    """
    Executes up to max_searches commands not yet executed. One SerpApi search each.
    search: the function that searches (default search_google; the interface's demo passes a fake).
    """
    search = search or search_google
    summary = {"executed": 0, "skipped": 0, "results": 0, "relabelled": 0, "off_channel": 0, "new_leads": 0,
               "failed": []}
    for cmd in commands:
        if summary["executed"] + len(summary["failed"]) >= max_searches:
            break
        if store.was_executed(cmd["search_text"]):
            summary["skipped"] += 1
            continue
        try:
            results = search(cmd["search_text"])
        except requests.RequestException as e:
            # counted against the budget (it may have been billed), not saved: it can run again later
            summary["failed"].append({"search_text": cmd["search_text"], "error": str(e)})
            continue
        # Google often ignores site:. A result on the other searched channel (a LinkedIn post
        # found by a Facebook dork) is kept with its real channel; any other site is dropped.
        kept, off = [], 0
        for r in results:
            if on_channel(r["url"], cmd.get("channel", "")):
                kept.append(r)
            elif (real := channel_of(r["url"])) in SEARCHED_CHANNELS:
                kept.append({**r, "channel": real})
                summary["relabelled"] += 1
            else:
                off += 1
        summary["executed"] += 1
        summary["results"] += len(kept)
        summary["off_channel"] += off
        summary["new_leads"] += store.save_search(cmd, kept, off_channel=off)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Execute dorks and save leads")
    parser.add_argument("csv", nargs="?", help="commands CSV from autocomplete_dorking.py --csv")
    parser.add_argument("--channel", help="only this channel, e.g. facebook_groups")
    parser.add_argument("--max", type=int, default=10, help="max SerpApi searches (default 10)")
    parser.add_argument("--yes", action="store_true", help="confirm spending the searches")
    parser.add_argument("--export-leads", metavar="CSV", help="write all saved leads to a CSV and exit")
    args = parser.parse_args()

    store = Store()
    if args.export_leads:
        print(f"{store.export_leads_csv(args.export_leads)} leads written to {args.export_leads}")
        return
    if not args.csv:
        parser.error("commands CSV required")

    commands = load_commands(args.csv, args.channel)
    pending = [c for c in commands if not store.was_executed(c["search_text"])]
    to_run = min(args.max, len(pending))
    print(f"{len(commands)} commands, {len(pending)} not yet executed -> {to_run} SerpApi searches")
    if wf.MOCK_MODE:
        print("MOCK_MODE is on: run with MOCK_MODE=false to execute real searches.")
        return
    if not args.yes:
        print("Nothing sent. Re-run with --yes to proceed.")
        return

    summary = run_commands(pending, store, args.max)
    print(f"Executed {summary['executed']}, results kept {summary['results']} "
          f"({summary['relabelled']} moved to their real channel, {summary['off_channel']} dropped: other sites), "
          f"new leads {summary['new_leads']}")
    for f in summary["failed"]:
        print(f"  failed: {f['search_text']} — {f['error'][:150]}")
    print(f"Database: {store.path}")


if __name__ == "__main__":
    main()
