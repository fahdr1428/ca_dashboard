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
from wealthscan.priority import CLOSED_STATUSES

from .common import (
    estimate_disclaimer,
    fmt_gbp,
    guarded,
    load_lead_count,
    load_prospects,
    present,
    state_pill,
    value,
    where_text,
)
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

    if frame.empty:
        st.info(
            "**Nothing on file yet.** Open **Find prospects** to run a sweep, or "
            "**Add & import** to bring in a list you already have."
        )
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
        st.subheader(f"Call list — {len(shortlist)} people")
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
