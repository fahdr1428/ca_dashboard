"""System check: is the app able to do its job right now, and if not, why not.

"The sweep found nothing" has four different causes — the network is blocked,
Google is throttling, a feed has moved, or there genuinely was no news — and
each needs a different fix. This page tells them apart in one place instead of
leaving the advisor to guess from an empty list.
"""

from __future__ import annotations

import platform
import sqlite3

import pandas as pd
import streamlit as st

from wealthscan import db
from wealthscan.queries import DIRECT_FEEDS, google_news_url
from wealthscan.sources import Fetcher, companies_house_status, fetch_feed

from .common import guarded, load_prospects


def page_system() -> None:
    st.title("System check")
    st.caption(
        "What is working, what is not, and what to do about it. Nothing on this page "
        "changes the book."
    )

    with guarded("The book"):
        _book()
    st.divider()
    with guarded("The live checks"):
        _live_checks()
    st.divider()
    with guarded("Feed health"):
        _feeds()
    st.divider()
    with guarded("Versions"):
        _versions()


def _book() -> None:
    st.subheader("The book")
    frame = load_prospects()
    with db.connect() as conn:
        count = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
        sources = count("SELECT COUNT(*) FROM sources")
        leads = count("SELECT COUNT(*) FROM company_leads WHERE resolved_at IS NULL")
        refused = count("SELECT COUNT(*) FROM exclusions")
        suppressed = count("SELECT COUNT(*) FROM prospects WHERE suppressed_at IS NOT NULL")
        seen = count("SELECT COUNT(*) FROM seen_urls")
        last = db.last_run(conn)

    columns = st.columns(6)
    columns[0].metric("People", len(frame))
    columns[1].metric("Sources cited", f"{sources:,}")
    columns[2].metric("Articles read", f"{seen:,}")
    columns[3].metric("Unnamed deals", leads)
    columns[4].metric("Screened out", refused)
    columns[5].metric("Suppressed", suppressed)

    if not frame.empty:
        states = frame["verification_state"].fillna("Unconfirmed").value_counts()
        st.caption(
            " · ".join(f"**{states.get(s, 0)}** {s.lower()}"
                       for s in ("Confirmed", "Corroborated", "Unconfirmed"))
        )
    if last:
        st.caption(
            f"Last sweep {str(last['started_at'])[:16].replace('T', ' ')} UTC — "
            f"{last['status']}, {last['queries_run']} searches, "
            f"{last['articles_seen']} articles, {last['new_prospects']} new people."
        )
    else:
        st.caption("No sweep has run on this installation yet.")
    st.caption(f"Database file: `{db.DB_PATH}`")


def _live_checks() -> None:
    st.subheader("Can the app reach its sources?")
    st.caption(
        "Each button makes one real request. Run these first whenever a sweep comes "
        "back empty."
    )
    columns = st.columns(3)

    with columns[0]:
        st.markdown("**Google News**")
        if st.button("Test Google News", width="stretch"):
            fetcher = Fetcher(delay=0.0)
            url = google_news_url('"business" "sold"', days=7)
            articles, error = fetch_feed(fetcher, url, publisher="Google News")
            if error:
                st.error(f"Failed: {plain_network_error(error)}")
                with st.expander("Technical detail"):
                    st.code(error, language="text")
                st.caption(
                    "If every search fails, the network this app runs on is blocking "
                    "outbound requests. Streamlit Community Cloud does not."
                )
            else:
                st.success(f"Working — {len(articles)} headlines returned.")

    with columns[1]:
        st.markdown(f"**Direct feeds** ({len(DIRECT_FEEDS)})")
        if st.button("Test direct feeds", width="stretch"):
            fetcher = Fetcher(delay=0.0)
            for feed in DIRECT_FEEDS:
                name, url = _feed_name_url(feed)
                articles, error = fetch_feed(fetcher, url, publisher=name)
                if error:
                    st.error(f"{name}: {plain_network_error(error)}")
                else:
                    st.success(f"{name}: {len(articles)} items")

    with columns[2]:
        st.markdown("**Companies House**")
        if st.button("Test Companies House", width="stretch"):
            ok, message = companies_house_status()
            (st.success if ok else st.warning)(message)
        st.caption(
            "Optional. The key goes in Streamlit **Secrets** as "
            "`COMPANIES_HOUSE_API_KEY` — never in the repository."
        )


def plain_network_error(error: str) -> str:
    """A requests traceback, in the words someone can act on."""
    text = str(error)
    if "ProxyError" in text or "Tunnel connection failed" in text:
        return ("the network this app runs on blocked the request (a proxy refused "
                "it). Nothing is wrong with the source; run the app somewhere with "
                "open internet access, such as Streamlit Community Cloud.")
    if "HTTP 429" in text:
        return "rate limited — the source is throttling requests. Try again later."
    if "HTTP 403" in text or "HTTP 401" in text:
        return "the source refused automated reading (HTTP 403)."
    if "HTTP 404" in text:
        return "the feed address no longer exists (HTTP 404)."
    if "Timeout" in text:
        return "the source did not answer in time."
    if "ConnectionError" in text or "NameResolution" in text:
        return "could not connect — no internet access, or the site is down."
    return text


def _feed_name_url(feed) -> tuple[str, str]:
    """Direct feeds are ``(name, url)`` pairs or objects with those attributes."""
    if isinstance(feed, (tuple, list)):
        return str(feed[0]), str(feed[1])
    return str(getattr(feed, "name", feed)), str(getattr(feed, "url", feed))


def _feeds() -> None:
    st.subheader("Feed health")
    with db.connect() as conn:
        rows = [dict(r) for r in db.feed_health(conn)]
    if not rows:
        st.caption("No feed has been read yet. This fills in after the first sweep.")
        return
    st.dataframe(
        pd.DataFrame([{
            "Feed": r["name"] or r["url"],
            "Last worked": (r["last_ok"] or "never")[:16].replace("T", " "),
            "Items then": r["items_last_ok"],
            "Failures in a row": r["consecutive_failures"],
            "Last error": r["last_error"] or "",
        } for r in rows]),
        hide_index=True, width="stretch",
        column_config={"Last error": st.column_config.TextColumn(width="large")},
    )
    st.caption(
        f"A feed that fails {db.FEED_FAILURE_LIMIT} runs in a row is rested for "
        f"{db.FEED_RETRY_DAYS} days, so one broken publisher cannot fill every sweep "
        f"with the same warning."
    )


def _versions() -> None:
    import altair
    import requests

    st.subheader("Versions")
    st.caption(
        " · ".join([
            f"Python {platform.python_version()}",
            f"Streamlit {st.__version__}",
            f"pandas {pd.__version__}",
            f"Altair {altair.__version__}",
            f"requests {requests.__version__}",
            f"SQLite {sqlite3.sqlite_version}",
        ])
    )
