"""The weekly research run.

One function, `run_research`, does the whole sweep: build the query matrix, fetch
every feed, extract events, score them, and write prospects with their sources.
It is safe to run repeatedly — URLs already processed are skipped, and an
existing prospect is only revised when the new evidence is at least as good.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from . import db
from .extract import ExtractedEvent, extract_event
from .queries import EVENT_BY_KEY, PUBLISHER_FEEDS, build_search_matrix
from .scoring import cohort_for, estimate_from_event, score_confidence
from .sources import Fetcher, fetch_feed, verify_with_companies_house

ProgressCallback = Callable[[str, float], None]


@dataclass
class RunResult:
    run_id: int
    week: str
    status: str
    queries_run: int = 0
    articles_seen: int = 0
    events_kept: int = 0
    new_prospects: int = 0
    updated_prospects: int = 0
    company_leads: int = 0
    warnings: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def run_research(
    *,
    trigger: str = "manual",
    days: int = 7,
    regions: list[str] | None = None,
    event_keys: list[str] | None = None,
    include_publishers: bool = True,
    verify_companies_house: bool = False,
    max_queries: int | None = None,
    progress: ProgressCallback | None = None,
) -> RunResult:
    """Sweep the sources and update the book.

    ``days`` bounds how far back to look, which is what makes a weekly run cheap:
    we ask only for what has appeared since the last one.
    """
    started = datetime.now(timezone.utc)
    db.init_db()
    fetcher = Fetcher()

    matrix = build_search_matrix(days=days, regions=regions, event_keys=event_keys)
    if max_queries:
        matrix = matrix[:max_queries]

    feeds: list[tuple[str, str, str | None]] = [
        (q.url, "Google News", q.event_key) for q in matrix
    ]
    if include_publishers:
        feeds += [(url, name, None) for name, url in PUBLISHER_FEEDS]

    with db.connect() as conn:
        run_id = db.start_run(conn, trigger)

    result = RunResult(run_id=run_id, week=db.iso_week(started), status="running")
    ch_disabled_reason: str | None = None

    for index, (url, publisher, event_key) in enumerate(feeds):
        if progress:
            progress(
                f"Searching {publisher} ({index + 1} of {len(feeds)})",
                (index + 1) / max(len(feeds), 1),
            )

        articles, warning = fetch_feed(fetcher, url, publisher=publisher)
        result.queries_run += 1
        if warning:
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
            )
            if event is None:
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
                    result.warnings.append(f"Companies House verification disabled: {warning_text}")
                elif warning_text not in result.warnings:
                    result.warnings.append(warning_text)

            if outcome["kind"] == "new":
                result.new_prospects += 1
                result.log.append(f"New prospect: {outcome['name']} ({event.region}) — {event.event_label}")
            elif outcome["kind"] == "updated":
                result.updated_prospects += 1
            elif outcome["kind"] == "company_lead":
                result.company_leads += 1

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
            warnings=result.warnings,
            log=result.log,
        )
    return result


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

    if verify_ch and event.company:
        ch_match, ch_warning = verify_with_companies_house(
            fetcher, company_name=event.company, person_name=person.name
        )

    stake_verified = bool(ch_match and ch_match.ownership_band)

    estimate = estimate_from_event(
        event_key=event.event_key,
        amount_gbp=event.amount_gbp,
        text=f"{event.title} {event.summary}",
        has_named_person=True,
        # A filed PSC band replaces the assumed stake outright.
        known_stake_band=ch_match.ownership_band if ch_match else None,
    )

    slug = db.slugify(f"{person.name}-{event.region}")

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
            companies_house_verified=bool(ch_match),
            estimate_is_none=estimate.investable_mid_gbp is None,
        )

        record = {
            "slug": slug,
            "full_name": person.name,
            "job_title": person.title,
            "company": event.company,
            "region": event.region,
            "matched_place": event.matched_place,
            "gross_low_gbp": estimate.gross_low_gbp,
            "gross_mid_gbp": estimate.gross_mid_gbp,
            "gross_high_gbp": estimate.gross_high_gbp,
            "investable_low_gbp": estimate.investable_low_gbp,
            "investable_mid_gbp": estimate.investable_mid_gbp,
            "investable_high_gbp": estimate.investable_high_gbp,
            "wealth_band": estimate.band,
            "cohort": cohort_for(estimate.investable_mid_gbp, estimate.gross_mid_gbp),
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
            "ch_officer_name": ch_match.officer_name if ch_match else None,
            "ch_ownership_band": ch_match.ownership_band if ch_match else None,
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

    parts.append(f"{who}{role}{company} was identified from a reported {event.event_label.lower()} in {event.region}.")
    if template:
        parts.append(template.meaning)

    if estimate.not_estimated_reason:
        parts.append(estimate.not_estimated_reason)
    else:
        parts.append(f"Estimate basis: {estimate.method}")

    parts.append(
        "This is derived from press reporting, not from a statutory filing. "
        "Verify the shareholding on Companies House before treating any figure as reliable."
    )
    return " ".join(parts)
