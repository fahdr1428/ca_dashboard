"""Lead Intelligence — private wealth prospect research.

Run it with:

    streamlit run streamlit_app.py

No database server, no build step, no API key required to start. The research
sweep reads public news across 69 markets; Companies House verification is an
optional bonus that turns an assumed shareholding into a filed one.

The interface is written for an advisor, not an engineer: every control says what
it will do in plain English, every sweep shows what it will cost before it runs,
and every figure on screen carries the reason it exists.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import altair as alt
import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.config import (
    ANNUAL_INCOME_THRESHOLD_GBP,
    APP_NAME,
    APP_SUBTITLE,
    ASSUMPTION_NOTES,
    MODEL,
    MODEL_VERSION,
    PRIORITY_THRESHOLD_GBP,
    QUALIFYING_THRESHOLD_GBP,
)
from wealthscan.evidence import GRADE_ORDER, TIERS
from wealthscan.legitimacy import (
    DEFAULT_VISIBLE_STATES,
    STATE_ORDER,
    UNCONFIRMED,
)
from wealthscan.exclusions import BANNED_SOURCE_DOMAINS, MEGA_WEALTH_CEILING_GBP
from wealthscan.markets import (
    ALL_MARKETS,
    DEFAULT_PRESET,
    GROUP_ORDER,
    MARKET_BY_KEY,
    PRESETS,
    markets_in_group,
)
from wealthscan.queries import (
    DEFAULT_DEPTH,
    DEPTHS,
    DEPTH_BY_KEY,
    EVENT_BY_KEY,
    EVENT_TEMPLATES,
    PUBLISHER_FEEDS,
    plan_sweep,
)
from wealthscan.sectors import SECTORS
from wealthscan.report import generate_and_store
from wealthscan.research import resolve_lead_with_register, run_research
from wealthscan.sources import companies_house_available, companies_house_status

from ui.common import (
    ACCENT,
    BAND_ORDER,
    estimate_disclaimer,
    fmt_gbp,
    guarded,
    inject_css,
    is_web_link,
    load_prospects,
    load_runs,
    load_reports,
    load_sources_index,
    masthead,
    money_display,
    refresh,
    where_text,
)
from ui.record import render_record
from ui.system import page_system
from ui.today import page_today
from ui.workbench_page import page_workbench

st.set_page_config(
    page_title=f"{APP_NAME} — Private Wealth",
    page_icon="◈",
    layout="wide",
    initial_sidebar_state="expanded",
)

inject_css()
db.init_db()


# ---------------------------------------------------------------------------
# Page: find prospects
# ---------------------------------------------------------------------------


def _market_selection() -> tuple[list[str], str]:
    """Step 1 of the run page: where to look. Returns ``(market keys, label)``."""
    st.markdown('<div class="step">Step 1 — where to look</div>', unsafe_allow_html=True)

    preset_names = list(PRESETS)
    preset = st.radio(
        "Region preset",
        preset_names,
        index=preset_names.index(DEFAULT_PRESET),
        horizontal=True,
        label_visibility="collapsed",
        help="Start here. You can fine-tune the exact markets underneath.",
    )
    keys = list(PRESETS[preset])

    with st.expander(
        f"Fine-tune the {len(keys)} markets in “{preset}” "
        f"(optional — skip this and the preset is used as-is)"
    ):
        st.caption(
            "Tick or untick individual markets. Anything you choose here replaces the "
            "preset. Leave a group empty to search all of it."
        )
        chosen: list[str] = []
        columns = st.columns(3)
        for index, group in enumerate(GROUP_ORDER):
            group_markets = markets_in_group(group)
            with columns[index % 3]:
                picked = st.multiselect(
                    group,
                    [m.key for m in group_markets],
                    default=[m.key for m in group_markets if m.key in keys],
                    format_func=lambda k: MARKET_BY_KEY[k].name,
                    key=f"markets_{group}",
                )
                chosen.extend(picked)
        if chosen and set(chosen) != set(keys):
            keys = chosen
            preset = f"{len(keys)} markets chosen by hand"

    countries = sorted({MARKET_BY_KEY[k].country for k in keys if k in MARKET_BY_KEY})
    st.caption(
        f"**{len(keys)} markets** across **{len(countries)} countries**: "
        + ", ".join(countries[:12])
        + (f" and {len(countries) - 12} more" if len(countries) > 12 else "")
    )
    return keys, preset


def _depth_selection() -> str:
    st.markdown(
        '<div class="step">Step 2 — how hard to look</div>', unsafe_allow_html=True
    )
    keys = [d.key for d in DEPTHS]
    depth = st.radio(
        "Search depth",
        keys,
        index=keys.index(DEFAULT_DEPTH),
        format_func=lambda k: DEPTH_BY_KEY[k].label,
        horizontal=True,
        label_visibility="collapsed",
    )
    st.caption(DEPTH_BY_KEY[depth].description)
    return depth


def page_find(frame: pd.DataFrame) -> None:
    st.title("Find prospects")
    st.caption(
        "Searches public news for the moments when people come into money — a "
        "business sold, a round raised, a dividend paid, a company floated — then "
        "works out who was named, where they are, and what it might be worth."
    )

    with db.connect() as conn:
        due = db.run_due_this_week(conn)

    if due:
        st.info(
            f"No sweep has run yet in **{db.iso_week()}**. The intended cadence is once "
            f"at the start of each week, but you can run it whenever you like — "
            f"articles already processed are skipped, so nothing is duplicated."
        )

    with st.container(border=True):
        market_keys, preset_label = _market_selection()
        st.divider()
        depth = _depth_selection()
        st.divider()

        st.markdown('<div class="step">Step 3 — options</div>', unsafe_allow_html=True)
        options = st.columns([1, 1, 1])
        window = options[0].select_slider(
            "Only news from the last…",
            options=[0, 7, 14, 30, 60, 90, 180, 365],
            value=0,
            format_func=lambda d: "use the depth setting" if d == 0 else f"{d} days",
            help="Leave this alone unless you want one specific window. A deep search "
                 "already looks at both recent and older news.",
        )
        minutes = options[1].select_slider(
            "Stop after at most…",
            options=[2, 5, 10, 20, 45, 90, 0],
            value=20,
            format_func=lambda m: "no limit" if m == 0 else f"{m} minutes",
            help="A safety valve. Everything found before the limit is kept, and running "
                 "again continues where this left off.",
        )
        publishers = options[2].checkbox(
            f"Also search specialist publishers (Insider Media, Business Leader, "
            f"Real Deals, Farmers Weekly) and {len(PUBLISHER_FEEDS)} direct feeds",
            value=DEPTH_BY_KEY[depth].include_publishers,
            help="UK regional, US, and Gulf business press. These carry deal news that "
                 "never reaches national aggregation.",
        )

        ch_ok = companies_house_available()
        verify = st.checkbox(
            "Verify UK companies against Companies House",
            value=ch_ok,
            disabled=not ch_ok,
            help="Replaces the assumed shareholding with the filed PSC band, confirms the "
                 "person is a real officer, and pulls the registered office address.",
        )
        events = st.multiselect(
            "Limit to certain wealth events (optional — all of them otherwise)",
            [t.key for t in EVENT_TEMPLATES],
            format_func=lambda k: EVENT_BY_KEY[k].label,
            default=[],
        )

    plan = plan_sweep(
        market_keys=market_keys,
        depth=depth,
        event_keys=events or None,
        days=window or None,
        include_publishers=publishers,
    )

    summary = st.columns(4)
    summary[0].metric("Searches", f"{plan.queries:,}")
    summary[1].metric("Estimated time", plan.human_time)
    summary[2].metric("Markets", plan.markets)
    summary[3].metric("Event types", plan.events)
    st.caption(
        f"“{preset_label}” at *{DEPTH_BY_KEY[depth].label}* depth. Searches run one at a "
        f"time with a deliberate pause between them, so the app stays a good citizen of "
        f"the sites it reads. You can leave this running and come back."
    )

    if not ch_ok:
        st.caption(
            "**Companies House is not connected.** It is a bonus, not a requirement — "
            "without it, shareholdings stay labelled as assumptions and no registered "
            "office addresses are collected. See **How it works** for the two-minute setup."
        )

    if st.button("Start searching", type="primary", width="stretch"):
        _execute_sweep(
            depth=depth, market_keys=market_keys, events=events,
            window=window, minutes=minutes, publishers=publishers, verify=verify,
        )
        return

    if not frame.empty:
        st.divider()
        st.subheader("Recent sweeps")
        _run_history()
    else:
        st.divider()
        st.caption(
            "Nothing on file yet. To see how the dashboard looks before running a live "
            "search, load the fictional demo data with `python scripts/seed_demo.py`."
        )


def _execute_sweep(
    *, depth: str, market_keys: list[str], events: list[str],
    window: int, minutes: int, publishers: bool, verify: bool,
) -> None:
    status = st.status("Starting…", expanded=True)
    bar = st.progress(0.0)

    def report(message: str, fraction: float) -> None:
        status.update(label=message)
        bar.progress(min(1.0, fraction))

    result = run_research(
        trigger="manual",
        depth=depth,
        market_keys=market_keys,
        event_keys=events or None,
        days=window or None,
        include_publishers=publishers,
        verify_companies_house=verify,
        time_budget_seconds=(minutes * 60) if minutes else None,
        progress=report,
    )
    status.update(
        label=f"Finished in {result.duration_seconds / 60:.1f} minutes — {result.status}",
        state="complete",
    )

    metrics = st.columns(5)
    metrics[0].metric("Searches run", f"{result.queries_run:,}")
    metrics[1].metric("Articles read", f"{result.articles_seen:,}")
    metrics[2].metric("New prospects", result.new_prospects)
    metrics[3].metric("Corroborated", result.updated_prospects)
    metrics[4].metric("Company-only leads", result.company_leads)

    if result.new_prospects or result.updated_prospects:
        with st.spinner("Updating the weekly research document…"):
            generate_and_store()
    refresh()

    if result.new_prospects:
        st.success(
            f"**{result.new_prospects} new people found.** Open **Prospect list** in the "
            f"sidebar to work through them."
        )
    elif result.company_leads:
        st.warning(
            f"No individuals were named, but {result.company_leads} transaction(s) were "
            f"found with a company and no person. Those are listed in the run log below — "
            f"the app will not invent a name to fill the gap."
        )
    else:
        st.warning(
            "Nothing met the criteria. Widen the markets, raise the depth, or lengthen "
            "the look-back window — and check the warnings below in case the searches "
            "themselves were blocked."
        )

    if result.log:
        with st.expander(f"What was found ({len(result.log)} entries)", expanded=True):
            for line in result.log:
                st.text(line)
    if result.warnings:
        with st.expander(f"Sources that could not be read ({len(result.warnings)})"):
            for warning in result.warnings:
                st.text(warning)
        st.caption(
            "Some publishers block automated readers. A blocked feed simply means that "
            "source contributed nothing this run. If *every* search failed, the network "
            "this app is running on is blocking outbound requests."
        )


def _run_history() -> None:
    runs = load_runs()
    if not runs:
        st.caption("No sweeps recorded yet.")
        return
    st.dataframe(
        pd.DataFrame([{
            "Started": r["started_at"][:16].replace("T", " "),
            "Depth": r["depth"] or "—",
            "Markets": len(json.loads(r["markets"] or "[]")),
            "Searches": r["queries_run"],
            "Articles": r["articles_seen"],
            "New": r["new_prospects"],
            "Corroborated": r["updated_prospects"],
            "Status": r["status"],
        } for r in runs]),
        hide_index=True, width="stretch",
        column_config={
            "Searches": st.column_config.NumberColumn(format="localized"),
            "Articles": st.column_config.NumberColumn(format="localized"),
        },
    )


# ---------------------------------------------------------------------------
# Page: prospect list
# ---------------------------------------------------------------------------


SORTS = {
    "Priority (who to call first)": ("priority", False),
    "Estimated net worth (highest first)": ("investable_mid_gbp", False),
    "Estimated annual income (highest first)": ("annual_income_gbp", False),
    "Company revenue (highest first)": ("company_revenue_gbp", False),
    "Confidence (highest first)": ("confidence", False),
    "Most recently found": ("first_seen", False),
    "Name (A–Z)": ("full_name", True),
}


#: One-click answers to the questions an advisor actually opens the app with.
#: Nine filter controls can express all of these; none of them should have to be
#: reassembled every morning.
QUICK_VIEWS: dict[str, str] = {
    "Everyone": "",
    "Call this week": "New arrivals that already clear £7.5m — the freshest actionable names.",
    "£7.5m+ now": "Estimated investable assets over the qualifying threshold.",
    "£1m+ a year": "Qualifying on income rather than assets — dividends and listed pay.",
    "Land & estates": "Agricultural, estate and landowner wealth.",
    "Filed evidence": "Only records whose strongest source is a statutory filing.",
    "Needs checking": "Names that appeared near a deal but have not been verified — "
                      "no company, no role, or a single thin source. Research these "
                      "before they earn a place in the book.",
}


def _apply_quick_view(frame: pd.DataFrame, view_name: str) -> pd.DataFrame:
    if view_name == "Call this week":
        return frame[
            (frame["first_seen_week"] == db.iso_week())
            & (frame["investable_mid_gbp"].fillna(0) >= QUALIFYING_THRESHOLD_GBP)
        ]
    if view_name == "£7.5m+ now":
        return frame[frame["investable_mid_gbp"].fillna(0) >= QUALIFYING_THRESHOLD_GBP]
    if view_name == "£1m+ a year":
        return frame[frame["annual_income_gbp"].fillna(0) >= ANNUAL_INCOME_THRESHOLD_GBP]
    if view_name == "Land & estates":
        return frame[frame["wealth_source"].fillna("") == "Land, estate or farming"]
    if view_name == "Filed evidence":
        return frame[frame["evidence_grade"] == "High"]
    if view_name == "Needs checking":
        return frame[frame["verification_state"] == UNCONFIRMED]
    return frame


def _filters(frame: pd.DataFrame) -> pd.DataFrame:
    """Search and quick views up front; the nine-control panel folded away.

    The detailed filters were costing half the screen before any data appeared.
    They are still one click down, but the common case — "show me who to ring" —
    is now a single button.
    """
    head = st.columns([2.4, 3.2, 1.6])
    search = head[0].text_input(
        "Search", placeholder="Name, company, town or address", label_visibility="collapsed",
    )
    quick = head[1].segmented_control(
        "Quick view", list(QUICK_VIEWS), default="Everyone",
        label_visibility="collapsed",
    ) or "Everyone"
    sort_label = head[2].selectbox("Sort by", list(SORTS), label_visibility="collapsed")
    if QUICK_VIEWS[quick]:
        st.caption(QUICK_VIEWS[quick])

    with st.expander("More filters"):
        return _detailed_filters(frame, search=search, quick=quick, sort_label=sort_label)


def _detailed_filters(
    frame: pd.DataFrame, *, search: str, quick: str, sort_label: str
) -> pd.DataFrame:
    if True:
        top = st.columns([1.4, 1.4, 1.5])
        countries = top[0].multiselect(
            "Country", sorted(frame["country"].dropna().unique()), placeholder="Any country",
        )
        groups = top[1].multiselect(
            "Region", [g for g in GROUP_ORDER if g in set(frame["market_group"].dropna())],
            placeholder="Any region",
        )
        markets_top = top[2].multiselect(
            "Market", sorted(frame["market_name"].dropna().unique()), placeholder="Any market",
        )

        mid = st.columns([1.4, 1.3, 1.2, 1.2, 1.3])
        markets = markets_top
        bands = mid[1].multiselect(
            "Wealth band", [b for b in BAND_ORDER if b in set(frame["wealth_band"])],
            placeholder="Any wealth band",
        )
        statuses = mid[2].multiselect(
            "Company", [s for s in ("Public", "Private")
                        if s in set(frame["company_status"].dropna())],
            placeholder="Public or private",
        )
        grades = mid[3].multiselect(
            "Evidence", [g for g in GRADE_ORDER if g in set(frame["evidence_grade"].dropna())],
            placeholder="Any evidence grade",
            help="How direct the strongest source is: a filing, the press, or a rich list.",
        )
        cohorts = mid[4].multiselect(
            "Cohort", sorted(frame["cohort"].dropna().unique()), placeholder="Any cohort",
        )

        checks = st.columns([1.5, 1.5])
        states = checks[0].multiselect(
            "Verification",
            [s for s in STATE_ORDER if s in set(frame["verification_state"].dropna())],
            default=[s for s in DEFAULT_VISIBLE_STATES
                     if s in set(frame["verification_state"].dropna())],
            help="Confirmed = matched to a company register. Corroborated = company "
                 "and role established from reliable reporting. Unconfirmed = a name "
                 "that appeared near a deal, and nothing more.",
        )
        sectors = checks[1].multiselect(
            "Sector", [s for s in SECTORS if s in set(frame["sector"].dropna())],
            placeholder="Any sector",
        )

        wealth_sources = st.multiselect(
            "Where the wealth comes from",
            sorted(frame["wealth_source"].dropna().unique()),
            placeholder="Any source — private ownership, listed pay, land and estates, "
                        "liquidity events",
        )
        found_via = st.multiselect(
            "Found via", sorted(frame["primary_event"].dropna().unique()),
            placeholder="Any wealth event",
        )

        bottom = st.columns([1.6, 1.15, 1.15, 1.15])
        min_confidence = bottom[0].slider("Minimum confidence", 0, 100, 0, step=5)
        only_estimated = bottom[1].toggle(
            "Has a figure", value=False,
            help="Hide records the app declined to put a number on.",
        )
        only_located = bottom[2].toggle(
            "Location stated", value=False,
            help="Hide records whose market was inferred from the search rather than "
                 "named in the article.",
        )
        only_verified = bottom[3].toggle(
            "Companies House verified", value=False,
            help="Only people matched to a filed officer or PSC record.",
        )

    view = _apply_quick_view(frame, quick).copy()
    if search:
        needle = search.lower()
        haystacks = ["full_name", "company", "locality", "market_name", "address",
                     "ch_company_name", "ch_registered_office"]
        mask = pd.Series(False, index=view.index)
        for column in haystacks:
            if column in view.columns:
                mask |= view[column].fillna("").astype(str).str.lower().str.contains(
                    needle, regex=False
                )
        view = view[mask]
    if countries:
        view = view[view["country"].isin(countries)]
    if groups:
        view = view[view["market_group"].isin(groups)]
    if markets:
        view = view[view["market_name"].isin(markets)]
    if bands:
        view = view[view["wealth_band"].isin(bands)]
    if statuses:
        view = view[view["company_status"].isin(statuses)]
    if grades:
        view = view[view["evidence_grade"].isin(grades)]
    # "Needs checking" is explicitly asking for the unverified, so the default
    # verification filter must not silently empty it.
    if states and quick != "Needs checking":
        view = view[view["verification_state"].isin(states)]
    if sectors:
        view = view[view["sector"].isin(sectors)]
    if cohorts:
        view = view[view["cohort"].isin(cohorts)]
    if wealth_sources:
        view = view[view["wealth_source"].isin(wealth_sources)]
    if found_via:
        view = view[view["primary_event"].isin(found_via)]
    view = view[view["confidence"] >= min_confidence]
    if only_estimated:
        view = view[view["investable_mid_gbp"].notna()]
    if only_located:
        view = view[view["market_source"] == "text"]
    if only_verified:
        view = view[view["ch_officer_name"].notna()]

    column, ascending = SORTS[sort_label]
    return view.sort_values(column, ascending=ascending, na_position="last")


def _company_export(view: pd.DataFrame) -> str:
    """Company-anchored CSV, for pushing into a company research platform.

    Keyed on the company and its registration number rather than on the person,
    because that is what a company database can actually resolve. A person\'s name
    on its own matches nothing.
    """
    if view.empty:
        return "no companies to export\n"

    export = pd.DataFrame({
        "company_name": view["ch_company_name"].fillna(view["company"]),
        "companies_house_number": view["company_number"].fillna(view["ch_company_number"]),
        "company_status": view["company_status"].fillna(""),
        "sector": view["sector"].fillna(""),
        "sector_basis": view["sector_basis"].fillna(""),
        "sic_codes": view["sic_codes"].fillna(""),
        "registered_office": view["ch_registered_office"].fillna(view["address"]),
        "country": view["country"].fillna(""),
        "market": view["market_name"].fillna(""),
        "locality": view["locality"].fillna(""),
        "person_name": view["full_name"],
        "person_role": view["job_title"].fillna(""),
        "ownership_band_filed": view["ch_ownership_band"].fillna(""),
        "verification_state": view["verification_state"].fillna(""),
        "evidence_grade": view["evidence_grade"].fillna(""),
        "confidence_0_100": view["confidence"],
        "wealth_event": view["primary_event"].fillna(""),
        "wealth_source": view["wealth_source"].fillna(""),
        "est_investable_gbp_ESTIMATE": view["investable_mid_gbp"],
        "est_investable_low_gbp_ESTIMATE": view["investable_low_gbp"],
        "est_investable_high_gbp_ESTIMATE": view["investable_high_gbp"],
        "est_annual_income_gbp_ESTIMATE": view["annual_income_gbp"],
        "known_adviser": view["known_adviser"].fillna(""),
        "latest_newsflow": view["latest_newsflow"].fillna(""),
        "first_seen": view["first_seen"],
    })
    sources = load_sources_index()
    export["source_urls"] = [
        " | ".join(s["url"] for s in sources.get(int(i), []))
        for i in view["id"]
    ]
    header = (
        "# Company-anchored export. Columns ending _ESTIMATE are MODELLED estimates\n"
        "# derived from public reporting, not verified statements of wealth.\n"
        "# verification_state: Confirmed = matched to a company register;\n"
        "# Corroborated = company and role from reliable reporting; Unconfirmed = a name.\n"
    )
    return header + export.to_csv(index=False)


def page_list(frame: pd.DataFrame) -> None:
    st.title("Prospect list")
    if frame.empty:
        st.info("Nothing here yet. Run a search from **Find prospects**, or bring a list in through **Add & import**.")
        return

    view = _filters(frame)
    st.caption(f"Showing **{len(view)}** of {len(frame)} people on file.")
    if view.empty:
        st.warning("No one matches those filters.")
        return

    sources = load_sources_index()

    def first_link(prospect_id: int) -> str | None:
        # An imported row carries an ``import://`` reference: meaningful to the
        # book, a dead link in a browser. Only real web addresses become links.
        for source in sources.get(int(prospect_id), []):
            if is_web_link(source.get("url")):
                return str(source["url"])
        return None

    # Every monetary column is named "Est." because a bare number in a table
    # reads as a fact no matter what the footnote says.
    table = pd.DataFrame({
        "Priority": pd.to_numeric(view["priority"], errors="coerce"),
        "Name": view["full_name"],
        "Role": view["job_title"].fillna(""),
        "Company / vehicle": view["company"].fillna(""),
        "Co. type": view["company_status"].fillna("—"),
        "Where": view.apply(where_text, axis=1),
        # Coerced to numeric so an all-empty column renders blank rather than a
        # column of the word "None" — which reads as a stated fact about someone's
        # revenue, and is the same class of error as showing £0.
        "Est. net worth": pd.to_numeric(view["investable_mid_gbp"], errors="coerce"),
        "Co. revenue": pd.to_numeric(view["company_revenue_gbp"], errors="coerce"),
        "Est. income": pd.to_numeric(view["annual_income_gbp"], errors="coerce"),
        "Verified": view["verification_state"].fillna("Unconfirmed"),
        "Sector": view["sector"].fillna("—"),
        "Evidence": view["evidence_grade"].fillna("Low"),
        "Confidence": view["confidence"],
        "Why now": view["why_now"].fillna(""),
        "Wealth source": view["wealth_source"].fillna("—"),
        "Latest newsflow": view["latest_newsflow"].fillna(""),
        "Pipeline": view["status"],
        "Source": view["id"].map(first_link),
    }).reset_index(drop=True)

    selection = st.dataframe(
        money_display(table, ["Est. net worth", "Co. revenue", "Est. income"]),
        hide_index=True,
        width="stretch",
        height=min(520, 60 + 36 * len(table)),
        on_select="rerun",
        selection_mode="single-row",
        column_config={
            "Priority": st.column_config.ProgressColumn(
                "Priority", min_value=0, max_value=100, format="%d", width="small",
                help="Who to call first: wealth, verification, how recent the money is, "
                     "how warm the route in is, and whether they are in your patch.",
            ),
            "Name": st.column_config.TextColumn(pinned=True, width="medium"),
            "Role": st.column_config.TextColumn(width="small"),
            "Company / vehicle": st.column_config.TextColumn(width="medium"),
            "Co. type": st.column_config.TextColumn(
                "Co. type", width="small",
                help="Public (traded shares) or private (Companies House only).",
            ),
            "Where": st.column_config.TextColumn(width="medium"),
            "Est. net worth": st.column_config.NumberColumn(
                "Est. net worth",
                help="ESTIMATE of investable assets, in GBP, modelled from public "
                     "reporting — not a verified figure. Blank means the app declined "
                     "to put a number on the evidence; it never means zero.",
            ),
            "Co. revenue": st.column_config.NumberColumn(
                "Co. revenue",
                help="Filed or reported company turnover. Blank means not publicly "
                     "disclosed.",
            ),
            "Est. income": st.column_config.NumberColumn(
                "Est. income",
                help="Annual remuneration or attributable dividend. Disclosed exactly "
                     "for listed-company pay; modelled from an assumed stake for "
                     "dividends. Blank means not publicly disclosed.",
            ),
            "Verified": st.column_config.TextColumn(
                "Verified", width="small",
                help="Confirmed = matched to a company register. Corroborated = "
                     "company and role established from reliable reporting. "
                     "Unconfirmed = a name that appeared near a deal.",
            ),
            "Sector": st.column_config.TextColumn(width="medium"),
            "Evidence": st.column_config.TextColumn(
                "Evidence", width="small",
                help="How direct the strongest source is. High = a statutory filing "
                     "(PSC register, accounts, annual report, Land Registry). "
                     "Medium = trade or business press. Low = a rich-list mention with "
                     "no breakdown.",
            ),
            "Confidence": st.column_config.ProgressColumn(
                "Confidence", min_value=0, max_value=100, format="%d", width="small",
                help="How well evidenced the record is overall, across six dimensions — "
                     "a separate question from how wealthy the person is.",
            ),
            "Why now": st.column_config.TextColumn(width="large"),
            "Wealth source": st.column_config.TextColumn(width="medium"),
            "Latest newsflow": st.column_config.TextColumn(width="large"),
            "Pipeline": st.column_config.TextColumn(width="small"),
            "Source": st.column_config.LinkColumn(
                "Source", display_text="open", width="small",
                help="The first web citation on the record. The full list is on the "
                     "record itself.",
            ),
        },
    )
    # Streamlit prints a greyed "None" for an empty numeric cell. In a table of
    # wealth figures that is one glance away from being read as data, so it is
    # spelled out — once, alongside how to use the table.
    st.caption(
        "Tick the box at the start of a row to open that person's record below. Click a "
        "heading to sort; columns continue to the right. Every figure is a modelled "
        "estimate unless the record says it was disclosed; “not disclosed” never means zero."
    )

    # Which record is open is remembered by person, not by row position: saving a
    # note refreshes the table, and a row number would then point at someone else.
    ids = [int(i) for i in view["id"]]
    picked = tuple(
        ids[r] for r in (getattr(selection, "selection", {}).get("rows", []) or [])
        if r < len(ids)
    )
    if picked != st.session_state.get("_list_selection"):
        st.session_state["_list_selection"] = picked
        if picked:
            st.session_state["open_prospect"] = picked[0]

    downloads = st.columns([1, 1, 2])
    downloads[0].download_button(
        "Download this list as CSV",
        data=(
            "# All monetary figures are MODELLED ESTIMATES from public reporting, "
            "not verified statements of wealth.\n"
            + view.drop(columns=["lat", "lon"], errors="ignore").to_csv(index=False)
        ),
        file_name=f"prospects-{datetime.now(timezone.utc):%Y-%m-%d}.csv",
        mime="text/csv",
        width="stretch",
    )
    researchable = view[view["company"].notna()]
    downloads[1].download_button(
        "Company list for research",
        data=_company_export(researchable),
        file_name=f"companies-{datetime.now(timezone.utc):%Y-%m-%d}.csv",
        mime="text/csv",
        disabled=researchable.empty,
        width="stretch",
        help="One row per person, keyed on the company and its Companies House "
             "number — the shape a company database can look up. Records with no "
             "company are left out, because they cannot be researched anywhere.",
    )
    downloads[2].caption(
        f"{len(researchable)} of {len(view)} shown records name a company and can be "
        f"looked up in Companies House or a company database. The rest are names "
        f"without an entity behind them."
    )

    open_id = st.session_state.get("open_prospect")
    match = frame[frame["id"] == open_id] if open_id is not None else frame.iloc[0:0]
    st.divider()
    if match.empty:
        st.caption("No record open. Tick a row above, or open someone by name:")
        _open_by_name(view)
        return

    bar = st.columns([4, 1])
    with bar[0]:
        _open_by_name(view)
    if bar[1].button("Close record", width="stretch"):
        st.session_state.pop("open_prospect", None)
        st.rerun()
    with guarded("This record"):
        render_record(match.iloc[0])


def _open_by_name(view: pd.DataFrame) -> None:
    names = {int(r["id"]): f"{r['full_name']}" + (f" — {r['company']}" if isinstance(r["company"], str) and r["company"] else "")
             for _, r in view.iterrows()}

    def choose() -> None:
        chosen = st.session_state.get("_open_by_name")
        if chosen is not None:
            st.session_state["open_prospect"] = chosen
        st.session_state["_open_by_name"] = None

    st.selectbox(
        "Open a record", list(names), index=None, format_func=names.get,
        placeholder="Type a name to open their record…", label_visibility="collapsed",
        key="_open_by_name", on_change=choose,
    )


# ---------------------------------------------------------------------------
# Page: overview
# ---------------------------------------------------------------------------


def page_overview(frame: pd.DataFrame) -> None:
    st.title("Overview")
    st.caption(
        "People who appear to have recently come into significant wealth, found by "
        "searching public news across the markets you selected."
    )

    if frame.empty:
        st.info(
            "**Nothing on file yet.** Open **Find prospects** and press *Start "
            "searching* — the default sweeps Bristol, Bath, London and the South West."
        )
        return

    qualifying = frame[frame["investable_mid_gbp"].fillna(0) >= QUALIFYING_THRESHOLD_GBP]
    pre_liquidity = frame[
        (frame["gross_mid_gbp"].fillna(0) >= PRIORITY_THRESHOLD_GBP)
        & (frame["investable_mid_gbp"].fillna(0) < QUALIFYING_THRESHOLD_GBP)
    ]
    this_week = frame[frame["first_seen_week"] == db.iso_week()]
    unestimated = frame[frame["investable_mid_gbp"].isna()]

    columns = st.columns(6)
    columns[0].metric("On file", len(frame))
    columns[1].metric("New this week", len(this_week))
    columns[2].metric("Qualifying", len(qualifying), help="£7.5m+ estimated investable assets")
    columns[3].metric("Pre-liquidity", len(pre_liquidity), help="£15m+ gross, not yet liquid")
    addressable = qualifying["investable_mid_gbp"].sum()
    columns[4].metric("Est. addressable", fmt_gbp(addressable) if addressable else "—",
                      help="Sum of ESTIMATED investable assets across qualifying people.")
    columns[5].metric("Verified", int(frame["ch_officer_name"].notna().sum()),
                      help="Matched to a filed Companies House record")
    estimate_disclaimer()

    with db.connect() as conn:
        waiting = db.company_leads(conn, unresolved_only=True)
    if waiting:
        st.info(
            f"**{len(waiting)} transactions are sitting behind an unnamed company** — "
            f"{fmt_gbp(sum(r['amount_gbp'] or 0 for r in waiting))} of reported value with "
            f"nobody attached. Open **Find the owner** to ask the register who they are."
        )

    if len(unestimated):
        st.caption(
            f"**{len(unestimated)} of these carry no monetary figure.** That is deliberate: "
            "the evidence found indicates wealth without sizing it, and each record states "
            "the reason rather than inventing a number."
        )

    st.divider()
    left, right = st.columns([1.2, 1])

    with left:
        st.subheader("Estimated addressable assets by market")
        by_market = (
            frame.assign(investable=frame["investable_mid_gbp"].fillna(0))
            .groupby(["market_name", "country"], as_index=False)
            .agg(prospects=("id", "count"), addressable=("investable", "sum"))
            .sort_values("addressable", ascending=False)
            .head(25)
        )
        chart = (
            alt.Chart(by_market)
            .mark_bar(color=ACCENT, cornerRadiusEnd=3)
            .encode(
                x=alt.X("addressable:Q", title="Estimated addressable (£)"),
                # labelOverlap=False forces every market to keep its label;
                # Altair otherwise drops alternates and the chart becomes unreadable.
                y=alt.Y("market_name:N", sort="-x", title=None,
                        axis=alt.Axis(labelOverlap=False, labelLimit=190)),
                tooltip=[
                    alt.Tooltip("market_name:N", title="Market"),
                    alt.Tooltip("country:N", title="Country"),
                    alt.Tooltip("prospects:Q", title="People"),
                    alt.Tooltip("addressable:Q", title="Addressable (£)", format=","),
                ],
            )
            .properties(height=max(240, 24 * len(by_market)))
        )
        st.altair_chart(chart, width="stretch")

    with right:
        st.subheader("By country")
        by_country = (
            frame.assign(investable=frame["investable_mid_gbp"].fillna(0))
            .groupby("country", as_index=False)
            .agg(people=("id", "count"), addressable=("investable", "sum"))
            .sort_values("people", ascending=False)
        )
        st.dataframe(
            money_display(by_country.rename(columns={
                "country": "Country", "people": "People", "addressable": "Est. addressable",
            }), ["Est. addressable"]),
            hide_index=True, width="stretch",
        )

        st.subheader("Wealth bands")
        bands = frame.groupby("wealth_band", as_index=False).agg(people=("id", "count"))
        band_chart = (
            alt.Chart(bands)
            .mark_bar(color=ACCENT, cornerRadiusEnd=3)
            .encode(
                x=alt.X("wealth_band:N", sort=BAND_ORDER, title=None,
                        axis=alt.Axis(labelAngle=-35)),
                y=alt.Y("people:Q", title="People"),
                tooltip=["wealth_band:N", "people:Q"],
            )
            .properties(height=230)
        )
        st.altair_chart(band_chart, width="stretch")

    st.divider()
    map_column, event_column = st.columns([1.4, 1])
    with map_column:
        st.subheader("Where they are")
        located = frame.dropna(subset=["lat", "lon"])
        if located.empty:
            st.caption("No prospects with a resolved market yet.")
        else:
            try:
                st.map(located[["lat", "lon"]], size=24000, color=ACCENT)
                st.caption(
                    "Plotted at the centre of each market. Sources give a town or a "
                    "county, not a street address."
                )
            except Exception:
                # Map tiles come from an external host; on a locked-down network the
                # table is a perfectly good substitute and must not break the page.
                st.caption("Map tiles unavailable on this network — showing counts instead.")
                st.dataframe(
                    located.groupby("market_name", as_index=False)
                    .agg(people=("id", "count"))
                    .rename(columns={"market_name": "Market", "people": "People"}),
                    hide_index=True, width="stretch",
                )
    with event_column:
        st.subheader("How they were found")
        events = (
            frame.groupby("primary_event", as_index=False)
            .agg(people=("id", "count"))
            .sort_values("people", ascending=False)
        )
        st.dataframe(
            events.rename(columns={"primary_event": "Wealth event", "people": "People"}),
            hide_index=True, width="stretch",
        )

    st.divider()
    st.subheader("Highest estimated investable assets")
    ranked = frame.sort_values("investable_mid_gbp", ascending=False, na_position="last").head(20)
    st.dataframe(
        money_display(pd.DataFrame({
            "Name": ranked["full_name"],
            "Company": ranked["company"].fillna("—"),
            "Where": ranked.apply(where_text, axis=1),
            "Found via": ranked["primary_event"].fillna("—"),
            "Est. investable": pd.to_numeric(ranked["investable_mid_gbp"], errors="coerce"),
            "Band": ranked["wealth_band"],
            "Confidence": ranked["confidence"],
        }), ["Est. investable"], missing="not estimated"),
        hide_index=True, width="stretch",
        column_config={
            "Confidence": st.column_config.ProgressColumn(
                min_value=0, max_value=100, format="%d"
            ),
        },
    )


# ---------------------------------------------------------------------------
# Page: weekly report
# ---------------------------------------------------------------------------


def page_unnamed_leads() -> None:
    st.title("Find the owner")
    st.caption(
        "Real transactions the press reported without naming anyone. These are not "
        "waste — a £30m disposal whose owner nobody wrote down is still a £30m "
        "disposal, and the register knows whose it was."
    )

    with db.connect() as conn:
        open_leads = [dict(r) for r in db.company_leads(conn, unresolved_only=True)]
        done_leads = [dict(r) for r in db.company_leads(conn)]
    resolved = [r for r in done_leads if r["resolved_at"]]

    columns = st.columns(4)
    columns[0].metric("Awaiting a name", len(open_leads))
    columns[1].metric("Already looked up", len(resolved))
    columns[2].metric(
        "People found this way", int(sum(r["people_found"] or 0 for r in resolved))
    )
    columns[3].metric(
        "Value with no name",
        fmt_gbp(sum(r["amount_gbp"] or 0 for r in open_leads)),
        help="Total reported transaction value sitting behind unnamed companies.",
    )

    if not companies_house_available():
        st.warning(
            "**Companies House is not connected, so these cannot be resolved "
            "automatically.** With a key, one click turns a company into its filed "
            "owners — names, roles and shareholding bands stated rather than assumed. "
            "It is the single highest-yield thing this app can do for finding people. "
            "See **How it works** for the two-minute setup."
        )

    if not open_leads:
        st.info(
            "Nothing waiting. Every transaction found so far either named someone or "
            "has already been looked up."
        )
    else:
        st.divider()
        st.subheader(f"{len(open_leads)} companies to put a name to")
        st.caption(
            "Sorted by reported value — the biggest unnamed transactions first, since "
            "those are where a name is worth the most."
        )
        for lead in open_leads[:40]:
            named = bool(lead["company"])
            heading = (
                f"**{lead['company'] if named else 'Company not named in the source'}** · "
                f"{lead['market_name'] or '—'} · "
                f"{fmt_gbp(lead['amount_gbp']) if lead['amount_gbp'] else 'value not reported'}"
                f" · {lead['event_label'] or 'transaction'}"
            )
            with st.container(border=True):
                left, right = st.columns([3.2, 1])
                left.markdown(heading)
                left.caption(lead["title"])
                left.markdown(
                    f"[Read the source]({lead['url']}) — {lead['publisher'] or 'source'}"
                )
                uk = (lead["country"] or "") == "United Kingdom"
                if right.button(
                    "Find the owners",
                    key=f"resolve_{lead['id']}",
                    disabled=not (companies_house_available() and uk and named),
                    width="stretch",
                    help=(
                        "The source names no company, so there is nothing to look up — "
                        "read the article and identify it by hand."
                        if not named else
                        None if uk else
                        "Companies House covers the UK only. Resolve this one by hand."
                    ),
                ):
                    with st.spinner(f"Asking the register about {lead['company']}…"):
                        result = resolve_lead_with_register(int(lead["id"]))
                    refresh()
                    if result["created"]:
                        st.success(result["note"])
                    else:
                        st.warning(result["note"])
                    st.rerun()
                if named:
                    right.caption(
                        f"[Search manually]"
                        f"(https://find-and-update.company-information.service.gov.uk/search?q="
                        f"{str(lead['company']).replace(' ', '+')})"
                    )

    if resolved:
        st.divider()
        with st.expander(f"{len(resolved)} already looked up"):
            st.dataframe(
                pd.DataFrame([{
                    "Company": r["company"],
                    "Where": r["market_name"] or "—",
                    "Value": fmt_gbp(r["amount_gbp"]),
                    "People found": r["people_found"],
                    "Outcome": r["resolved_note"] or "",
                } for r in resolved]),
                hide_index=True, width="stretch",
                column_config={"Outcome": st.column_config.TextColumn(width="large")},
            )


def page_screened_out() -> None:
    st.title("Screened out")
    st.caption(
        "Candidates the app refused, and why. Kept on record rather than silently "
        "dropped — “why is nobody from Hampshire showing up” is only answerable if "
        "the rejections are visible."
    )

    with db.connect() as conn:
        counts = [dict(r) for r in db.exclusion_counts(conn)]
        rows = [dict(r) for r in db.exclusions(conn, limit=500)]

    rules = {
        "celebrity": (
            "Sport, entertainment and broadcasting",
            "Not a realistic introduction. Already served through networks the firm "
            "does not sit in, a public profile that makes cold outreach unworkable, "
            "and reported figures that are usually aggregator guesswork.",
        ),
        "mega-wealth": (
            f"Above the £{MEGA_WEALTH_CEILING_GBP / 1_000_000:.0f}m ceiling",
            "National rich-list names are not addressable by a regional private-client "
            "firm. The target is owner-managers and family businesses who are not "
            "household names.",
        ),
        "banned-source": (
            "Disqualifying source",
            "“Estimated net worth” aggregators publish numbers with no method, no "
            "filing behind them and no correction process. Refused on the domain "
            "rather than the content, for anyone.",
        ),
    }

    if counts:
        columns = st.columns(len(rules))
        by_rule = {c["rule"]: c["n"] for c in counts}
        for index, (key, (label, why)) in enumerate(rules.items()):
            columns[index].metric(label, by_rule.get(key, 0), help=why)
    else:
        st.info(
            "Nothing has been screened out yet. The rules are live — they simply have "
            "not had to fire."
        )

    with st.expander("The rules, in full"):
        for key, (label, why) in rules.items():
            st.markdown(f"**{label}** — {why}")
        st.markdown("**Refused source domains**")
        st.code("\n".join(sorted(BANNED_SOURCE_DOMAINS)), language="text")

    if rows:
        st.divider()
        st.subheader(f"{len(rows)} refused candidate(s)")
        st.dataframe(
            pd.DataFrame([{
                "When": r["created_at"][:10],
                "Rule": r["rule"],
                "Name": r["person_name"] or "—",
                "Company": r["company"] or "—",
                "Headline": r["title"],
                "Publisher": r["publisher"] or "—",
                "Why": r["reason"],
                "Source": r["url"] or "",
            } for r in rows]),
            hide_index=True, width="stretch",
            height=min(420, 60 + 36 * len(rows)),
            column_config={
                "Why": st.column_config.TextColumn(width="large"),
                "Headline": st.column_config.TextColumn(width="large"),
                "Source": st.column_config.LinkColumn("Source", display_text="open"),
            },
        )


def page_research_doc() -> None:
    st.title("Weekly research document")
    st.caption(
        "Generated at the start of each week: who is new, why they qualify, what "
        "each estimate rests on, and what changed for people already on the list."
    )

    stored = load_reports()
    weeks = [r["week"] for r in stored]
    current = db.iso_week()

    columns = st.columns([2, 1, 1])
    chosen = columns[0].selectbox(
        "Week",
        options=[current] + [w for w in weeks if w != current],
        format_func=lambda w: f"{w}{'  (current)' if w == current else ''}",
    )
    if columns[1].button("Generate / refresh", width="stretch"):
        with st.spinner("Building the research document…"):
            generate_and_store(chosen)
        refresh()
        st.rerun()

    record = next((r for r in stored if r["week"] == chosen), None)
    if record is None:
        with st.spinner("Building the research document…"):
            _, markdown = generate_and_store(chosen)
        refresh()
    else:
        markdown = record["markdown"]

    columns[2].download_button(
        "Download (Markdown)",
        data=markdown,
        file_name=f"prospect-research-{chosen}.md",
        mime="text/markdown",
        width="stretch",
    )

    st.divider()
    st.markdown(markdown)


# ---------------------------------------------------------------------------
# Page: how it works
# ---------------------------------------------------------------------------


def page_methodology() -> None:
    st.title("How it works")
    st.caption(
        f"Research model v{MODEL_VERSION}. How every figure is produced, and where it "
        f"can be wrong."
    )

    st.error(
        "**Every monetary figure in this app is an estimate, not a fact.** It tells you "
        "what a model infers from public reporting, and how much of that inference is "
        "evidenced. Ranges are wide on purpose. Before acting on a record, open its "
        "sources and check them."
    )

    st.subheader("What a sweep actually does")
    st.markdown(
        """
1. **Builds the searches.** Each of the 14 wealth events is crossed with every
   selected market. Town names are folded into each query with `OR`, so an article
   that only says "Newton Abbot" is still found by a Devon search — without needing
   a separate request per town.
2. **Reads publisher feeds.** Google News RSS plus a fixed list of UK regional, US
   and Gulf business publishers. Feeds only: no article bodies are scraped and no
   paywall is circumvented.
3. **Locates each article.** Geography is resolved against all 69 markets and then
   checked against your selection. An article that positively names somewhere out of
   scope is discarded. An article that names nowhere at all inherits the market from
   the search that found it — flagged as *inferred*, and scored lower for it.
4. **Extracts the event.** Transaction values in ~25 currencies, named individuals
   and their roles, and the company. The extractor prefers finding nothing to
   guessing: a false name here becomes a wrong claim about a real person.
5. **Estimates, or declines to.** Where a figure can be derived, the arithmetic is
   recorded in plain English. Where it cannot, the app says why and stores no number.
6. **Verifies, if it can.** UK companies are checked against Companies House: the PSC
   register replaces the assumed shareholding with a filed band, the officers list
   confirms the person, and the profile supplies the registered office address.
7. **Scores confidence** across six dimensions, and states the single best action to
   raise it.
        """
    )

    st.subheader("Search depths")
    st.dataframe(
        pd.DataFrame([{
            "Depth": d.label,
            "Events": len(d.event_keys) or len(EVENT_TEMPLATES),
            "Towns per market": str(d.places) if d.places else "market name only",
            "Windows": ", ".join(f"{w}d" for w in d.windows),
            "What it is for": d.description,
        } for d in DEPTHS]),
        hide_index=True, width="stretch",
    )

    st.subheader("Where it looks")
    st.dataframe(
        pd.DataFrame([{
            "Market": m.name, "Region": m.group, "Country": m.country,
            "Currency": m.currency, "Places recognised": len(m.places),
        } for m in ALL_MARKETS]),
        hide_index=True, width="stretch", height=320,
    )
    st.caption(
        f"{len(ALL_MARKETS)} markets in {len(GROUP_ORDER)} regions. The presets in "
        f"**Find prospects** are just saved selections of these."
    )

    st.subheader("Wealth events searched")
    st.dataframe(
        pd.DataFrame([
            {"Event": t.label, "Weight": t.weight, "What it means": t.meaning}
            for t in EVENT_TEMPLATES
        ]),
        hide_index=True, width="stretch",
    )

    st.subheader("Evidence grades")
    st.markdown(
        "Separate from the confidence score, and answering a blunter question: "
        "**am I reading a filing, or a journalist's estimate?** A record inherits "
        "the grade of its strongest source."
    )
    st.dataframe(
        pd.DataFrame([
            {"Grade": t.grade, "Source": t.label, "What it establishes": t.meaning}
            for t in TIERS
        ]),
        hide_index=True, width="stretch",
    )

    st.subheader("Who is deliberately excluded")
    st.markdown(
        f"""
A prospect list is judged as much by what it keeps out. Three kinds of record are
refused before they can be created, each logged on the **Screened out** page:

- **Sport, entertainment and broadcasting.** Not realistic introductions: already
  served through networks the firm does not sit in, and a public profile makes
  cold outreach unworkable. The reported figures are usually guesswork anyway.
- **Above £{MEGA_WEALTH_CEILING_GBP / 1_000_000:.0f}m gross.** National rich-list
  names are not addressable by a regional private-client firm. The target is
  owner-managers, second-generation family businesses, mid-market exits and
  landowners who are not household names.
- **"Estimated net worth" aggregators.** {len(BANNED_SOURCE_DOMAINS)} domains are
  refused outright, on the domain rather than the content — they publish numbers
  with no method, no filing behind them and no correction process. Not weak
  evidence: not evidence.
        """
    )

    st.subheader("The assumption that matters most")
    st.warning(
        "Press coverage reports that a company was sold and for how much. It almost "
        "never reports what share of that reached a named individual. So the "
        "shareholding is **assumed** — 55% by default, range 35–75% — and that "
        "assumption is the largest source of error in any figure this app produces. "
        "Verifying it on the Companies House PSC register replaces the assumption with "
        "a filed band, and is the single highest-value thing you can do to a record."
    )

    st.subheader("Model assumptions")
    st.dataframe(
        pd.DataFrame([
            {"Assumption": key, "Value": getattr(MODEL, key, "—"), "Effect": note}
            for key, note in ASSUMPTION_NOTES.items()
        ]),
        hide_index=True, width="stretch",
    )
    st.caption("Change these in `wealthscan/config.py` and re-run to see the effect.")

    st.subheader("Cohorts")
    st.markdown(
        f"""
- **Qualifying** — estimated investable assets of {fmt_gbp(QUALIFYING_THRESHOLD_GBP)} or
  more. A mandate that could be written today.
- **Pre-liquidity founder** — {fmt_gbp(PRIORITY_THRESHOLD_GBP)}+ gross, but most of it
  unrealised equity. Not a mandate now; the relationship has to exist before the exit.
- **Research lead** — wealth indicated but not sizeable from the evidence found. The
  record says why.
        """
    )

    st.subheader("Connecting Companies House")
    if not companies_house_available():
        st.markdown(
            """
Optional, and free. It is the one source that can turn an assumed shareholding into a
filed fact, and the only one that supplies a real address.

1. Register at **developer.company-information.service.gov.uk** and create an
   application.
2. Create a **REST API key** for the *live* environment. A streaming key or a
   test-sandbox key will be rejected.
3. Set it as an environment variable before starting the app:

   ```bash
   export COMPANIES_HOUSE_API_KEY="your-key-here"
   streamlit run streamlit_app.py
   ```

   On Streamlit Community Cloud, put it in **Settings → Secrets** instead:

   ```toml
   COMPANIES_HOUSE_API_KEY = "your-key-here"
   ```

Never paste the key into a file you commit, and never into a chat window. If a key has
been shared anywhere, revoke it in the developer portal and issue a new one.
            """
        )
    else:
        if st.button("Test the connection"):
            with st.spinner("Asking the register…"):
                ok, message = companies_house_status()
            (st.success if ok else st.error)(message)
        st.caption(
            "A key is configured. It is only ever used for UK companies — running a "
            "Dubai or Texas business through a British register would either find "
            "nothing or, worse, find a same-named British company and attach the wrong "
            "number to a real person."
        )

    st.subheader("Sources, and lawful use")
    st.markdown(
        """
Only publicly available, lawfully obtainable information is used.

- **Google News RSS** — the discovery engine. Publisher-provided feeds only; no
  article bodies are scraped and no paywalls circumvented.
- **Business publishers** — RSS feeds, read the same way.
- **Companies House** — optional. The one source that can turn an assumed
  shareholding into a filed fact, published under the Open Government Licence v3.0.
- **LinkedIn** — never automated. Its User Agreement prohibits scraping, so the app
  only generates a search link for you to open by hand.

The HTTP client identifies itself honestly and rate-limits itself, so publishers
can see and block it if they wish.
        """
    )

    st.subheader("Automating the weekly run")
    st.code(
        "# macOS / Linux — 07:00 every Monday, deep sweep of the target profile\n"
        "0 7 * * 1 cd /path/to/ca_dashboard && /usr/bin/python3 scripts/run_research.py "
        "--if-due --depth deep >> research.log 2>&1\n\n"
        "# Windows — Task Scheduler, weekly, Monday 07:00\n"
        "python C:\\path\\to\\ca_dashboard\\scripts\\run_research.py --if-due --depth deep",
        language="bash",
    )

    st.subheader("Data protection")
    st.markdown(
        """
This app builds profiles of identifiable living people from public sources. That is
still processing personal data under UK GDPR — *publicly available* does not mean
*unregulated*. Before using it in earnest your firm needs:

- **A lawful basis.** Legitimate interests is usual for prospecting, and requires a
  documented balancing test.
- **An Article 14 notice.** Because the data comes from third parties rather than the
  individual, you generally have to tell them you hold it.
- **A way to honour objections.** Suppress a record — on any prospect's page — and the
  weekly sweep stops updating it and excludes it from every total.
- **A retention policy** for prospects who never respond.

Different rules apply outside the UK and EU. Searching US, Gulf and Asian markets does
not exempt the processing from UK GDPR if your firm is established here.

This describes how the software behaves; it is not legal advice.
        """
    )


# ---------------------------------------------------------------------------
# Shell
# ---------------------------------------------------------------------------

def _page(render, title: str):
    """Each page behind its own error boundary.

    A fault in one page now shows as a contained message on that page; the
    navigation, the other pages and the book are unaffected.
    """
    def run() -> None:
        with guarded(f"The {title} page"):
            render()
    run.__name__ = f"page_{title.lower().replace(' ', '_').replace('&', 'and')}"
    return run


def _sidebar(frame: pd.DataFrame) -> None:
    with st.sidebar:
        masthead(APP_NAME, APP_SUBTITLE)
        with db.connect() as conn:
            latest = db.last_run(conn)
            due = db.run_due_this_week(conn)
        lines = []
        if latest:
            lines.append(
                f"Last sweep {latest['started_at'][:10]} · {latest['status']} · "
                f"{latest['new_prospects']} new"
            )
        else:
            lines.append("No sweep has run yet.")
        if due:
            lines.append("⚠︎ This week's sweep is due.")
        if not frame.empty:
            lines.append(f"{len(frame)} people on file")
        lines.append(
            "Companies House: "
            + ("connected ✓" if companies_house_available() else "not configured (optional)")
        )
        st.caption("  \n".join(lines))


frame = load_prospects()
_sidebar(frame)

# A fresh install has nothing to look at, so it opens on the page that fixes
# that rather than on an empty shortlist.
empty = frame.empty
navigation = st.navigation({
    "Work": [
        st.Page(_page(lambda: page_today(frame), "Today"), title="Today",
                icon=":material/today:", url_path="today", default=not empty),
        st.Page(_page(lambda: page_list(frame), "Prospect list"), title="Prospect list",
                icon=":material/table_rows:", url_path="prospects"),
        st.Page(_page(page_unnamed_leads, "Find the owner"), title="Find the owner",
                icon=":material/person_search:", url_path="find-the-owner"),
    ],
    "Research": [
        st.Page(_page(lambda: page_find(frame), "Find prospects"), title="Find prospects",
                icon=":material/travel_explore:", url_path="find", default=empty),
        st.Page(_page(page_workbench, "Add & import"), title="Add & import",
                icon=":material/upload_file:", url_path="add"),
        st.Page(_page(lambda: page_overview(frame), "Overview"), title="Overview",
                icon=":material/insights:", url_path="overview"),
        st.Page(_page(page_research_doc, "Weekly research document"),
                title="Weekly document", icon=":material/description:", url_path="weekly"),
    ],
    "About": [
        st.Page(_page(page_screened_out, "Screened out"), title="Screened out",
                icon=":material/block:", url_path="screened-out"),
        st.Page(_page(page_methodology, "How it works"), title="How it works",
                icon=":material/menu_book:", url_path="how-it-works"),
        st.Page(_page(page_system, "System check"), title="System check",
                icon=":material/monitor_heart:", url_path="system"),
    ],
})
navigation.run()

st.divider()
st.caption(
    "All wealth figures are modelled estimates derived from publicly available "
    "sources. They are not verified statements of any individual's wealth and must "
    "not be presented to a client as fact. Companies House data is used under the "
    "Open Government Licence v3.0."
)
