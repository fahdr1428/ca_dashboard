"""The weekly research document.

Generated at the start of every week: who is new, why they qualify, what the
estimate rests on, and what changed for people already on the list. Rendered as
Markdown so it can be read in the app, downloaded, emailed, or pasted into a
client file without losing its caveats.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from . import db
from .config import PRIORITY_THRESHOLD_GBP, QUALIFYING_THRESHOLD_GBP
from .regions import REGIONS


def fmt_gbp(amount: int | float | None) -> str:
    """Compact GBP. Returns an em dash for None, never "£0"."""
    if amount is None:
        return "—"
    value = float(amount)
    if abs(value) >= 1_000_000_000:
        return f"£{value / 1_000_000_000:.2f}bn"
    if abs(value) >= 1_000_000:
        return f"£{value / 1_000_000:.1f}m"
    if abs(value) >= 1_000:
        return f"£{value / 1_000:.0f}k"
    return f"£{value:.0f}"


def week_bounds(week: str) -> tuple[datetime, datetime]:
    """Monday 00:00 and Sunday 23:59 UTC for an ISO week label."""
    year_text, week_text = week.split("-W")
    monday = datetime.fromisocalendar(int(year_text), int(week_text), 1).replace(tzinfo=timezone.utc)
    return monday, monday + timedelta(days=7) - timedelta(seconds=1)


def build_report(week: str | None = None) -> tuple[dict[str, Any], str]:
    """Assemble the research document for a week. Returns ``(payload, markdown)``."""
    target_week = week or db.iso_week()
    monday, sunday = week_bounds(target_week)

    db.init_db()
    with db.connect() as conn:
        new_rows = db.prospects_for_week(conn, target_week)
        all_rows = db.all_prospects(conn)
        latest_run = db.last_run(conn)

        # Corroborations recorded this week against prospects found earlier.
        changes = conn.execute(
            """SELECT e.*, p.full_name, p.slug, p.region, p.company
               FROM events e JOIN prospects p ON p.id = e.prospect_id
               WHERE e.created_at >= ? AND p.first_seen_week != ?
                 AND p.suppressed_at IS NULL
               ORDER BY e.created_at DESC""",
            (monday.isoformat(timespec="seconds"), target_week),
        ).fetchall()

        sources_by_prospect = {
            row["id"]: db.prospect_sources(conn, int(row["id"])) for row in new_rows
        }

    qualifying = [
        r for r in all_rows
        if r["investable_mid_gbp"] and r["investable_mid_gbp"] >= QUALIFYING_THRESHOLD_GBP
    ]
    pre_liquidity = [
        r for r in all_rows
        if (r["gross_mid_gbp"] or 0) >= PRIORITY_THRESHOLD_GBP
        and (r["investable_mid_gbp"] or 0) < QUALIFYING_THRESHOLD_GBP
    ]
    unestimated = [r for r in all_rows if r["investable_mid_gbp"] is None]
    addressable = sum(r["investable_mid_gbp"] for r in qualifying)

    by_region: list[dict[str, Any]] = []
    for region in REGIONS:
        members = [r for r in all_rows if r["region"] == region]
        if not members:
            continue
        by_region.append({
            "region": region,
            "total": len(members),
            "qualifying": len([r for r in members if r in qualifying]),
            "addressable_gbp": sum(
                r["investable_mid_gbp"] or 0 for r in members if r in qualifying
            ),
        })
    by_region.sort(key=lambda r: r["addressable_gbp"], reverse=True)

    payload: dict[str, Any] = {
        "week": target_week,
        "week_start": monday.isoformat(),
        "week_end": sunday.isoformat(),
        "generated_at": db.now_iso(),
        "totals": {
            "tracked": len(all_rows),
            "new_this_week": len(new_rows),
            "qualifying": len(qualifying),
            "pre_liquidity": len(pre_liquidity),
            "not_estimated": len(unestimated),
            "addressable_gbp": addressable,
        },
        "new_prospects": [
            {
                "name": r["full_name"],
                "job_title": r["job_title"],
                "company": r["company"],
                "region": r["region"],
                "event": r["primary_event"],
                "band": r["wealth_band"],
                "cohort": r["cohort"],
                "investable_mid_gbp": r["investable_mid_gbp"],
                "investable_low_gbp": r["investable_low_gbp"],
                "investable_high_gbp": r["investable_high_gbp"],
                "gross_mid_gbp": r["gross_mid_gbp"],
                "confidence": r["confidence"],
                "confidence_band": r["confidence_band"],
                "estimate_method": r["estimate_method"],
                "not_estimated_reason": r["not_estimated_reason"],
                "caveats": json.loads(r["estimate_caveats"] or "[]"),
                "next_action": r["next_action"],
                "rationale": r["rationale"],
                "ch_ownership_band": r["ch_ownership_band"],
                "sources": [
                    {
                        "title": s["title"],
                        "url": s["url"],
                        "publisher": s["publisher"],
                        "event": s["event_label"],
                    }
                    for s in sources_by_prospect.get(r["id"], [])
                ],
            }
            for r in new_rows
        ],
        "changes": [
            {
                "name": c["full_name"],
                "region": c["region"],
                "company": c["company"],
                "kind": c["kind"],
                "message": c["message"],
                "detail": c["detail"],
                "at": c["created_at"],
            }
            for c in changes[:40]
        ],
        "by_region": by_region,
        "run": {
            "queries": latest_run["queries_run"] if latest_run else 0,
            "articles": latest_run["articles_seen"] if latest_run else 0,
            "warnings": json.loads(latest_run["warnings"] or "[]") if latest_run else [],
        },
    }

    return payload, render_markdown(payload)


def render_markdown(payload: dict[str, Any]) -> str:
    totals = payload["totals"]
    monday, sunday = week_bounds(payload["week"])
    lines: list[str] = []

    lines.append(f"# Weekly Prospect Research — {payload['week']}")
    lines.append("")
    lines.append(
        f"Covering {monday:%d %B %Y} to {sunday:%d %B %Y}. "
        f"Generated {datetime.fromisoformat(payload['generated_at']):%d %B %Y, %H:%M} UTC."
    )
    lines.append("")
    lines.append(
        f"**{totals['new_this_week']}** new prospects this week · "
        f"**{totals['tracked']}** tracked in total · "
        f"**{totals['qualifying']}** qualifying (£7.5m+ estimated investable) · "
        f"**{totals['pre_liquidity']}** pre-liquidity founders · "
        f"**{fmt_gbp(totals['addressable_gbp'])}** estimated addressable assets."
    )
    lines.append("")
    lines.append(
        "> Every monetary figure below is a **modelled estimate derived from press "
        "reporting**, not a verified statement of wealth. The individual's actual "
        "shareholding is almost never stated in the press, so it is assumed — which "
        "is the largest source of error in any figure here. Verify on the Companies "
        "House PSC register before relying on a number or contacting anyone."
    )
    lines.append("")

    lines.append("## New prospects")
    lines.append("")
    if not payload["new_prospects"]:
        lines.append(
            "_No new prospects were identified this week. The sweep ran and found "
            "nothing meeting the criteria — which is a normal outcome for a single "
            "week across 13 counties._"
        )
        lines.append("")
    else:
        for person in payload["new_prospects"]:
            heading = person["name"]
            if person["job_title"]:
                heading += f", {person['job_title']}"
            lines.append(f"### {heading}")
            lines.append("")
            lines.append(f"- **Company:** {person['company'] or 'not identified'}")
            lines.append(f"- **County:** {person['region']}")
            lines.append(f"- **Why identified:** {person['event']}")
            lines.append(f"- **Cohort:** {person['cohort']}")

            if person["investable_mid_gbp"] is not None:
                lines.append(
                    f"- **Estimated investable assets:** {fmt_gbp(person['investable_mid_gbp'])} "
                    f"(range {fmt_gbp(person['investable_low_gbp'])}–{fmt_gbp(person['investable_high_gbp'])}) "
                    f"· band {person['band']} · gross {fmt_gbp(person['gross_mid_gbp'])}"
                )
                lines.append(f"- **How that figure was reached:** {person['estimate_method']}")
            else:
                lines.append(
                    f"- **Estimated investable assets:** not estimated — "
                    f"{person['not_estimated_reason']}"
                )

            lines.append(
                f"- **Confidence:** {person['confidence']}/100 ({person['confidence_band']})"
            )
            if person["ch_ownership_band"]:
                lines.append(
                    f"- **Companies House:** shareholding confirmed at "
                    f"{person['ch_ownership_band']} — the stake is filed, not assumed."
                )
            lines.append(f"- **Best next action:** {person['next_action']}")

            if person["caveats"]:
                lines.append("- **Caveats:**")
                for caveat in person["caveats"]:
                    lines.append(f"    - {caveat}")

            if person["sources"]:
                lines.append("- **Sources:**")
                for source in person["sources"]:
                    publisher = source["publisher"] or "source"
                    lines.append(f"    - [{source['title']}]({source['url']}) — {publisher}")

            lines.append("")

    lines.append("## Developments on existing prospects")
    lines.append("")
    if not payload["changes"]:
        lines.append("_No new developments on prospects already on the list._")
    else:
        for change in payload["changes"]:
            where = change["region"]
            company = f", {change['company']}" if change["company"] else ""
            lines.append(f"- **{change['name']}** ({where}{company}): {change['message']}")
    lines.append("")

    if payload["by_region"]:
        lines.append("## Coverage by county")
        lines.append("")
        lines.append("| County | Tracked | Qualifying | Estimated addressable |")
        lines.append("| --- | ---: | ---: | ---: |")
        for row in payload["by_region"]:
            lines.append(
                f"| {row['region']} | {row['total']} | {row['qualifying']} | "
                f"{fmt_gbp(row['addressable_gbp'])} |"
            )
        lines.append("")

    run = payload["run"]
    lines.append("## How this week's search ran")
    lines.append("")
    lines.append(
        f"{run['queries']} searches across 13 counties and 14 wealth-event patterns, "
        f"reading {run['articles']} articles."
    )
    if totals["not_estimated"]:
        lines.append("")
        lines.append(
            f"{totals['not_estimated']} tracked prospect(s) carry no monetary estimate. "
            f"That is deliberate — the sources found so far indicate wealth without "
            f"sizing it, and a figure will only appear when there is something real to "
            f"base it on."
        )
    if run["warnings"]:
        lines.append("")
        lines.append("Sources that could not be read this week:")
        for warning in run["warnings"][:12]:
            lines.append(f"- {warning}")
    lines.append("")

    return "\n".join(lines)


def generate_and_store(week: str | None = None) -> tuple[dict[str, Any], str]:
    payload, markdown = build_report(week)
    with db.connect() as conn:
        db.save_report(conn, payload["week"], markdown, payload)
    return payload, markdown
