#!/usr/bin/env python3
"""Load a demonstration dataset.

    python scripts/seed_demo.py

IMPORTANT: every person, company and article below is FICTIONAL. This app builds
profiles of identifiable living people when it runs for real, so demonstration
data must never contain unverified claims about actual individuals.

The records are produced by running the *real* extraction, estimation and
confidence code over invented articles, so what you see is exactly what the
pipeline does — not hand-written numbers.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json  # noqa: E402

from wealthscan import db  # noqa: E402
from wealthscan.extract import extract_event  # noqa: E402
from wealthscan.report import generate_and_store  # noqa: E402
from wealthscan.research import _store_event  # noqa: E402
from wealthscan.scoring import cohort_for, estimate_from_event, score_confidence  # noqa: E402
from wealthscan.sources import Fetcher  # noqa: E402

NOW = datetime.now(timezone.utc)


def days_ago(n: int) -> datetime:
    return NOW - timedelta(days=n)


# (title, summary, publisher, days_ago, query_event_key)
ARTICLES: list[tuple[str, str, str, int, str | None]] = [
    (
        "Exeter engineering group Halberton Precision Ltd acquired by German rival for £64m",
        "Chairman Gareth Halberton has sold the business he founded in 1999. The Devon "
        "manufacturer employs 380 people at its Marsh Barton site.",
        "BusinessLive South West", 2, "acquisition",
    ),
    (
        "Marlborough Clinical Holdings Ltd sold to Ardenhall for £210m",
        "Founder Alastair Wren completes sale of the Wiltshire diagnostics group after "
        "fourteen years. The transaction is the largest healthcare deal in the county this year.",
        "Insider Media South West", 4, "business_exit",
    ),
    (
        "Shoreditch Creative Holdings Ltd: founder nets £96m as Havas Lane takes majority",
        "Nathaniel Osei, founder of the London agency group, has sold his stake in a deal "
        "completed this month.",
        "The Times", 5, "business_exit",
    ),
    (
        "Reading fintech Thameside Payments Ltd raises £62m Series C",
        "Co-founder and CEO Yusuf Karadag said the Berkshire company would use the round "
        "to expand into Europe. Northgate Capital led the investment round.",
        "UKTN", 3, "venture_funding",
    ),
    (
        "Oxford biotech Wytham Bio Ltd secures £54m Series B",
        "Chief Scientific Officer Eleanor Wytham co-founded the Oxfordshire company in 2020. "
        "The funding round was co-led by Wellcome Growth.",
        "UKTN", 6, "venture_funding",
    ),
    (
        "Falmouth marine group declares £4.05m dividend to shareholders",
        "Trevanning Marine Systems Ltd, the Cornwall boatbuilder led by founder Imogen "
        "Trevanning, reported a record year. The director dividend is its largest to date.",
        "BusinessLive South West", 8, "large_dividend",
    ),
    (
        "Sandbanks developer buys Dorset waterfront estate",
        "Marianne Delacroix, director of Sandbanks Property Partners Ltd, has acquired the "
        "site for an undisclosed sum.",
        "The Business Magazine", 9, "property",
    ),
    (
        "Guildford diagnostics chief steps down after twelve years",
        "Anita Rajaram, chief executive of the Surrey group, will hand over in the autumn as "
        "part of a planned succession.",
        "Insider Media South East", 11, "succession",
    ),
    (
        "Wiltshire family investment company registered by Marlborough entrepreneur",
        "A new family office has been established by Alastair Wren following the sale of his "
        "clinical diagnostics group.",
        "Insider Media South West", 1, "family_office",
    ),
    (
        "Somerset renewables group Quantock Renewables Group Ltd backed by private equity",
        "Meridian Growth Partners has taken a minority stake in the Taunton company valued at "
        "£118m. Founder Priya Nadkarni retains control.",
        "Insider Media South West", 12, "private_equity",
    ),
    (
        "Hampshire chip designer Solent Semiconductor Ltd eyes £280m AIM listing",
        "Founder Rowan Fitzhugh has appointed brokers ahead of a possible flotation on the "
        "London market.",
        "UKTN", 7, "ipo",
    ),
    (
        "Bristol logistics group reports record profits",
        "Avonmouth Logistics Holdings Ltd saw turnover rise to £128m. Managing director "
        "Duncan Avonmouth said the year had been the strongest in the company's history.",
        "BusinessLive South West", 14, "company_growth",
    ),
    (
        "West Sussex chemicals firm sold in management buyout",
        "Horsham Speciality Chemicals Ltd has been acquired by its management team for £41m. "
        "Chief executive Beatrice Haldane led the buyout.",
        "Insider Media South East", 10, "management_buyout",
    ),
    (
        "Gloucestershire food group turnover climbs",
        "Cotswold Provisions Group Ltd, based in Cirencester, grew sales again this year.",
        "BusinessLive South West", 16, "company_growth",
    ),
    # Deliberately unattributable: a real transaction with no individual named.
    # The pipeline must record it as a company lead, not invent a person.
    (
        "Plymouth robotics company acquired for £30m",
        "The Devon business has been bought by an international group. Terms were disclosed "
        "but no individual shareholders were named.",
        "BusinessLive South West", 6, "acquisition",
    ),
]


def verify_demo_record(
    *, name: str, company_number: str, officer_name: str, ownership_band: str,
    amount_gbp: int, publisher: str,
) -> None:
    """Apply a Companies House verification the way a real run would."""
    estimate = estimate_from_event(
        event_key="business_exit",
        amount_gbp=amount_gbp,
        text="sold the business",
        has_named_person=True,
        known_stake_band=ownership_band,
    )
    confidence = score_confidence(
        publisher=publisher, has_named_person=True, amount_disclosed=True,
        source_count=1, event_weight=95,
        stake_verified=True, companies_house_verified=True,
    )

    with db.connect() as conn:
        row = conn.execute(
            "SELECT id FROM prospects WHERE full_name = ?", (name,)
        ).fetchone()
        if not row:
            return
        conn.execute(
            """UPDATE prospects SET
                   ch_company_number = ?, ch_officer_name = ?, ch_ownership_band = ?,
                   ch_verified_at = ?,
                   gross_low_gbp = ?, gross_mid_gbp = ?, gross_high_gbp = ?,
                   investable_low_gbp = ?, investable_mid_gbp = ?, investable_high_gbp = ?,
                   wealth_band = ?, cohort = ?, estimate_method = ?, estimate_caveats = ?,
                   confidence = ?, confidence_band = ?, confidence_detail = ?,
                   next_action = ?, last_updated = ?
               WHERE id = ?""",
            (
                company_number, officer_name, ownership_band, db.now_iso(),
                estimate.gross_low_gbp, estimate.gross_mid_gbp, estimate.gross_high_gbp,
                estimate.investable_low_gbp, estimate.investable_mid_gbp,
                estimate.investable_high_gbp,
                estimate.band,
                cohort_for(estimate.investable_mid_gbp, estimate.gross_mid_gbp),
                estimate.method, json.dumps(estimate.caveats),
                confidence.score, confidence.band,
                json.dumps([
                    {"label": d.label, "score": d.score, "weight": d.weight, "why": d.explanation}
                    for d in confidence.dimensions
                ]),
                confidence.next_action, db.now_iso(), row["id"],
            ),
        )
        db.add_event(
            conn, int(row["id"]), "verified",
            f"Shareholding confirmed on the Companies House PSC register: "
            f"{ownership_band} of Halberton Precision Engineering Ltd. The estimate "
            f"has been re-derived from the filed band.",
            f"https://find-and-update.company-information.service.gov.uk/company/{company_number}",
        )


def main() -> int:
    db.init_db()
    fetcher = Fetcher(delay=0.0)  # nothing is fetched; the articles are inline

    created = updated = leads = skipped = 0

    for index, (title, summary, publisher, ago, event_key) in enumerate(ARTICLES):
        event = extract_event(
            title=title,
            summary=summary,
            url=f"https://example.invalid/demo/{index}",
            publisher=publisher,
            published_at=days_ago(ago),
            query_event_key=event_key,
        )
        if event is None:
            skipped += 1
            print(f"  skipped (no region or no event): {title[:60]}")
            continue

        outcome = _store_event(event, fetcher=fetcher, verify_ch=False)
        kind = outcome["kind"]
        if kind == "new":
            created += 1
            print(f"  + {outcome['name']:22} {event.region:16} {event.event_label}")
        elif kind == "updated":
            updated += 1
            print(f"  ~ {outcome['name']:22} corroborated with {event.event_label}")
        else:
            leads += 1
            print(f"  · company-level lead only (no individual named): {title[:50]}")

    # One record verified against Companies House, so the difference between an
    # assumed stake and a filed one is visible in the UI. The estimate is
    # *recomputed* with the filed band rather than patched — otherwise the record
    # would claim the stake is confirmed while still showing a figure derived
    # from the assumption, and its caveats would contradict its own header.
    verify_demo_record(
        name="Gareth Halberton",
        company_number="07890123",
        officer_name="HALBERTON, Gareth John",
        ownership_band="50–75%",
        amount_gbp=64_000_000,
        publisher="BusinessLive South West",
    )

    with db.connect() as conn:

        run_id = db.start_run(conn, "demo-seed")
        db.finish_run(
            conn, run_id, status="success", queries_run=182,
            articles_seen=len(ARTICLES), events_kept=created + updated,
            new_prospects=created, updated_prospects=updated,
            warnings=[], log=[f"Demonstration dataset — {created} fictional prospects"],
        )

    payload, _ = generate_and_store()

    print()
    print(f"Created {created} prospects, corroborated {updated}, "
          f"{leads} company-level lead(s), {skipped} article(s) rejected.")
    print(f"Research document written for {payload['week']}.")
    print()
    print("Every person and company in this dataset is FICTIONAL.")
    print("Start the dashboard with:  streamlit run streamlit_app.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
