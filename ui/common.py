"""Shared by every page: the look, the data, and the small honest helpers.

Kept separate from the pages so a change to how one page renders cannot quietly
change how another one loads its data — which is how a two-thousand-line single
file ends up with errors nobody can trace.
"""

from __future__ import annotations

import traceback
from contextlib import contextmanager
from urllib.parse import urlparse

import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.markets import MARKET_BY_KEY
from wealthscan.priority import prioritise
from wealthscan.report import fmt_gbp  # noqa: F401 - re-exported for the pages

try:  # Streamlit implements rerun and stop as exceptions; let those through.
    from streamlit.runtime.scriptrunner_utils.exceptions import ScriptControlException
except ImportError:  # pragma: no cover - older layouts
    ScriptControlException = ()  # type: ignore[assignment]

# Brass on ink rather than the usual dashboard teal-on-slate. A tool an advisor
# opens every morning should look like the rest of their working life — closer
# to a private-client report than to an analytics console.
ACCENT = "#b8945f"
ACCENT_SOFT = "rgba(184,148,95,.18)"
BAND_ORDER = [
    "Not estimated", "Below £7.5m", "£7.5m – £15m", "£15m – £30m",
    "£30m – £50m", "£50m – £100m", "£100m+",
]

CSS = """
<style>
  :root {
    --brass: #b8945f;
    --brass-soft: rgba(184,148,95,.14);
    --rule: rgba(184,148,95,.26);
    --ink-raise: rgba(255,255,255,.025);
  }
  .block-container { padding-top: 1.4rem; max-width: 1560px; }

  /* Editorial headings over tabular data. The mix is the identity. */
  h1, h2, h3, .masthead-name, .card-name {
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    letter-spacing: -.01em;
  }
  h1 { font-weight: 600; }
  h1::after {
    content: ""; display: block; width: 3.2rem; height: 2px;
    background: var(--brass); margin-top: .55rem; opacity: .85;
  }

  [data-testid="stMetricValue"] {
    font-size: 1.5rem; font-variant-numeric: tabular-nums; letter-spacing: -.01em;
  }
  [data-testid="stMetricLabel"] {
    font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; opacity: .68;
  }

  .masthead { display:flex; align-items:baseline; gap:.5rem; margin-bottom:.1rem; }
  .masthead-mark { color: var(--brass); font-size: 1.05rem; }
  .masthead-name { font-size: 1.12rem; font-weight: 600; }
  .masthead-rule { height:1px; background:var(--rule); margin:.6rem 0 .5rem; }

  .reason { font-size: .84rem; opacity: .84; line-height: 1.6; margin: .15rem 0 .55rem; }
  .muted { opacity: .62; font-size: .8rem; }
  .pill { display:inline-block; padding:.14rem .55rem; border-radius:2px; font-size:.66rem;
          font-weight:600; letter-spacing:.04em; text-transform:uppercase;
          border:1px solid rgba(140,140,140,.32); margin:0 .35rem .3rem 0; }
  .pill-good { background:var(--brass-soft); border-color:var(--rule); color:var(--brass); }
  .pill-warn { background:rgba(180,83,9,.14);  border-color:rgba(180,83,9,.45); }
  .pill-none { background:transparent; opacity:.72; }
  .step { font-size:.68rem; text-transform:uppercase; letter-spacing:.1em;
          color:var(--brass); font-weight:700; margin-bottom:.25rem; }

  /* Shortlist cards. */
  .card-rank { font-size:.7rem; letter-spacing:.12em; text-transform:uppercase;
               color:var(--brass); font-weight:700; }
  .card-name { font-size:1.28rem; font-weight:600; margin:.05rem 0 .1rem; }
  .card-meta { font-size:.82rem; opacity:.72; margin-bottom:.45rem; }
  .card-why  { font-size:.86rem; line-height:1.55; margin:.2rem 0 .5rem; }
  .card-act  { font-size:.84rem; border-left:2px solid var(--brass);
               padding:.2rem 0 .2rem .65rem; margin:.3rem 0 .2rem; }
  .score { font-variant-numeric: tabular-nums; font-size:1.9rem; font-weight:600;
           line-height:1; color:var(--brass);
           font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
  .score-label { font-size:.62rem; letter-spacing:.1em; text-transform:uppercase;
                 opacity:.6; }

  table, [data-testid="stDataFrame"] { font-variant-numeric: tabular-nums; }
  [data-testid="stSidebar"] { border-right: 1px solid var(--rule); }
</style>
"""


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@st.cache_data(ttl=15)
def load_prospects() -> pd.DataFrame:
    """The whole book, with each person's priority, reason and next step.

    Priority is computed here, once, rather than on each page, so the shortlist,
    the table and the record can never disagree about who comes first.
    """
    with db.connect() as conn:
        rows = [dict(r) for r in db.all_prospects(conn)]
        if not rows:
            return pd.DataFrame()
        latest = {
            int(r["prospect_id"]): (r["latest"], int(r["outlets"]))
            for r in conn.execute(
                """SELECT prospect_id,
                          MAX(COALESCE(published_at, retrieved_at)) AS latest,
                          COUNT(DISTINCT COALESCE(publisher, url)) AS outlets
                   FROM sources GROUP BY prospect_id"""
            )
        }
        contacted = {
            int(r["prospect_id"]): r["last"]
            for r in conn.execute(
                "SELECT prospect_id, MAX(created_at) AS last FROM contacts GROUP BY prospect_id"
            )
        }

    for row in rows:
        when, outlets = latest.get(int(row["id"]), (None, 1))
        priority = prioritise(
            row, latest_source_at=when, source_count=outlets,
            last_contacted_at=contacted.get(int(row["id"])),
        )
        row["priority"] = priority.score
        row["why_now"] = priority.why_now
        row["next_step"] = priority.action
        row["in_progress"] = priority.in_progress
        row["latest_source_at"] = when
        row["outlets"] = outlets
        row["last_contacted_at"] = contacted.get(int(row["id"]))

    frame = pd.DataFrame(rows)
    frame["lat"] = frame["market_key"].map(
        lambda k: MARKET_BY_KEY[k].lat if k in MARKET_BY_KEY else None
    )
    frame["lon"] = frame["market_key"].map(
        lambda k: MARKET_BY_KEY[k].lon if k in MARKET_BY_KEY else None
    )
    return frame


@st.cache_data(ttl=15)
def load_runs() -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.runs(conn, limit=25)]


@st.cache_data(ttl=15)
def load_reports() -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.reports(conn)]


@st.cache_data(ttl=15)
def load_sources_index() -> dict[int, list[dict]]:
    """Every citation, grouped by prospect, in one query rather than one per row."""
    with db.connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM sources ORDER BY COALESCE(published_at, retrieved_at) DESC"
        )]
    index: dict[int, list[dict]] = {}
    for row in rows:
        index.setdefault(int(row["prospect_id"]), []).append(row)
    return index


@st.cache_data(ttl=15)
def load_lead_count() -> tuple[int, int]:
    """(unnamed transactions waiting, their reported value)."""
    with db.connect() as conn:
        leads = db.company_leads(conn, unresolved_only=True)
    return len(leads), sum(int(r["amount_gbp"] or 0) for r in leads)


def events_for(prospect_id: int) -> list[dict]:
    with db.connect() as conn:
        return [dict(r) for r in db.prospect_events(conn, prospect_id)]


def refresh() -> None:
    load_prospects.clear()
    load_runs.clear()
    load_reports.clear()
    load_sources_index.clear()
    load_lead_count.clear()


# ---------------------------------------------------------------------------
# Small honest helpers
# ---------------------------------------------------------------------------


def estimate_disclaimer() -> None:
    st.caption(
        "Every money figure is a **modelled estimate from public reporting**, not a "
        "verified statement of wealth. A blank or “None” means not publicly "
        "disclosed — never zero."
    )


def present(row, key: str) -> bool:
    """True when a field actually holds a value.

    pandas turns SQL NULLs into NaN, and `bool(float("nan"))` is True — so a
    plain truthiness check would claim a shareholding was "filed on the PSC
    register" for every prospect that has no such record. Falsely asserting
    verification is the worst failure this app could have, so every optional
    field is tested through here.
    """
    try:
        if key not in row:
            return False
    except TypeError:
        return False
    value = row[key]
    if value is None:
        return False
    try:
        if pd.isna(value):
            return False
    except (TypeError, ValueError):
        pass
    return str(value).strip() not in ("", "nan", "None", "NaT")


def value(row, key: str, default=None):
    return row[key] if present(row, key) else default


def is_web_link(url) -> bool:
    """Only real web addresses become links. Imported records carry an
    ``import://`` reference that means something to the book and nothing to a
    browser."""
    if not url:
        return False
    parsed = urlparse(str(url))
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def confidence_pill(score: int, band: str) -> str:
    css = "pill-good" if score >= 68 else "pill-warn" if score >= 45 else "pill-none"
    return f'<span class="pill {css}">Confidence {band} · {score}</span>'


def state_pill(state: str) -> str:
    css = {"Confirmed": "pill-good", "Corroborated": "pill-warn"}.get(state, "pill-none")
    return f'<span class="pill {css}">{state}</span>'


def where_text(row) -> str:
    """One readable location line: "Exeter, Devon, United Kingdom"."""
    parts = [
        str(row[k]) for k in ("locality", "market_name", "country") if present(row, k)
    ]
    kept: list[str] = []
    for part in parts:
        if any(part in seen or seen in part for seen in kept):
            continue
        kept.append(part)
    return ", ".join(kept) or "—"


def masthead(title: str, subtitle: str) -> None:
    st.markdown(
        f'<div class="masthead"><span class="masthead-mark">◈</span>'
        f'<span class="masthead-name">{title}</span></div>'
        f'<div class="masthead-rule"></div>',
        unsafe_allow_html=True,
    )
    st.caption(subtitle)


@contextmanager
def guarded(section: str):
    """Contain a failure to the section it happened in.

    One broken panel used to take the whole page down with a red traceback. Now
    it shows what failed, in words, with the detail folded away for whoever has
    to fix it — and everything else on the page still renders.
    """
    try:
        yield
    except ScriptControlException:
        raise
    except Exception as error:  # noqa: BLE001 - deliberately broad: it is a boundary
        st.error(
            f"**{section} could not be shown.** The rest of the page is unaffected. "
            f"({type(error).__name__}: {error})"
        )
        with st.expander("Technical detail"):
            st.code(traceback.format_exc(), language="text")
