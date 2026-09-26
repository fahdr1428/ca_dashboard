"""Searches that keep running when you leave the page.

A deep search takes about a quarter of an hour. Run inside the page, it died the
moment the advisor clicked elsewhere, refreshed, or their laptop slept — and the
work done so far was saved but the summary was lost. Now a search runs on its
own thread, one at a time for the whole app, and any page can show how far it
has got.
"""

from __future__ import annotations

import threading
import time
import traceback
from dataclasses import dataclass, field

import streamlit as st

from wealthscan.report import generate_and_store
from wealthscan.research import RunResult, run_research

from .common import refresh


@dataclass
class SweepJob:
    label: str
    params: dict
    started: float = field(default_factory=time.time)
    message: str = "Starting…"
    fraction: float = 0.0
    result: RunResult | None = None
    error: str | None = None
    detail: str | None = None
    done: bool = False
    finished: float | None = None

    @property
    def elapsed_minutes(self) -> float:
        return ((self.finished or time.time()) - self.started) / 60


@st.cache_resource
def _registry() -> dict:
    """Shared by every session in this server process, so two advisors (or two
    tabs) cannot start overlapping searches that fight over the same feeds."""
    return {"job": None, "lock": threading.Lock()}


def current_job() -> SweepJob | None:
    return _registry()["job"]


def is_running() -> bool:
    job = current_job()
    return job is not None and not job.done


def start_sweep(label: str, **params) -> bool:
    """Start a search in the background. False if one is already running."""
    registry = _registry()
    with registry["lock"]:
        existing = registry["job"]
        if existing is not None and not existing.done:
            return False
        job = SweepJob(label=label, params=params)
        registry["job"] = job

    def progress(message: str, fraction: float) -> None:
        job.message = message
        job.fraction = max(0.0, min(1.0, float(fraction)))

    def work() -> None:
        try:
            job.result = run_research(progress=progress, **params)
            if job.result.new_prospects or job.result.updated_prospects:
                job.message = "Updating the weekly research document…"
                generate_and_store()
        except Exception as error:  # noqa: BLE001 - reported to the page, not swallowed
            job.error = f"{type(error).__name__}: {error}"
            job.detail = traceback.format_exc()
        finally:
            job.fraction = 1.0
            job.finished = time.time()
            job.done = True

    threading.Thread(target=work, name="wealthscan-sweep", daemon=True).start()
    return True


def _notice_finish(job: SweepJob) -> None:
    """Refresh the book once per session when a search finishes, then redraw."""
    if job.done and st.session_state.get("_sweep_seen") != job.started:
        st.session_state["_sweep_seen"] = job.started
        refresh()
        st.rerun()


@st.fragment(run_every=2)
def live_progress() -> None:
    """A progress bar that updates itself while a search runs."""
    job = current_job()
    if job is None:
        return
    if job.done:
        _notice_finish(job)
        return
    st.progress(
        job.fraction,
        text=f"{job.label} — {job.message} ({job.elapsed_minutes:.0f} min so far)",
    )
    st.caption(
        "Runs in the background: you can use the rest of the app, or close this tab, "
        "and it carries on. Everything found is saved as it goes."
    )


@st.fragment(run_every=3)
def sidebar_progress() -> None:
    job = current_job()
    if job is None:
        return
    if job.done:
        _notice_finish(job)
        return
    st.progress(job.fraction, text=f"Searching… {job.fraction:.0%}")


def show_result(job: SweepJob) -> None:
    """What the last search found, in plain terms."""
    if job.error:
        st.error(f"**The search stopped with an error.** Anything found before it is "
                 f"saved. ({job.error})")
        with st.expander("Technical detail"):
            st.code(job.detail or "", language="text")
        return
    result = job.result
    if result is None:
        return

    st.markdown(
        f"**{job.label}** finished in {job.elapsed_minutes:.1f} minutes — {result.status}."
    )
    metrics = st.columns(5)
    metrics[0].metric("Searches run", f"{result.queries_run:,}")
    metrics[1].metric("Articles read", f"{result.articles_seen:,}")
    metrics[2].metric("New people", result.new_prospects)
    metrics[3].metric("Corroborated", result.updated_prospects)
    metrics[4].metric("Unnamed deals", result.company_leads)

    if result.new_prospects:
        st.success(f"**{result.new_prospects} new people found.** They are ranked on "
                   f"**Today** and listed in **Prospect list**.")
    elif result.queries_run and not result.articles_seen:
        st.error(
            "**Every search came back empty.** That usually means the network this app "
            "runs on is blocking outbound requests. Open **System check** and press "
            "*Test Google News* to confirm."
        )
    elif result.company_leads:
        st.warning(
            f"No individuals were named, but {result.company_leads} transaction(s) were "
            f"found with a company and no person — see **Find the owner**."
        )
    else:
        st.warning(
            "Nothing new met the criteria. Widen the markets, raise the depth, or "
            "lengthen the look-back window."
        )

    if result.log:
        with st.expander(f"What was found ({len(result.log)} entries)"):
            for line in result.log:
                st.text(line)
    if result.warnings:
        with st.expander(f"Sources that could not be read ({len(result.warnings)})"):
            for warning in result.warnings:
                st.text(warning)
