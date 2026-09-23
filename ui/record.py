"""One person's record.

The answer comes first — who they are, why they are worth a call now, and the one
thing to do next — and the evidence behind it sits in tabs underneath. The old
record was a single long scroll in which the next step appeared somewhere around
the ninth heading.
"""

from __future__ import annotations

import json
from urllib.parse import quote_plus

import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.outreach import REFUSED_ROUTES, contact_routes
from wealthscan.workbench import verify_manually

from .common import (
    confidence_pill,
    events_for,
    fmt_gbp,
    guarded,
    is_web_link,
    load_sources_index,
    present,
    refresh,
    state_pill,
    value,
    where_text,
)

STATUSES = ["New", "Researching", "Qualified", "Contacted", "In conversation",
            "Client", "Not a fit", "Parked"]
STAGES = ["Unaware", "Aware", "Engaged", "In discussion", "Proposal", "Onboarded"]


def render_record(row: pd.Series) -> None:
    pid = int(row["id"])
    _header(row)

    tabs = st.tabs(["Summary", "Evidence", "Verify", "How to reach", "Pipeline"])
    with tabs[0], guarded("The summary"):
        _summary(row)
    with tabs[1], guarded("The evidence"):
        _evidence(row, pid)
    with tabs[2], guarded("Verification"):
        _verify(row, pid)
    with tabs[3], guarded("Contact routes"):
        _reach(row, pid)
    with tabs[4], guarded("Pipeline notes"):
        _pipeline(row, pid)


# ---------------------------------------------------------------------------
# Header: the answer
# ---------------------------------------------------------------------------


def _header(row: pd.Series) -> None:
    left, right = st.columns([5, 1])
    with left:
        role = f", {row['job_title']}" if present(row, "job_title") else ""
        st.subheader(f"{row['full_name']}{role}")
        facts = [value(row, "company"), where_text(row), value(row, "sector")]
        st.markdown(
            '<div class="card-meta">' + " · ".join(str(f) for f in facts if f) + "</div>",
            unsafe_allow_html=True,
        )
        pills = [state_pill(str(value(row, "verification_state", "Unconfirmed")))]
        grade = str(value(row, "evidence_grade", "Low"))
        pills.append(
            f'<span class="pill {"pill-good" if grade == "High" else "pill-warn" if grade == "Medium" else "pill-none"}">'
            f"Evidence {grade}</span>"
        )
        pills.append(confidence_pill(int(value(row, "confidence", 0)),
                                     str(value(row, "confidence_band", "Low"))))
        if present(row, "cohort"):
            pills.append(f'<span class="pill pill-none">{row["cohort"]}</span>')
        if present(row, "company_status"):
            pills.append(f'<span class="pill pill-none">{row["company_status"]} company</span>')
        if bool(value(row, "in_progress", False)):
            pills.append('<span class="pill pill-warn">Contacted this month</span>')
        st.markdown("".join(pills), unsafe_allow_html=True)
    with right:
        st.markdown(
            f'<div style="text-align:right"><div class="score">'
            f'{int(value(row, "priority", 0))}</div>'
            f'<div class="score-label">priority</div></div>',
            unsafe_allow_html=True,
        )

    if present(row, "why_now"):
        st.markdown(f'<div class="card-why">{row["why_now"]}</div>', unsafe_allow_html=True)
    if present(row, "next_step"):
        st.markdown(
            f'<div class="card-act"><strong>Next:</strong> {row["next_step"]}</div>',
            unsafe_allow_html=True,
        )


# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------


def _summary(row: pd.Series) -> None:
    money = st.columns(4)
    money[0].metric(
        "Est. investable",
        fmt_gbp(row["investable_mid_gbp"]) if present(row, "investable_mid_gbp")
        else "not estimated",
        help="A modelled ESTIMATE from public reporting — not a verified amount.",
    )
    money[1].metric(
        "Est. annual income",
        fmt_gbp(row["annual_income_gbp"]) if present(row, "annual_income_gbp")
        else "not disclosed",
    )
    money[2].metric(
        "Company revenue",
        fmt_gbp(row["company_revenue_gbp"]) if present(row, "company_revenue_gbp")
        else "not disclosed",
    )
    money[3].metric("Wealth band", str(value(row, "wealth_band", "Not estimated")))

    if present(row, "investable_mid_gbp"):
        st.caption(
            f"Range {fmt_gbp(row['investable_low_gbp'])} – "
            f"{fmt_gbp(row['investable_high_gbp'])} · gross estimated wealth "
            f"{fmt_gbp(row['gross_mid_gbp'])}"
        )
        _reason("How that figure was reached", value(row, "estimate_method"))
    else:
        _reason("Why there is no figure",
                value(row, "not_estimated_reason", "No basis for an estimate was found."))
    _reason("Income basis", value(row, "annual_income_basis"))

    st.divider()
    left, right = st.columns([1.3, 1])
    with left:
        _reason("Why they were identified", value(row, "rationale"))
        caveats = json.loads(row["estimate_caveats"]) if present(row, "estimate_caveats") else []
        if caveats:
            st.markdown("**Caveats**")
            for caveat in caveats:
                st.markdown(f'<div class="reason">• {caveat}</div>', unsafe_allow_html=True)
    with right:
        st.markdown("**Where they are**")
        st.markdown(f'<div class="reason">{where_text(row)}</div>', unsafe_allow_html=True)
        if value(row, "market_source") != "text":
            st.caption(
                "The source does not name a place — this market comes from the search "
                "that found it. Confirm it before acting."
            )
        address = value(row, "ch_registered_office") or value(row, "address")
        if address:
            _reason("Registered office", address)
            st.caption("The company's filed address. Never a home address.")
        _reason("Sector", value(row, "sector"))
        if value(row, "sector_basis") == "inferred":
            st.caption("Inferred from the wording, not a filed SIC code.")
        _reason("Known adviser", value(row, "known_adviser"))
        _reason("Latest newsflow", value(row, "latest_newsflow"))


def _evidence(row: pd.Series, pid: int) -> None:
    left, right = st.columns([1.3, 1])
    with left:
        state = str(value(row, "verification_state", "Unconfirmed"))
        st.markdown(
            f"**Verification — {state}** "
            f"({int(value(row, 'legitimacy_score', 0))}% of checks passed)"
        )
        for check in (json.loads(row["legitimacy_checks"])
                      if present(row, "legitimacy_checks") else []):
            st.markdown(
                f"{'✅' if check['passed'] else '⬜'} **{check['label']}** — {check['why']}"
            )
        if present(row, "legitimacy_next_step"):
            st.info(f"**To verify further** — {row['legitimacy_next_step']}")
        _register_verdict(row)

        st.markdown("**Sources**")
        for source in load_sources_index().get(pid, []):
            published = str(source.get("published_at") or "")[:10]
            title = source.get("title") or "Source"
            label = f"[{title}]({source['url']})" if is_web_link(source.get("url")) else title
            st.markdown(
                f"- {label} — {source.get('publisher') or 'source'}"
                + (f" · {published}" if published else "")
                + (f" · {source['event_label']}" if source.get("event_label") else "")
            )
            if source.get("rationale"):
                st.caption(source["rationale"])

        history = events_for(pid)
        if history:
            with st.expander(f"Record history ({len(history)} entries)"):
                for entry in history:
                    st.markdown(
                        f"**{entry['created_at'][:10]}** · {entry['kind']} — {entry['message']}"
                    )
    with right:
        st.markdown("**Confidence**")
        for dimension in (json.loads(row["confidence_detail"])
                          if present(row, "confidence_detail") else []):
            st.progress(
                min(100, max(0, int(dimension["score"]))) / 100,
                text=f"{dimension['label']} — {dimension['score']}/100",
            )
            st.caption(dimension["why"])
        if present(row, "evidence_basis"):
            _reason("Strongest source", row["evidence_basis"])


def _verify(row: pd.Series, pid: int) -> None:
    name = str(row["full_name"])
    company = value(row, "company")
    ch = "https://find-and-update.company-information.service.gov.uk"

    left, right = st.columns([1, 1.25])
    with left:
        st.markdown("**Check it yourself**")
        links = []
        if present(row, "ch_profile_url"):
            links.append(f"[Companies House — this company]({row['ch_profile_url']})")
        if company:
            links.append(f"[Companies House — search the company]({ch}/search/companies?q={quote_plus(str(company))})")
        links.append(f"[Companies House — search the person]({ch}/search/officers?q={quote_plus(name)})")
        if value(row, "wealth_source") == "Land, estate or farming":
            links.append("[HM Land Registry — find the title and its owner]"
                         "(https://search-property-information.service.gov.uk/) "
                         "(a small fee per title register)")
        if company:
            links.append(f"[The Gazette — notices for the company](https://www.thegazette.co.uk/all-notices/notice?text={quote_plus(str(company))})")
        links.append(f"[News — everything on this person](https://news.google.com/search?q=%22{quote_plus(name)}%22)")
        links.append(f"[LinkedIn — search by hand](https://www.linkedin.com/search/results/people/?keywords={quote_plus(name)}) "
                     "(manual only; the app never scrapes LinkedIn)")
        st.markdown("\n".join(f"- {link}" for link in links))
        st.caption(
            "To confirm: open the company on Companies House, check the People tab "
            "for their name as an officer or person with significant control, and "
            "record the company number here."
        )
        if company:
            st.markdown("**To look up in a company database**")
            st.code(
                f"{company}" + (f"\n{row['ch_company_number']}"
                                if present(row, "ch_company_number") else ""),
                language="text",
            )

    with right:
        st.markdown("**Record what you checked**")
        with st.form(f"verify_{pid}"):
            number = st.text_input(
                "Companies House number",
                value=str(value(row, "ch_company_number", "")),
                placeholder="e.g. 07890123 or SC123456",
            )
            confirmed = st.checkbox(
                f"I found {name} listed as an officer or PSC of this company",
                value=present(row, "ch_officer_name"),
            )
            band = st.selectbox(
                "Shareholding band on the PSC register (if listed)",
                ["—", "25–50%", "50–75%", "75–100%"],
                index=["—", "25–50%", "50–75%", "75–100%"].index(
                    str(value(row, "ch_ownership_band", "—"))
                ) if str(value(row, "ch_ownership_band", "—")) in ("25–50%", "50–75%", "75–100%") else 0,
            )
            second = st.text_input("Second independent source (web address)", placeholder="https://")
            second_title = st.text_input("Its headline (optional)")
            who = st.text_input("Checked by", placeholder="Your initials")
            note = st.text_input("Note (optional)")
            if st.form_submit_button("Save verification", type="primary"):
                result = verify_manually(
                    pid, verified_by=who, company_number=number or None,
                    officer_confirmed=confirmed,
                    ownership_band=None if band == "—" else band,
                    second_source_url=second or None,
                    second_source_title=second_title or None, note=note or None,
                )
                if result.ok:
                    refresh()
                    st.success(result.message)
                else:
                    st.warning(result.message)


def _reach(row: pd.Series, pid: int) -> None:
    record = {
        key: value(row, key)
        for key in ("full_name", "company", "known_adviser", "ch_registered_office",
                    "address", "ch_company_number", "ch_company_name", "ch_profile_url")
    }
    routes = contact_routes(record)
    with db.connect() as conn:
        history = [dict(r) for r in db.contacts(conn, pid)]

    if history:
        latest = history[0]
        st.warning(
            f"**Already approached {len(history)} time(s)** — most recently "
            f"{latest['created_at'][:10]} by {latest['channel'].lower()}"
            + (f" ({latest['outcome']})" if latest.get("outcome") else "")
            + ". Check the log before making contact again."
        )

    left, right = st.columns([1.5, 1])
    with left:
        # Numbered by position so a record with no adviser does not start at "5.".
        for position, route in enumerate(routes, start=1):
            with st.container(border=True):
                st.markdown(
                    f"**{position}. {route.label}**"
                    + (f"  ·  [open]({route.url})" if route.url else "")
                )
                st.markdown(f'<div class="reason">{route.detail}</div>', unsafe_allow_html=True)
                if route.caution:
                    st.caption(f"⚠︎ {route.caution}")
        with st.expander("What this app will not look up, and why"):
            for label, why in REFUSED_ROUTES:
                st.markdown(f"**{label}** — {why}")

    with right:
        st.markdown("**Log an approach**")
        with st.form(f"contact_{pid}"):
            channel = st.selectbox("How", ["Introduction requested", "Letter", "Call",
                                           "Email to the company", "Met in person", "Event",
                                           "Other"])
            route_used = st.selectbox("Route", ["—"] + [r.label for r in routes])
            outcome = st.selectbox("Outcome", ["No reply yet", "Replied", "Meeting booked",
                                               "Declined", "Asked not to be contacted"])
            note = st.text_area("Note", height=80)
            who = st.text_input("Logged by")
            if st.form_submit_button("Save to the contact log", type="primary"):
                with db.connect() as conn:
                    db.log_contact(conn, pid, {
                        "channel": channel,
                        "route": None if route_used == "—" else route_used,
                        "outcome": outcome, "note": note, "logged_by": who,
                    })
                    if outcome == "Asked not to be contacted":
                        db.suppress_prospect(
                            conn, pid, f"Objected on contact — logged by {who or 'unknown'}.")
                refresh()
                if outcome == "Asked not to be contacted":
                    st.warning("Recorded as an objection: the record is now suppressed and "
                               "the weekly sweep will stop updating it.")
                else:
                    st.success("Logged.")

        if history:
            st.markdown("**Contact log**")
            for entry in history:
                st.markdown(
                    f"- **{entry['created_at'][:10]}** {entry['channel']}"
                    + (f" via {entry['route']}" if entry.get("route") else "")
                    + (f" — {entry['outcome']}" if entry.get("outcome") else "")
                    + (f"  \n  _{entry['note']}_" if entry.get("note") else "")
                )


def _pipeline(row: pd.Series, pid: int) -> None:
    with st.form(f"pipeline_{pid}"):
        columns = st.columns(3)
        current_status = str(value(row, "status", "New"))
        current_stage = str(value(row, "relationship_stage", "Unaware"))
        status = columns[0].selectbox(
            "Lead status", STATUSES,
            index=STATUSES.index(current_status) if current_status in STATUSES else 0)
        stage = columns[1].selectbox(
            "Relationship stage", STAGES,
            index=STAGES.index(current_stage) if current_stage in STAGES else 0)
        owner = columns[2].text_input("Owner", value=str(value(row, "owner", "")))
        notes = st.text_area("Notes", value=str(value(row, "notes", "")), height=100)
        if st.form_submit_button("Save", type="primary"):
            with db.connect() as conn:
                db.update_prospect(conn, pid, {"status": status, "relationship_stage": stage,
                                               "owner": owner, "notes": notes})
            refresh()
            st.success("Saved.")

    with st.expander("Remove this person from the list (data protection)"):
        st.caption(
            "Use this when someone objects to being profiled. The record is suppressed "
            "rather than deleted, so the weekly sweep cannot find them again and "
            "recreate them, and they drop out of every total and report."
        )
        reason = st.text_input("Reason", key=f"suppress_reason_{pid}")
        if st.button("Suppress this record", key=f"suppress_{pid}"):
            with db.connect() as conn:
                db.suppress_prospect(conn, pid, reason or "No reason recorded")
            refresh()
            st.session_state.pop("open_prospect", None)
            st.rerun()


def _register_verdict(row: pd.Series) -> None:
    """What the company register says about the stake — the one fact that turns an
    assumed shareholding into a filed one."""
    if present(row, "ch_ownership_band"):
        st.success(
            f"Shareholding filed at {row['ch_ownership_band']} on the PSC register — "
            f"the stake is a fact, not an assumption."
        )
    elif present(row, "ch_officer_name"):
        st.warning(
            f"A filed officer ({row['ch_officer_name']}), but no shareholding on the PSC "
            f"register. The stake behind any figure remains assumed."
        )
    elif present(row, "ch_company_number"):
        st.warning(
            f"Company matched on the register ({row['ch_company_number']}), but this "
            f"person is not yet found in its filings. The stake remains assumed."
        )
    else:
        st.caption(
            "Not yet matched to a company register — the shareholding behind any "
            "figure is an assumption. Use the Verify tab to record what you find."
        )


def _reason(label: str, text) -> None:
    if text is None or (isinstance(text, float) and pd.isna(text)) or not str(text).strip():
        return
    st.markdown(f'<div class="reason"><strong>{label}:</strong> {text}</div>',
                unsafe_allow_html=True)
