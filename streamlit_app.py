"""Lead Intelligence — Streamlit research dashboard.

Run it with:

    streamlit run streamlit_app.py

No database server, no build step, no API key required to start. The weekly
research sweep reads public news; Companies House verification is an optional
bonus that turns an assumed shareholding into a filed one.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import altair as alt
import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.config import (
    APP_NAME,
    APP_SUBTITLE,
    ASSUMPTION_NOTES,
    MODEL,
    MODEL_VERSION,
    PRIORITY_THRESHOLD_GBP,
    QUALIFYING_THRESHOLD_GBP,
)
from wealthscan.queries import EVENT_TEMPLATES
from wealthscan.regions import REGION_DATA, REGIONS
from wealthscan.report import fmt_gbp, generate_and_store
from wealthscan.research import run_research
from wealthscan.sources import companies_house_available

st.set_page_config(
    page_title=f"{APP_NAME} — Private Wealth",
    page_icon="◈",
    layout="wide",
    initial_sidebar_state="expanded",
)

ACCENT = "#0f766e"
BAND_ORDER = [
    "Not estimated", "Below £7.5m", "£7.5m – £15m", "£15m – £30m",
    "£30m – £50m", "£50m – £100m", "£100m+",
]

CSS = """
<style>
  .block-container { padding-top: 2rem; max-width: 1500px; }
  [data-testid="stMetricValue"] { font-size: 1.65rem; font-variant-numeric: tabular-nums; }
  [data-testid="stMetricLabel"] { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .est-note { font-size: .78rem; opacity: .72; line-height: 1.5; }
  .pill { display:inline-block; padding:.1rem .45rem; border-radius:.35rem; font-size:.7rem;
          font-weight:600; border:1px solid rgba(128,128,128,.35); margin-right:.3rem; }
  .pill-filed { background:rgba(15,118,110,.16); border-color:rgba(15,118,110,.5); }
  .pill-warn  { background:rgba(180,83,9,.16);  border-color:rgba(180,83,9,.5); }
  .pill-none  { background:transparent; opacity:.7; }
  .reason { font-size:.8rem; opacity:.78; line-height:1.55; margin:.15rem 0 .45rem; }
  table { font-variant-numeric: tabular-nums; }
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)

db.init_db()


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------


@st.cache_data(ttl=20)
def load_prospects() -> pd.DataFrame:
    with db.connect() as conn:
        rows = [dict(r) for r in db.all_prospects(conn)]
    if not rows:
        return pd.DataFrame()
    frame = pd.DataFrame(rows)
    frame["lat"] = frame["region"].map(lambda r: REGION_DATA[r].lat if r in REGION_DATA else None)
    frame["lon"] = frame["region"].map(lambda r: REGION_DATA[r].lon if r in REGION_DATA else None)
    return frame


@st.cache_data(ttl=20)
def load_runs() -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.runs(conn, limit=20)]


@st.cache_data(ttl=20)
def load_reports() -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.reports(conn)]


def sources_for(prospect_id: int) -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.prospect_sources(conn, prospect_id)]


def events_for(prospect_id: int) -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.prospect_events(conn, prospect_id)]


def refresh() -> None:
    load_prospects.clear()
    load_runs.clear()
    load_reports.clear()


# ---------------------------------------------------------------------------
# Shared fragments
# ---------------------------------------------------------------------------


def estimate_disclaimer() -> None:
    st.caption(
        "Every monetary figure here is a **modelled estimate derived from public "
        "reporting**, not a verified statement of wealth. Press coverage almost never "
        "states an individual's shareholding, so it is assumed — the largest single "
        "source of error. Verify on Companies House before relying on a figure."
    )


def present(row, key: str) -> bool:
    """True when a field actually holds a value.

    pandas turns SQL NULLs into NaN, and `bool(float("nan"))` is True — so a
    plain truthiness check would claim a shareholding was "filed on the PSC
    register" for every prospect that has no such record. Falsely asserting
    verification is the worst failure this app could have, so every optional
    field is tested through here.
    """
    if key not in row:
        return False
    value = row[key]
    if value is None:
        return False
    try:
        if pd.isna(value):
            return False
    except (TypeError, ValueError):
        pass
    return str(value).strip() not in ("", "nan", "None")


def confidence_pill(score: int, band: str) -> str:
    css = "pill-filed" if score >= 68 else "pill-warn" if score >= 45 else "pill-none"
    return f'<span class="pill {css}">{band} · {score}</span>'


def render_prospect_detail(row: pd.Series) -> None:
    """Everything behind one prospect: the figure, its basis, and its evidence."""
    left, right = st.columns([1.45, 1])

    with left:
        if present(row, "investable_mid_gbp"):
            st.metric(
                "Estimated investable assets",
                fmt_gbp(row["investable_mid_gbp"]),
                help="Modelled from reported figures. Not a verified amount.",
            )
            st.caption(
                f"Range {fmt_gbp(row['investable_low_gbp'])} – {fmt_gbp(row['investable_high_gbp'])}"
                f" · gross estimated wealth {fmt_gbp(row['gross_mid_gbp'])}"
            )
            st.markdown(
                f'<div class="reason"><strong>How that figure was reached:</strong> '
                f'{row["estimate_method"]}</div>',
                unsafe_allow_html=True,
            )
        else:
            st.markdown("**Estimated investable assets:** _not estimated_")
            st.markdown(
                f'<div class="reason"><strong>Why not:</strong> '
                f'{row["not_estimated_reason"] if present(row, "not_estimated_reason") else "No basis for an estimate was found."}</div>',
                unsafe_allow_html=True,
            )

        caveats = json.loads(row["estimate_caveats"]) if present(row, "estimate_caveats") else []
        if caveats:
            st.markdown("**Caveats**")
            for caveat in caveats:
                st.markdown(f'<div class="reason">• {caveat}</div>', unsafe_allow_html=True)

        if present(row, "rationale"):
            st.markdown("**Why they were identified**")
            st.markdown(f'<div class="reason">{row["rationale"]}</div>', unsafe_allow_html=True)

        st.markdown("**Sources**")
        for source in sources_for(int(row["id"])):
            published = (source.get("published_at") or "")[:10]
            st.markdown(
                f"- [{source['title']}]({source['url']}) — "
                f"{source.get('publisher') or 'source'}"
                + (f" · {published}" if published else "")
                + (f" · {source['event_label']}" if source.get("event_label") else "")
            )
            if source.get("rationale"):
                st.caption(source["rationale"])

    with right:
        st.markdown("**Confidence**")
        st.markdown(
            confidence_pill(int(row["confidence"]), str(row["confidence_band"])),
            unsafe_allow_html=True,
        )
        detail = json.loads(row["confidence_detail"]) if present(row, "confidence_detail") else []
        for dimension in detail:
            st.progress(
                min(100, max(0, int(dimension["score"]))) / 100,
                text=f"{dimension['label']} — {dimension['score']}/100",
            )
            st.caption(dimension["why"])

        if present(row, "next_action"):
            st.info(f"**Best next action** — {row['next_action']}")

        st.markdown("**Verification**")
        if present(row, "ch_ownership_band"):
            st.success(
                f"Shareholding filed at {row['ch_ownership_band']} on the Companies "
                f"House PSC register — this stake is a fact, not an assumption."
            )
        elif present(row, "ch_company_number"):
            st.warning(
                f"Company matched on the register ({row['ch_company_number']}), but the "
                f"individual's shareholding is not filed. The stake remains assumed."
            )
        else:
            st.warning(
                "Not verified against Companies House. The shareholding behind any "
                "figure above is an assumption."
            )

        search_name = str(row["full_name"]).replace(" ", "+")
        st.markdown(
            "**Check it yourself**  \n"
            f"- [Companies House officer search]"
            f"(https://find-and-update.company-information.service.gov.uk/search/officers?q={search_name})  \n"
            f"- [LinkedIn search](https://www.linkedin.com/search/results/people/?keywords={search_name}) "
            "— manual only; this app never scrapes LinkedIn."
        )


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


def page_overview(frame: pd.DataFrame) -> None:
    st.title("Overview")
    st.caption(
        "People in the 13 target counties who appear to have recently come into "
        "significant wealth, found by searching public news each week."
    )

    if frame.empty:
        st.info(
            "**No prospects yet.** Open **Run research** in the sidebar and start a "
            "sweep — it searches 182 targeted news queries across the 13 counties. "
            "Or load the demo dataset with `python scripts/seed_demo.py` to see how "
            "the dashboard works before running anything live."
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
    columns[0].metric("Tracked", len(frame))
    columns[1].metric("New this week", len(this_week))
    columns[2].metric("Qualifying", len(qualifying), help="£7.5m+ estimated investable assets")
    columns[3].metric("Pre-liquidity", len(pre_liquidity), help="£15m+ gross, not yet liquid")
    columns[4].metric("Addressable", fmt_gbp(qualifying["investable_mid_gbp"].sum()))
    columns[5].metric("High confidence", int((frame["confidence"] >= 68).sum()))
    estimate_disclaimer()

    if len(unestimated):
        st.caption(
            f"**{len(unestimated)} prospect(s) carry no monetary figure.** That is "
            "deliberate: the evidence found indicates wealth without sizing it, and "
            "the app states the reason on each record rather than inventing a number."
        )

    st.divider()
    left, right = st.columns([1.15, 1])

    with left:
        st.subheader("Estimated addressable assets by county")
        by_region = (
            frame.assign(investable=frame["investable_mid_gbp"].fillna(0))
            .groupby("region", as_index=False)
            .agg(prospects=("id", "count"), addressable=("investable", "sum"))
            .sort_values("addressable", ascending=False)
        )
        chart = (
            alt.Chart(by_region)
            .mark_bar(color=ACCENT, cornerRadiusEnd=3)
            .encode(
                x=alt.X("addressable:Q", title="Estimated addressable (£)"),
                # labelOverlap=False forces every county to keep its label;
                # Altair otherwise drops alternates and the chart becomes unreadable.
                y=alt.Y("region:N", sort="-x", title=None,
                        axis=alt.Axis(labelOverlap=False, labelLimit=160)),
                tooltip=[
                    alt.Tooltip("region:N", title="County"),
                    alt.Tooltip("prospects:Q", title="Prospects"),
                    alt.Tooltip("addressable:Q", title="Addressable (£)", format=","),
                ],
            )
            .properties(height=max(240, 26 * len(by_region)))
        )
        st.altair_chart(chart, width="stretch")

    with right:
        st.subheader("Wealth bands")
        bands = (
            frame.groupby("wealth_band", as_index=False)
            .agg(prospects=("id", "count"))
        )
        band_chart = (
            alt.Chart(bands)
            .mark_bar(color=ACCENT, cornerRadiusEnd=3)
            .encode(
                x=alt.X("wealth_band:N", sort=BAND_ORDER, title=None,
                        axis=alt.Axis(labelAngle=-35)),
                y=alt.Y("prospects:Q", title="Prospects"),
                tooltip=["wealth_band:N", "prospects:Q"],
            )
            .properties(height=250)
        )
        st.altair_chart(band_chart, width="stretch")

        st.subheader("How they were found")
        events = frame.groupby("primary_event", as_index=False).agg(n=("id", "count"))
        st.dataframe(
            events.rename(columns={"primary_event": "Wealth event", "n": "Prospects"}),
            hide_index=True, width="stretch",
        )

    st.divider()
    st.subheader("Where they are")
    located = frame.dropna(subset=["lat", "lon"])
    if located.empty:
        st.caption("No prospects with a resolved county yet.")
    else:
        try:
            st.map(located[["lat", "lon"]], size=12000, color="#0f766e")
            st.caption(
                "Plotted at county centre — the sources give a county, not a street address."
            )
        except Exception:
            # Map tiles come from an external host; on a locked-down network the
            # table is a perfectly good substitute and must not break the page.
            st.caption("Map tiles unavailable on this network — showing counts instead.")
            st.dataframe(
                located.groupby("region", as_index=False)
                .agg(prospects=("id", "count"))
                .rename(columns={"region": "County", "prospects": "Prospects"}),
                hide_index=True, width="stretch",
            )

    st.divider()
    st.subheader("Highest estimated investable assets")
    ranked = frame.sort_values("investable_mid_gbp", ascending=False, na_position="last").head(15)
    st.dataframe(
        pd.DataFrame({
            "Name": ranked["full_name"],
            "Company": ranked["company"].fillna("—"),
            "County": ranked["region"],
            "Found via": ranked["primary_event"].fillna("—"),
            "Est. investable": ranked["investable_mid_gbp"].map(fmt_gbp),
            "Band": ranked["wealth_band"],
            "Confidence": ranked["confidence"],
            "Cohort": ranked["cohort"],
        }),
        hide_index=True, width="stretch",
    )


def page_prospects(frame: pd.DataFrame) -> None:
    st.title("Prospects")
    if frame.empty:
        st.info("No prospects yet. Run a research sweep from the sidebar.")
        return

    with st.container(border=True):
        row1 = st.columns([2, 1.3, 1.3])
        search = row1[0].text_input("Search", placeholder="Name, company or town")
        cohorts = row1[1].multiselect("Cohort", sorted(frame["cohort"].dropna().unique()))
        min_confidence = row1[2].slider("Minimum confidence", 0, 100, 0, step=5)

        row2 = st.columns([1.6, 1.6, 1.2])
        regions = row2[0].multiselect("County", [r for r in REGIONS if r in set(frame["region"])])
        bands = row2[1].multiselect(
            "Wealth band",
            [b for b in BAND_ORDER if b in set(frame["wealth_band"])],
        )
        sort_by = row2[2].selectbox(
            "Sort by",
            ["Estimated wealth", "Confidence", "Newest", "Name"],
        )

    view = frame.copy()
    if search:
        needle = search.lower()
        view = view[
            view["full_name"].str.lower().str.contains(needle, na=False)
            | view["company"].fillna("").str.lower().str.contains(needle, na=False)
            | view["matched_place"].fillna("").str.lower().str.contains(needle, na=False)
        ]
    if cohorts:
        view = view[view["cohort"].isin(cohorts)]
    if regions:
        view = view[view["region"].isin(regions)]
    if bands:
        view = view[view["wealth_band"].isin(bands)]
    view = view[view["confidence"] >= min_confidence]

    if sort_by == "Estimated wealth":
        view = view.sort_values("investable_mid_gbp", ascending=False, na_position="last")
    elif sort_by == "Confidence":
        view = view.sort_values("confidence", ascending=False)
    elif sort_by == "Newest":
        view = view.sort_values("first_seen", ascending=False)
    else:
        view = view.sort_values("full_name")

    st.caption(f"{len(view)} of {len(frame)} prospects")
    estimate_disclaimer()

    st.download_button(
        "Download this view as CSV",
        data=(
            "# All monetary figures are MODELLED ESTIMATES from public reporting, "
            "not verified statements of wealth.\n"
            + view.drop(columns=["lat", "lon"], errors="ignore").to_csv(index=False)
        ),
        file_name=f"prospects-{datetime.now(timezone.utc):%Y-%m-%d}.csv",
        mime="text/csv",
    )

    for _, row in view.iterrows():
        verified = " ✓ filed stake" if present(row, "ch_ownership_band") else ""
        amount = (
            fmt_gbp(row["investable_mid_gbp"]) if present(row, "investable_mid_gbp")
            else "not estimated"
        )
        headline = (
            f"**{row['full_name']}**"
            f" · {row['region']}"
            f" · {amount}"
            f" · confidence {row['confidence']}{verified}"
        )
        with st.expander(headline):
            meta = " · ".join(
                str(row[key]) for key in ("job_title", "company", "primary_event")
                if present(row, key)
            )
            if meta:
                st.caption(meta)
            render_prospect_detail(row)


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


def page_run_research() -> None:
    st.title("Run research")
    st.caption(
        "Crosses 14 wealth-event patterns with the 13 target counties and searches "
        "public news for each. Safe to run repeatedly — articles already processed "
        "are skipped."
    )

    with db.connect() as conn:
        due = db.run_due_this_week(conn)
        latest = db.last_run(conn)

    if due:
        st.warning(
            f"**No sweep has run yet in {db.iso_week()}.** The intended cadence is once "
            "at the start of each week."
        )
    else:
        st.success(f"A sweep has already run this week ({db.iso_week()}).")

    with st.container(border=True):
        columns = st.columns([1, 1, 1])
        days = columns[0].slider("Look back (days)", 2, 30, 7,
                                 help="7 days matches a weekly cadence. Use 30 for a first run.")
        selected_regions = columns[1].multiselect(
            "Counties (all if empty)", list(REGIONS), default=[],
        )
        selected_events = columns[2].multiselect(
            "Wealth events (all if empty)",
            [t.key for t in EVENT_TEMPLATES],
            format_func=lambda k: next(t.label for t in EVENT_TEMPLATES if t.key == k),
            default=[],
        )

        options = st.columns([1, 1, 1])
        include_publishers = options[0].checkbox("Also sweep regional publishers", value=True)
        verify_ch = options[1].checkbox(
            "Verify with Companies House",
            value=companies_house_available(),
            disabled=not companies_house_available(),
            help="Turns an assumed shareholding into a filed one. Needs COMPANIES_HOUSE_API_KEY.",
        )
        cap = options[2].number_input(
            "Cap queries (0 = no cap)", min_value=0, max_value=400, value=0, step=10,
            help="Useful for a quick test run.",
        )

    if not companies_house_available():
        st.caption(
            "Companies House verification is off because no API key is set. It is a "
            "**bonus**, not a requirement — without it, shareholdings stay labelled as "
            "assumptions and confidence scores stay correspondingly lower. Set "
            "`COMPANIES_HOUSE_API_KEY` in your environment to enable it."
        )

    if st.button("Start research sweep", type="primary"):
        status = st.status("Starting…", expanded=True)
        bar = st.progress(0.0)

        def report_progress(message: str, fraction: float) -> None:
            status.update(label=message)
            bar.progress(min(1.0, fraction))

        result = run_research(
            trigger="manual",
            days=days,
            regions=selected_regions or None,
            event_keys=selected_events or None,
            include_publishers=include_publishers,
            verify_companies_house=verify_ch,
            max_queries=int(cap) or None,
            progress=report_progress,
        )
        status.update(label=f"Finished — {result.status}", state="complete")
        refresh()

        metrics = st.columns(5)
        metrics[0].metric("Searches", result.queries_run)
        metrics[1].metric("Articles read", result.articles_seen)
        metrics[2].metric("Events kept", result.events_kept)
        metrics[3].metric("New prospects", result.new_prospects)
        metrics[4].metric("Corroborated", result.updated_prospects)

        if result.company_leads:
            st.caption(
                f"{result.company_leads} event(s) named a company but no individual. "
                "Those are not turned into prospects — inventing a name would be worse "
                "than useless — but they appear in the run log for manual follow-up."
            )

        if result.new_prospects or result.updated_prospects:
            with st.spinner("Updating the weekly research document…"):
                generate_and_store()
            refresh()
            st.success("Research document updated. See **Weekly research document**.")

        if result.log:
            with st.expander(f"Run log ({len(result.log)} entries)"):
                for line in result.log:
                    st.text(line)
        if result.warnings:
            with st.expander(f"Warnings ({len(result.warnings)})"):
                for warning in result.warnings:
                    st.text(warning)
            st.caption(
                "Warnings are normal: some publishers block automated readers, and a "
                "blocked feed simply means that source contributed nothing this run."
            )

    st.divider()
    st.subheader("Run history")
    runs = load_runs()
    if not runs:
        st.caption("No runs recorded yet.")
    else:
        st.dataframe(
            pd.DataFrame([{
                "Started": r["started_at"][:16].replace("T", " "),
                "Week": r["week"],
                "Trigger": r["trigger"],
                "Status": r["status"],
                "Searches": r["queries_run"],
                "Articles": r["articles_seen"],
                "Kept": r["events_kept"],
                "New": r["new_prospects"],
                "Warnings": len(json.loads(r["warnings"] or "[]")),
            } for r in runs]),
            hide_index=True, width="stretch",
        )

    if latest:
        st.caption(
            "To automate this weekly, schedule `python scripts/run_research.py` for "
            "Monday morning — cron on macOS/Linux, Task Scheduler on Windows. See the "
            "Methodology page."
        )


def page_methodology() -> None:
    st.title("Methodology")
    st.caption(f"Research model v{MODEL_VERSION}. How every figure is produced, and where it can be wrong.")

    st.error(
        "**Every monetary figure in this app is an estimate, not a fact.** It tells you "
        "what a model infers from public reporting, and how much of that inference is "
        "evidenced. Ranges are wide on purpose. Before acting on a record, open its "
        "sources and check them."
    )

    st.subheader("What the app does each week")
    st.markdown(
        """
1. **Searches.** 14 wealth-event patterns crossed with 13 counties — 182 targeted
   news queries, plus a broad sweep of regional business publishers.
2. **Filters by geography.** A record whose location cannot be resolved to one of
   the 13 counties is discarded, never defaulted. Ambiguous place names ("Bath",
   "Reading", "Chelsea") are only accepted when the county name corroborates them.
3. **Extracts the event.** Transaction values, named individuals and their roles,
   and the company. The extractor prefers finding nothing to guessing — a false
   name here becomes a wrong claim about a real person.
4. **Estimates, or declines to.** Where a figure can be derived, the arithmetic is
   recorded in plain English. Where it cannot, the app says why and stores no number.
5. **Scores confidence** across five dimensions, and states the single best action
   to raise it.
6. **Writes the research document** for the week.
        """
    )

    st.subheader("Wealth events searched")
    st.dataframe(
        pd.DataFrame([
            {"Event": t.label, "Weight": t.weight, "What it means": t.meaning}
            for t in EVENT_TEMPLATES
        ]),
        hide_index=True, width="stretch",
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

    st.subheader("Sources, and lawful use")
    st.markdown(
        """
Only publicly available, lawfully obtainable information is used.

- **Google News RSS** — the discovery engine. Publisher-provided feeds only; no
  article bodies are scraped and no paywalls circumvented.
- **Regional business publishers** — RSS feeds, read the same way.
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
        "# macOS / Linux — 07:00 every Monday\n"
        "0 7 * * 1 cd /path/to/ca_dashboard && "
        "/usr/bin/python3 scripts/run_research.py >> research.log 2>&1\n\n"
        "# Windows — Task Scheduler, weekly, Monday 07:00\n"
        "python C:\\path\\to\\ca_dashboard\\scripts\\run_research.py",
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
- **A way to honour objections.** Suppress a record and the weekly sweep will stop
  updating it and exclude it from totals.
- **A retention policy** for prospects who never respond.

This describes how the software behaves; it is not legal advice.
        """
    )


# ---------------------------------------------------------------------------
# Shell
# ---------------------------------------------------------------------------

frame = load_prospects()

with st.sidebar:
    st.markdown(f"### ◈ {APP_NAME}")
    st.caption(APP_SUBTITLE)

    page = st.radio(
        "Navigate",
        ["Overview", "Prospects", "Weekly research document", "Run research", "Methodology"],
        label_visibility="collapsed",
    )

    st.divider()
    with db.connect() as conn:
        latest = db.last_run(conn)
        due = db.run_due_this_week(conn)

    if latest:
        st.caption(f"Last sweep: {latest['started_at'][:10]} ({latest['status']})")
    else:
        st.caption("No sweep has run yet.")
    if due:
        st.caption("⚠︎ This week's sweep is due.")

    st.caption(
        "Companies House: "
        + ("connected ✓" if companies_house_available() else "not configured (optional)")
    )
    if not frame.empty:
        st.caption(f"{len(frame)} prospects on file")

if page == "Overview":
    page_overview(frame)
elif page == "Prospects":
    page_prospects(frame)
elif page == "Weekly research document":
    page_research_doc()
elif page == "Run research":
    page_run_research()
else:
    page_methodology()

st.divider()
st.caption(
    "All wealth figures are modelled estimates derived from publicly available "
    "sources. They are not verified statements of any individual's wealth and must "
    "not be presented to a client as fact. Companies House data is used under the "
    "Open Government Licence v3.0."
)
