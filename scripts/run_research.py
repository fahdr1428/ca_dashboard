#!/usr/bin/env python3
"""Research sweep, for a scheduler.

    python scripts/run_research.py                          # deep, UK + US + Middle East
    python scripts/run_research.py --depth standard         # faster
    python scripts/run_research.py --preset Everywhere      # all 70 markets
    python scripts/run_research.py --markets uk-devon uk-london
    python scripts/run_research.py --verify                 # add Companies House checks
    python scripts/run_research.py --if-due                 # skip if already run this week
    python scripts/run_research.py --plan                   # cost it without running it

Schedule it for Monday morning:

    0 7 * * 1 cd /path/to/ca_dashboard && python3 scripts/run_research.py --if-due
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wealthscan import db  # noqa: E402
from wealthscan.markets import DEFAULT_PRESET, PRESETS, expand_selection  # noqa: E402
from wealthscan.queries import DEFAULT_DEPTH, DEPTHS, plan_sweep  # noqa: E402
from wealthscan.report import generate_and_store  # noqa: E402
from wealthscan.research import run_research  # noqa: E402
from wealthscan.sources import companies_house_available  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Prospect research sweep")
    parser.add_argument("--depth", default=DEFAULT_DEPTH, choices=[d.key for d in DEPTHS],
                        help="How hard to look (default: %(default)s)")
    parser.add_argument("--preset", default=DEFAULT_PRESET, choices=list(PRESETS),
                        help="Which markets to search (default: %(default)s)")
    parser.add_argument("--markets", nargs="*", default=None,
                        help="Specific market keys, overriding --preset")
    parser.add_argument("--days", type=int, default=0,
                        help="Force one look-back window instead of the depth's own")
    parser.add_argument("--minutes", type=int, default=0,
                        help="Stop after this many minutes; 0 means no limit")
    parser.add_argument("--verify", action="store_true", help="Verify against Companies House")
    parser.add_argument("--if-due", action="store_true", help="Skip if a sweep already ran this week")
    parser.add_argument("--max-queries", type=int, default=0, help="Cap the number of searches")
    parser.add_argument("--no-publishers", action="store_true", help="Skip the publisher feed sweep")
    parser.add_argument("--plan", action="store_true", help="Print the cost and exit")
    args = parser.parse_args()

    markets = expand_selection(args.markets or PRESETS[args.preset])

    plan = plan_sweep(
        market_keys=markets, depth=args.depth, days=args.days or None,
        include_publishers=not args.no_publishers,
        max_queries=args.max_queries or None,
    )
    print(f"{plan.queries:,} searches across {plan.markets} markets "
          f"({plan.events} event types, {plan.windows} window(s)) — {plan.human_time}.")
    if args.plan:
        return 0

    db.init_db()

    if args.if_due:
        with db.connect() as conn:
            if not db.run_due_this_week(conn):
                print(f"A sweep has already run in {db.iso_week()}. Nothing to do.")
                return 0

    if args.verify and not companies_house_available():
        print("--verify was requested but COMPANIES_HOUSE_API_KEY is not set; "
              "continuing without it.")

    print(f"Starting {args.depth} sweep for {db.iso_week()}…")

    last_percent = -5.0

    def progress(message: str, fraction: float) -> None:
        # One line per 5% rather than per query: a deep sweep is thousands of
        # searches and a log line each would be unreadable in a cron mail.
        nonlocal last_percent
        percent = fraction * 100
        if percent - last_percent >= 5:
            last_percent = percent
            print(f"  [{percent:5.1f}%] {message}", flush=True)

    result = run_research(
        trigger="scheduled",
        depth=args.depth,
        market_keys=markets,
        days=args.days or None,
        verify_companies_house=args.verify,
        include_publishers=not args.no_publishers,
        max_queries=args.max_queries or None,
        time_budget_seconds=(args.minutes * 60) if args.minutes else None,
        progress=progress,
    )

    print()
    print(f"Status:             {result.status}  ({result.duration_seconds / 60:.1f} min)")
    print(f"Searches run:       {result.queries_run:,} of {result.queries_planned:,}")
    print(f"Articles read:      {result.articles_seen:,}")
    print(f"Events kept:        {result.events_kept}")
    print(f"Articles rejected:  {result.rejected}")
    print(f"New prospects:      {result.new_prospects}")
    print(f"Corroborated:       {result.updated_prospects}")
    print(f"Company-only leads: {result.company_leads}")

    for line in result.log:
        print(f"  + {line}")

    if result.warnings:
        print(f"\n{len(result.warnings)} warning(s) — sources that could not be read:")
        for warning in result.warnings[:20]:
            print(f"  ! {warning}")

    payload, _ = generate_and_store()
    print(f"\nResearch document written for {payload['week']}: "
          f"{payload['totals']['new_this_week']} new, "
          f"{payload['totals']['qualifying']} qualifying.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
