#!/usr/bin/env python3
"""Weekly research sweep, for a scheduler.

    python scripts/run_research.py                  # last 7 days, all counties
    python scripts/run_research.py --days 30        # wider first run
    python scripts/run_research.py --verify         # add Companies House checks
    python scripts/run_research.py --if-due         # skip if already run this week

Schedule it for Monday morning:

    0 7 * * 1 cd /path/to/ca_dashboard && python3 scripts/run_research.py --if-due
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wealthscan import db  # noqa: E402
from wealthscan.report import generate_and_store  # noqa: E402
from wealthscan.research import run_research  # noqa: E402
from wealthscan.sources import companies_house_available  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Weekly prospect research sweep")
    parser.add_argument("--days", type=int, default=7, help="How far back to look")
    parser.add_argument("--verify", action="store_true", help="Verify against Companies House")
    parser.add_argument("--if-due", action="store_true", help="Skip if a sweep already ran this week")
    parser.add_argument("--max-queries", type=int, default=0, help="Cap the number of searches")
    parser.add_argument("--no-publishers", action="store_true", help="Skip the publisher feed sweep")
    args = parser.parse_args()

    db.init_db()

    if args.if_due:
        with db.connect() as conn:
            if not db.run_due_this_week(conn):
                print(f"A sweep has already run in {db.iso_week()}. Nothing to do.")
                return 0

    if args.verify and not companies_house_available():
        print("--verify was requested but COMPANIES_HOUSE_API_KEY is not set; continuing without it.")

    print(f"Starting research sweep for {db.iso_week()} (looking back {args.days} days)…")

    def progress(message: str, fraction: float) -> None:
        print(f"  [{fraction * 100:5.1f}%] {message}", flush=True)

    result = run_research(
        trigger="scheduled",
        days=args.days,
        verify_companies_house=args.verify,
        include_publishers=not args.no_publishers,
        max_queries=args.max_queries or None,
        progress=progress,
    )

    print()
    print(f"Status:            {result.status}  ({result.duration_seconds:.0f}s)")
    print(f"Searches run:      {result.queries_run}")
    print(f"Articles read:     {result.articles_seen}")
    print(f"Events kept:       {result.events_kept}")
    print(f"New prospects:     {result.new_prospects}")
    print(f"Corroborated:      {result.updated_prospects}")
    print(f"Company-only leads:{result.company_leads}")

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
