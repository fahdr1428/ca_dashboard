"""The research run.

One function, `run_research`, does the whole sweep: build the query matrix, fetch
every feed, extract events, score them, and write prospects with their sources.
It is safe to run repeatedly — URLs already processed are skipped, and an
existing prospect is only revised when the new evidence is at least as good.

The run is deliberately allowed to take a long time. Yield comes from breadth:
more markets, more towns folded into each query, more windows. What it must never
do is trade accuracy for volume, so every article still has to name a wealth
event, and geography is still checked rather than assumed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from . import db
from .evidence import classify_source, grade_record
from .exclusions import screen
from .extract import ExtractedEvent, extract_event
from .markets import MARKET_BY_KEY, expand_selection
from .queries import (
    DEFAULT_DEPTH,
    DEPTH_BY_KEY,
    EVENT_BY_KEY,
    PUBLISHER_FEEDS,
    build_search_matrix,
)
from .scoring import cohort_for, estimate_from_event, score_confidence
from .sources import Fetcher, fetch_feed, verify_with_companies_house

#: ``(message, fraction_complete)``
ProgressCallback = Callable[[str, float], None]


@dataclass
class RunResult:
    run_id: int
    week: str
    status: str
    depth: str = DEFAULT_DEPTH
    markets: tuple[str, ...] = ()
    queries_planned: int = 0
    queries_run: int = 0
    articles_seen: int = 0
    events_kept: int = 0
    new_prospects: int = 0
    updated_prospects: int = 0
    company_leads: int = 0
    rejected: int = 0
    excluded: int = 0
    warnings: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0
    stopped_early: bool = False


def run_research(
    *,
    trigger: str = "manual",
    depth: str = DEFAULT_DEPTH,
    market_keys: list[str] | tuple[str, ...] | None = None,
    days: int | None = None,
    event_keys: list[str] | None = None,
    include_publishers: bool | None = None,
    verify_companies_house: bool = False,
    max_queries: int | None = None,
    time_budget_seconds: float | None = None,
    progress: ProgressCallback | None = None,
) -> RunResult:
    """Sweep the sources and update the book.

    ``time_budget_seconds`` stops the run cleanly when the budget is spent rather
    than being killed halfway through: everything found so far is already stored,
    and the run is recorded as partial so the report can say it was cut short.
    """
    started = datetime.now(timezone.utc)
    db.init_db()
    fetcher = Fetcher()

    settings = DEPTH_BY_KEY.get(depth, DEPTH_BY_KEY[DEFAULT_DEPTH])
    markets = expand_selection(market_keys)
    publishers_on = (
        settings.include_publishers if include_publishers is None else include_publishers
    )

    matrix = build_search_matrix(
        market_keys=markets, depth=depth, event_keys=event_keys, days=days
    )
    if max_queries:
        matrix = matrix[:max_queries]

    #: ``(url, publisher, event_key, market_key)`` — a publisher feed has no
    #: market context, so anything it turns up must locate itself from its text.
    feeds: list[tuple[str, str, str | None, str | None]] = [
        (q.url, "Google News", q.event_key, q.market_key) for q in matrix
    ]
    if publishers_on:
        feeds += [(url, name, None, None) for name, url in PUBLISHER_FEEDS]

    with db.connect() as conn:
        run_id = db.start_run(conn, trigger, depth=depth, markets=list(markets),
                              queries_planned=len(feeds))

    result = RunResult(
        run_id=run_id, week=db.iso_week(started), status="running",
        depth=depth, markets=tuple(markets), queries_planned=len(feeds),
    )
    ch_disabled_reason: str | None = None

    for index, (url, publisher, event_key, market_key) in enumerate(feeds):
        if time_budget_seconds is not None:
            spent = (datetime.now(timezone.utc) - started).total_seconds()
            if spent > time_budget_seconds:
                result.stopped_early = True
                result.warnings.append(
                    f"Stopped after {spent / 60:.0f} minutes with "
                    f"{len(feeds) - index} of {len(feeds)} searches unrun — the time "
                    f"budget was reached. Everything found so far is saved; run again "
                    f"to continue, as processed articles are skipped."
                )
                break

        if progress:
            where = MARKET_BY_KEY[market_key].name if market_key else publisher
            progress(
                f"{where} · {EVENT_BY_KEY[event_key].label if event_key else 'broad sweep'}"
                f"  ({index + 1} of {len(feeds)}) · {result.new_prospects} found",
                (index + 1) / max(len(feeds), 1),
            )

        articles, warning = fetch_feed(fetcher, url, publisher=publisher)
        result.queries_run += 1
        if warning:
            # One line per failing host, not per query: a blocked publisher would
            # otherwise fill the log with hundreds of identical entries.
            host = warning.split(":")[0]
            if not any(w.startswith(host) for w in result.warnings):
                result.warnings.append(warning)
            continue

        result.articles_seen += len(articles)

        for article in articles:
            with db.connect() as conn:
                # Skip anything already processed in an earlier run.
                if not db.mark_seen(conn, article.url):
                    continue

            event = extract_event(
                title=article.title,
                summary=article.summary,
                url=article.url,
                publisher=article.publisher or publisher,
                published_at=article.published_at,
                query_event_key=event_key,
                query_market_key=market_key,
                allowed_markets=markets,
            )
            if event is None:
                result.rejected += 1
                continue

            # Screen before a record can exist. A prospect that is created and
            # then hidden still turns up in exports, totals and screenshots.
            refusal = screen(
                text=f"{event.title} {event.summary}",
                person_name=event.people[0].name if event.people else None,
                job_title=event.people[0].title if event.people else None,
                url=event.url,
            )
            if refusal is not None:
                result.excluded += 1
                with db.connect() as conn:
                    db.record_exclusion(conn, {
                        "rule": refusal.rule,
                        "reason": refusal.reason,
                        "person_name": event.people[0].name if event.people else None,
                        "company": event.company,
                        "title": event.title,
                        "url": event.url,
                        "publisher": event.publisher,
                    })
                continue

            result.events_kept += 1
            outcome = _store_event(
                event,
                fetcher=fetcher,
                verify_ch=verify_companies_house and ch_disabled_reason is None,
            )

            if outcome.get("ch_warning"):
                warning_text = str(outcome["ch_warning"])
                # A key problem is systemic; report it once and stop retrying.
                if "rejected the key" in warning_text or "unreachable" in warning_text:
                    ch_disabled_reason = warning_text
                    result.warnings.append(
                        f"Companies House verification disabled: {warning_text}"
                    )

            if outcome["kind"] == "new":
                result.new_prospects += 1
                result.log.append(
                    f"New · {outcome['name']} · {event.market_name} · {event.event_label}"
                    + (f" · {event.publisher}" if event.publisher else "")
                )
            elif outcome["kind"] == "updated":
                result.updated_prospects += 1
            elif outcome["kind"] == "company_lead":
                result.company_leads += 1

    if result.stopped_early:
        result.status = "partial"
    else:
        result.status = "success" if not result.warnings else "partial"
    result.duration_seconds = (datetime.now(timezone.utc) - started).total_seconds()

    with db.connect() as conn:
        db.finish_run(
            conn, run_id,
            status=result.status,
            queries_run=result.queries_run,
            articles_seen=result.articles_seen,
            events_kept=result.events_kept,
            new_prospects=result.new_prospects,
            updated_prospects=result.updated_prospects,
            company_leads=result.company_leads,
            warnings=result.warnings,
            log=result.log,
        )
    return result


#: Which of the brief's four wealth sources an event evidences. Land and estate
#: wealth is called out separately because it is the one a news-driven tool would
#: otherwise never surface — it generates no funding rounds and no tech press.
WEALTH_SOURCE: dict[str, str] = {
    "business_exit": "Liquidity event",
    "acquisition": "Liquidity event",
    "management_buyout": "Liquidity event",
    "windfall": "Liquidity event",
    "share_sale": "Liquidity event",
    "ipo": "Liquidity event",
    "private_equity": "Liquidity event",
    "venture_funding": "Private company ownership",
    "large_dividend": "Private company ownership",
    "company_growth": "Private company ownership",
    "family_office": "Private company ownership",
    "succession": "Succession or inheritance",
    "exec_comp": "Listed-company pay or shareholding",
    "land_sale": "Land, estate or farming",
    "landholding": "Land, estate or farming",
    "property": "Property",
    "rich_list": "Rich-list inclusion",
}

#: Suffixes that mark a listed company. Anything else filed at Companies House is
#: treated as private, which is right far more often than not.
_LISTED_MARKERS = ("plc", "p.l.c", "public limited", "pjsc", " inc", " corp")


def _company_status(event: ExtractedEvent, ch_match) -> str | None:
    """Public or private, from the company's own name where it can be told."""
    name = (ch_match.company_name if ch_match else event.company) or ""
    if not name:
        return None
    lowered = name.lower()
    if any(marker in lowered for marker in _LISTED_MARKERS):
        return "Public"
    if event.event_key in ("ipo", "exec_comp", "share_sale"):
        # These events only happen to companies with traded shares.
        return "Public"
    return "Private"


def _store_event(
    event: ExtractedEvent, *, fetcher: Fetcher, verify_ch: bool
) -> dict[str, object]:
    """Persist one event against a prospect, creating the record if needed."""
    ch_warning: str | None = None
    ch_match = None

    if not event.people:
        # No individual named. Still worth recording as a company-level lead, but
        # it is not a prospect — inventing a name would be worse than useless.
        return {"kind": "company_lead", "name": event.company or event.title, "ch_warning": None}

    person = event.people[0]

    # Companies House is the *UK* register. Running a Dubai or Texas company
    # through it would either find nothing or, worse, find a same-named British
    # company and attach the wrong number to a real person.
    if verify_ch and event.company and event.country == "United Kingdom":
        ch_match, ch_warning = verify_with_companies_house(
            fetcher, company_name=event.company, person_name=person.name
        )

    stake_verified = bool(ch_match and ch_match.ownership_band)

    # Grading happens on the citation, and a Companies House confirmation is a
    # filing rather than a news report — so a verified record is graded High even
    # though it was discovered from press.
    tier = classify_source(url=event.url, publisher=event.publisher, title=event.title)
    if ch_match and ch_match.matched_via:
        evidence_grade, evidence_basis = grade_record([{
            "url": ch_match.profile_url,
            "publisher": "Companies House",
            "title": f"{ch_match.company_name} filings",
        }])
    else:
        evidence_grade, evidence_basis = tier.grade, tier.meaning

    estimate = estimate_from_event(
        event_key=event.event_key,
        amount_gbp=event.amount_gbp,
        text=f"{event.title} {event.summary}",
        has_named_person=True,
        # A filed PSC band replaces the assumed stake outright.
        known_stake_band=ch_match.ownership_band if ch_match else None,
    )

    slug = db.slugify(f"{person.name}-{event.market_key}")

    with db.connect() as conn:
        existing = conn.execute(
            "SELECT id FROM prospects WHERE slug = ?", (slug,)
        ).fetchone()
        prior_sources = db.source_count(conn, int(existing["id"])) if existing else 0

        confidence = score_confidence(
            publisher=event.publisher,
            has_named_person=True,
            amount_disclosed=event.amount_gbp is not None,
            source_count=prior_sources + 1,
            event_weight=event.weight,
            stake_verified=stake_verified,
            companies_house_verified=bool(ch_match and ch_match.matched_via),
            estimate_is_none=estimate.investable_mid_gbp is None,
            location_from_text=event.market_source == "text",
        )

        record = {
            "slug": slug,
            "full_name": person.name,
            "job_title": person.title,
            "company": event.company,
            "market_key": event.market_key,
            "market_name": event.market_name,
            "market_group": event.market_group,
            "country": event.country,
            "market_source": event.market_source,
            "locality": event.locality,
            "address": ch_match.registered_office if ch_match else None,
            "matched_place": event.matched_place,
            "gross_low_gbp": estimate.gross_low_gbp,
            "gross_mid_gbp": estimate.gross_mid_gbp,
            "gross_high_gbp": estimate.gross_high_gbp,
            "investable_low_gbp": estimate.investable_low_gbp,
            "investable_mid_gbp": estimate.investable_mid_gbp,
            "investable_high_gbp": estimate.investable_high_gbp,
            "wealth_band": estimate.band,
            "cohort": cohort_for(
                estimate.investable_mid_gbp, estimate.gross_mid_gbp,
                estimate.annual_income_gbp,
            ),
            "annual_income_gbp": estimate.annual_income_gbp,
            "annual_income_basis": estimate.annual_income_basis,
            "company_status": _company_status(event, ch_match),
            "company_number": ch_match.company_number if ch_match else None,
            "known_adviser": None,  # only ever set from explicit public reporting
            "latest_newsflow": f"{event.published_at:%d %b %Y} · {event.title}"
                               if event.published_at else event.title,
            "evidence_grade": evidence_grade,
            "evidence_basis": evidence_basis,
            "wealth_source": WEALTH_SOURCE.get(event.event_key, "Other"),
            "estimate_method": estimate.method,
            "estimate_caveats": json.dumps(estimate.caveats),
            "not_estimated_reason": estimate.not_estimated_reason,
            "confidence": confidence.score,
            "confidence_band": confidence.band,
            "confidence_detail": json.dumps([
                {"label": d.label, "score": d.score, "weight": d.weight, "why": d.explanation}
                for d in confidence.dimensions
            ]),
            "next_action": confidence.next_action,
            "rationale": _build_rationale(event, estimate),
            "primary_event": event.event_label,
            "ch_company_number": ch_match.company_number if ch_match else None,
            "ch_company_name": ch_match.company_name if ch_match else None,
            "ch_officer_name": ch_match.officer_name if ch_match else None,
            "ch_ownership_band": ch_match.ownership_band if ch_match else None,
            "ch_registered_office": ch_match.registered_office if ch_match else None,
            "ch_profile_url": ch_match.profile_url if ch_match else None,
            "ch_verified_at": db.now_iso() if ch_match else None,
            "first_seen": db.now_iso(),
            "last_updated": db.now_iso(),
            "first_seen_week": db.iso_week(),
        }

        prospect_id, created = db.upsert_prospect(conn, record)

        db.add_source(conn, prospect_id, {
            "url": event.url,
            "title": event.title,
            "publisher": event.publisher,
            "published_at": event.published_at.isoformat() if event.published_at else None,
            "event_key": event.event_key,
            "event_label": event.event_label,
            "amount_gbp": event.amount_gbp,
            "excerpt": event.summary[:400],
            "rationale": event.rationale,
        })

        if created:
            db.add_event(conn, prospect_id, "created",
                         f"Identified from {event.publisher or 'a news source'} — {event.event_label}.",
                         event.rationale)
        else:
            db.add_event(conn, prospect_id, "corroborated",
                         f"Additional source: {event.event_label} via {event.publisher}.",
                         event.url)

        if stake_verified and ch_match:
            db.add_event(conn, prospect_id, "verified",
                         f"Shareholding confirmed on the Companies House PSC register: "
                         f"{ch_match.ownership_band} of {ch_match.company_name}.",
                         ch_match.profile_url)
        elif ch_match and ch_match.matched_via == "officer":
            db.add_event(conn, prospect_id, "verified",
                         f"Confirmed as a filed officer of {ch_match.company_name} "
                         f"({ch_match.company_number}). The appointment is verified; the "
                         f"shareholding is not.",
                         ch_match.profile_url)

    return {
        "kind": "new" if created else "updated",
        "name": person.name,
        "ch_warning": ch_warning,
    }


def _build_rationale(event: ExtractedEvent, estimate) -> str:
    """The "why is this person here" paragraph an advisor reads first."""
    template = EVENT_BY_KEY.get(event.event_key)
    parts: list[str] = []

    who = event.people[0].name if event.people else "An unnamed individual"
    role = f", {event.people[0].title}" if event.people else ""
    company = f" of {event.company}" if event.company else ""
    where = event.locality or event.market_name

    parts.append(
        f"{who}{role}{company} was identified from a reported "
        f"{event.event_label.lower()} in {where}, {event.country}."
    )
    if event.market_source == "query":
        parts.append(
            f"The article does not name the location; {event.market_name} is inferred "
            f"from the search that found it, and the confidence score reflects that."
        )
    if template:
        parts.append(template.meaning)

    if estimate.not_estimated_reason:
        parts.append(estimate.not_estimated_reason)
    else:
        parts.append(f"Estimate basis: {estimate.method}")

    parts.append(
        "This is derived from press reporting, not from a statutory filing. "
        "Verify the shareholding on the company register before treating any figure "
        "as reliable."
    )
    return " ".join(parts)
