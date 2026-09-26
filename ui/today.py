"""Today: the people worth a call, best first, each with the reason and the step.

This is the page the app opens on. An advisor with twenty minutes should not
have to build a filter to find out who to ring — the book already knows who is
verified, who came into money recently, who has a warm route in, and who has
been approached already. This page is that knowledge, ranked.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.config import QUALIFYING_THRESHOLD_GBP
from wealthscan.markets import DEFAULT_PRESET, PRESETS
from wealthscan.priority import CLOSED_STATUSES
from wealthscan.queries import DEFAULT_DEPTH

from .common import (
    estimate_disclaimer,
    fmt_gbp,
    guarded,
    is_web_link,
    load_lead_count,
    load_prospects,
    load_sources_index,
    present,
    state_pill,
    value,
    where_text,
)
from . import sweeps
from .record import render_record

SHORTLIST_SIZE = 10


def shortlist_frame(frame: pd.DataFrame, size: int = SHORTLIST_SIZE) -> pd.DataFrame:
    """The same rule as ``wealthscan.priority.shortlist``, applied to the table.

    Verified or corroborated only, still open, not approached this month.
    """
    if frame.empty:
        return frame
    eligible = frame[
        (frame["verification_state"].fillna("Unconfirmed") != "Unconfirmed")
        & (~frame["status"].fillna("New").isin(CLOSED_STATUSES))
        & (~frame["in_progress"].fillna(False).astype(bool))
    ]
    return eligible.sort_values("priority", ascending=False).head(size)


def to_check_frame(frame: pd.DataFrame, size: int = 5) -> pd.DataFrame:
    """Unconfirmed names with the most at stake — worth ten minutes of research."""
    if frame.empty:
        return frame
    pending = frame[frame["verification_state"].fillna("Unconfirmed") == "Unconfirmed"]
    return pending.sort_values(
        ["investable_mid_gbp", "priority"], ascending=False, na_position="last"
    ).head(size)


def call_sheet_csv(shortlist: pd.DataFrame) -> str:
    """The call list as a sheet to work from: who, why, how, and what to say first."""
    sources = load_sources_index()

    def links(prospect_id) -> str:
        return " | ".join(
            str(s["url"]) for s in sources.get(int(prospect_id), []) if is_web_link(s.get("url"))
        )

    def text(row, key) -> str:
        return str(value(row, key, "")) if present(row, key) else ""

    sheet = pd.DataFrame([{
        "rank": rank,
        "priority": int(value(row, "priority", 0)),
        "name": row["full_name"],
        "role": text(row, "job_title"),
        "company": text(row, "company"),
        "companies_house_number": text(row, "ch_company_number"),
        "where": where_text(row),
        "verification": text(row, "verification_state"),
        "why_now": text(row, "why_now"),
        "next_step": text(row, "next_step"),
        "known_adviser": text(row, "known_adviser"),
        "registered_office": text(row, "ch_registered_office") or text(row, "address"),
        "est_investable_ESTIMATE": fmt_gbp(row["investable_mid_gbp"])
        if present(row, "investable_mid_gbp") else "not estimated",
        "est_annual_income_ESTIMATE": fmt_gbp(row["annual_income_gbp"])
        if present(row, "annual_income_gbp") else "not disclosed",
        "sources": links(row["id"]),
        "outcome": "",
        "notes": "",
    } for rank, (_, row) in enumerate(shortlist.iterrows(), start=1)])
    return (
        "# Call sheet. Figures marked ESTIMATE are modelled from public reporting, not "
        "verified statements of wealth. Never quote them to the person.\n"
        + sheet.to_csv(index=False)
    )


def _search_prompt(frame: pd.DataFrame) -> None:
    """Start a search from here, or watch the one that is running."""
    job = sweeps.current_job()
    if sweeps.is_running():
        sweeps.live_progress()
        return
    with db.connect() as conn:
        due = db.run_due_this_week(conn)
    if not frame.empty and not due:
        if job is not None and job.done and job.result is not None \
                and st.session_state.get("_today_result_shown") != job.started:
            st.session_state["_today_result_shown"] = job.started
            st.toast(f"Search finished: {job.result.new_prospects} new people.")
        return

    with st.container(border=True):
        if frame.empty:
            st.markdown("**Nothing on file yet — start with a search of your patch.**")
            st.caption(
                "Bristol, Bath, London and the South West. The quick search reads the "
                "freshest deal news in under a minute; the deep search takes about a "
                "quarter of an hour and finds far more. Both run in the background."
            )
        else:
            st.markdown("**This week's search is due.**")
            st.caption(
                "Articles already read are skipped, so nothing is duplicated. It runs in "
                "the background — carry on working."
            )
        buttons = st.columns([1, 1, 2])
        keys = list(PRESETS[DEFAULT_PRESET])
        if buttons[0].button("Quick search (≈1 min)", width="stretch",
                             type="secondary" if not frame.empty else "primary"):
            sweeps.start_sweep("Quick search of your patch", trigger="manual",
                               depth="quick", market_keys=keys)
            st.rerun()
        if buttons[1].button("Deep search (≈15 min)", width="stretch",
                             type="primary" if not frame.empty else "secondary"):
            sweeps.start_sweep("Deep search of your patch", trigger="manual",
                               depth=DEFAULT_DEPTH, market_keys=keys,
                               time_budget_seconds=20 * 60)
            st.rerun()
        buttons[2].caption("Or choose markets and depth yourself on **Find prospects**, "
                           "or bring in your own list through **Add & import**.")
        if frame.empty and job is not None and job.done:
            sweeps.show_result(job)


@st.dialog("Prospect record", width="large")
def _open_record(prospect_id: int) -> None:
    # Re-read the book each time so a save made inside the dialog is reflected
    # when it redraws, rather than showing the row as it was when opened.
    frame = load_prospects()
    match = frame[frame["id"] == prospect_id] if not frame.empty else frame
    if match.empty:
        st.info("This record is no longer on the list — it may have been suppressed.")
        return
    render_record(match.iloc[0])


def page_today(frame: pd.DataFrame) -> None:
    st.title("Today")
    st.caption(
        "Who to call first, and why. Ranked on wealth, how well it is verified, how "
        "recent the money is, how warm the route in is, and whether they are in your "
        "patch. Anyone approached in the last month is held back."
    )

    with guarded("The search controls"):
        _search_prompt(frame)

    if frame.empty:
        return

    shortlist = shortlist_frame(frame)
    this_week = frame[frame["first_seen_week"] == db.iso_week()]
    verified = frame[frame["verification_state"].isin(["Confirmed", "Corroborated"])]
    qualifying = verified[verified["investable_mid_gbp"].fillna(0) >= QUALIFYING_THRESHOLD_GBP]
    waiting, waiting_value = load_lead_count()

    metrics = st.columns(5)
    metrics[0].metric("Ready to call", len(shortlist),
                      help="Verified or corroborated, open, and not approached this month.")
    metrics[1].metric("New this week", len(this_week))
    metrics[2].metric("Verified people", len(verified),
                      help="Confirmed on a register, or company and role corroborated.")
    metrics[3].metric("Verified £7.5m+", len(qualifying),
                      help="Verified people whose ESTIMATED investable assets clear £7.5m.")
    metrics[4].metric("Deals with no name", waiting,
                      help=f"{fmt_gbp(waiting_value)} of reported value — see Find the owner.")

    st.divider()
    if shortlist.empty:
        st.info(
            "No verified, uncontacted prospects right now. The **Needs ten minutes** list "
            "below is where the next ones will come from."
        )
    else:
        head = st.columns([3, 1])
        head[0].subheader(f"Call list — {len(shortlist)} people")
        with head[1]:
            st.download_button(
                "Download call sheet", data=call_sheet_csv(shortlist),
                file_name=f"call-sheet-{db.iso_week()}.csv", mime="text/csv",
                width="stretch",
                help="Today's list with the reason, next step, route in and sources — "
                     "for a call session away from the app.",
            )
        for rank, (_, row) in enumerate(shortlist.iterrows(), start=1):
            with guarded(f"The card for {row['full_name']}"):
                _card(rank, row)

    checks = to_check_frame(frame)
    if not checks.empty:
        st.divider()
        st.subheader("Needs ten minutes")
        st.caption(
            "Named near a deal, but not yet tied to a company and role. One Companies "
            "House search each would move them onto the call list — or off the book."
        )
        for _, row in checks.iterrows():
            with guarded(f"The check for {row['full_name']}"):
                _check_row(row)

    st.divider()
    estimate_disclaimer()


def _card(rank: int, row: pd.Series) -> None:
    with st.container(border=True):
        left, right = st.columns([5, 1.1])
        with left:
            st.markdown(f'<div class="card-rank">No. {rank}</div>', unsafe_allow_html=True)
            role = f", {row['job_title']}" if present(row, "job_title") else ""
            st.markdown(
                f'<div class="card-name">{row["full_name"]}{role}</div>',
                unsafe_allow_html=True,
            )
            meta = [value(row, "company"), where_text(row), value(row, "sector")]
            st.markdown(
                '<div class="card-meta">' + " · ".join(str(m) for m in meta if m) + "</div>",
                unsafe_allow_html=True,
            )
            pills = [state_pill(str(value(row, "verification_state", "Unconfirmed")))]
            if present(row, "investable_mid_gbp"):
                pills.append(
                    f'<span class="pill pill-none">Est. {fmt_gbp(row["investable_mid_gbp"])} '
                    f"investable</span>"
                )
            if present(row, "annual_income_gbp"):
                pills.append(
                    f'<span class="pill pill-none">Est. {fmt_gbp(row["annual_income_gbp"])} '
                    f"a year</span>"
                )
            if present(row, "wealth_source"):
                pills.append(f'<span class="pill pill-none">{row["wealth_source"]}</span>')
            st.markdown("".join(pills), unsafe_allow_html=True)
            if present(row, "why_now"):
                st.markdown(f'<div class="card-why">{row["why_now"]}</div>',
                            unsafe_allow_html=True)
            if present(row, "next_step"):
                st.markdown(f'<div class="card-act"><strong>Next:</strong> '
                            f'{row["next_step"]}</div>', unsafe_allow_html=True)
        with right:
            st.markdown(
                f'<div style="text-align:right"><div class="score">'
                f'{int(value(row, "priority", 0))}</div>'
                f'<div class="score-label">priority</div></div>',
                unsafe_allow_html=True,
            )
            st.write("")
            if st.button("Open", key=f"today_open_{int(row['id'])}", width="stretch",
                         type="primary" if rank <= 3 else "secondary"):
                _open_record(int(row["id"]))


def _check_row(row: pd.Series) -> None:
    with st.container(border=True):
        left, right = st.columns([5, 1.1])
        with left:
            role = f", {row['job_title']}" if present(row, "job_title") else ""
            wealth = (f" · est. {fmt_gbp(row['investable_mid_gbp'])}"
                      if present(row, "investable_mid_gbp") else "")
            st.markdown(f"**{row['full_name']}**{role} · {where_text(row)}{wealth}")
            step = value(row, "legitimacy_next_step") or value(row, "next_step")
            if step:
                st.caption(step)
        with right:
            if st.button("Check", key=f"today_check_{int(row['id'])}", width="stretch"):
                _open_record(int(row["id"]))
