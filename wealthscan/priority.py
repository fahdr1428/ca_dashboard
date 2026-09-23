"""Who to call first.

Sorting by estimated wealth puts an unverified name with a large headline figure
above a register-confirmed founder who sold last week. That is the wrong way
round for an advisor, whose question each morning is not "who is richest" but
"who is worth my time today". This module answers that with a single score and,
more usefully, a sentence explaining it.

Five things decide it, each capped so none can carry a record on its own:

  * **Wealth fit** (30) — clears the qualifying bar, on assets or on income.
  * **Verification** (25) — a register match beats a press report beats a name.
  * **Timing** (20) — the months after a liquidity event are when money is
    looking for a home and before someone else has found it.
  * **Reachability** (15) — a named adviser, a company, a filed address.
  * **Patch** (10) — inside the advisor's own geography.

Already being worked is not a component but a gate: a prospect contacted in the
last month is shown as in progress rather than competing for today's attention.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import (
    ANNUAL_INCOME_THRESHOLD_GBP,
    PRIORITY_THRESHOLD_GBP,
    QUALIFYING_THRESHOLD_GBP,
)
from .markets import TARGET_PROFILE_KEYS

#: Events where money has already moved. An undisclosed exit is still an exit,
#: and often a better lead than a disclosed funding round.
_REALISED = frozenset({
    "Business exit", "Acquired", "Management buyout", "Windfall or payout",
    "Share sale", "Land or estate sale", "IPO or flotation",
})

#: Pipeline states that take someone off the shortlist entirely.
CLOSED_STATUSES = frozenset({"Client", "Not a fit", "Parked"})

#: How recently an approach keeps someone off today's list.
CONTACT_COOL_OFF_DAYS = 30


@dataclass
class Component:
    label: str
    points: int
    maximum: int
    why: str


@dataclass
class Priority:
    score: int
    components: list[Component] = field(default_factory=list)
    why_now: str = ""
    action: str = ""
    in_progress: bool = False


def _as_datetime(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _money(value) -> int | None:
    try:
        if value is None or value != value:  # NaN from pandas
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _fmt(amount: int) -> str:
    if amount >= 1_000_000_000:
        return f"£{amount / 1_000_000_000:.1f}bn"
    if amount >= 1_000_000:
        return f"£{amount / 1_000_000:.0f}m"
    return f"£{amount / 1_000:.0f}k"


def prioritise(
    record: dict,
    *,
    latest_source_at=None,
    source_count: int = 1,
    last_contacted_at=None,
    now: datetime | None = None,
) -> Priority:
    """Score one prospect and say why, in a sentence an advisor can act on."""
    now = now or datetime.now(timezone.utc)
    components: list[Component] = []

    # --- Wealth fit ---------------------------------------------------------
    investable = _money(record.get("investable_mid_gbp"))
    gross = _money(record.get("gross_mid_gbp"))
    income = _money(record.get("annual_income_gbp"))
    event = str(record.get("primary_event") or "")

    if investable is not None and investable >= 50_000_000:
        wealth, why = 30, f"{_fmt(investable)} estimated investable — well clear of the bar."
    elif investable is not None and investable >= PRIORITY_THRESHOLD_GBP:
        wealth, why = 28, f"{_fmt(investable)} estimated investable."
    elif investable is not None and investable >= QUALIFYING_THRESHOLD_GBP:
        wealth, why = 24, f"{_fmt(investable)} estimated investable — qualifies."
    elif income is not None and income >= ANNUAL_INCOME_THRESHOLD_GBP:
        wealth, why = 24, f"{_fmt(income)} a year in pay or dividends — qualifies on income."
    elif gross is not None and gross >= PRIORITY_THRESHOLD_GBP:
        wealth, why = 16, f"{_fmt(gross)} gross, mostly illiquid — a pre-exit relationship."
    elif investable is None and event in _REALISED:
        # "Sold for an undisclosed sum" is one of the commonest shapes of a real
        # exit. No figure is not the same as no money.
        wealth, why = 14, "A completed sale with the value undisclosed — size it before calling."
    elif investable is not None:
        wealth, why = 6, f"{_fmt(investable)} estimated — below the bar on current evidence."
    else:
        wealth, why = 4, "Wealth indicated but not sized."
    components.append(Component("Wealth fit", wealth, 30, why))

    # --- Verification -------------------------------------------------------
    state = str(record.get("verification_state") or "Unconfirmed")
    verification = {"Confirmed": 25, "Corroborated": 16}.get(state, 4)
    components.append(Component(
        "Verification", verification, 25,
        {
            "Confirmed": "Matched to a company register.",
            "Corroborated": f"Company and role established; {source_count} source(s).",
        }.get(state, "A name near a deal — unverified."),
    ))

    # --- Timing -------------------------------------------------------------
    latest = _as_datetime(latest_source_at)
    if latest is None:
        timing, why = 4, "Date of the event unknown."
    else:
        days = max(0, (now - latest).days)
        timing = 20 if days <= 14 else 16 if days <= 30 else 11 if days <= 60 else 6 if days <= 120 else 2
        why = (
            "Reported in the last fortnight." if days <= 14
            else f"Reported {days} days ago."
        )
        # The window after money has moved is the one that closes.
        if event not in _REALISED:
            timing = int(round(timing * 0.7))
    components.append(Component("Timing", timing, 20, why))

    # --- Reachability -------------------------------------------------------
    reach = 0
    routes: list[str] = []
    adviser = str(record.get("known_adviser") or "").strip()
    if adviser:
        reach += 6
        routes.append("adviser named")
    if record.get("company"):
        reach += 3
        routes.append("company known")
    if record.get("ch_registered_office") or record.get("address") or record.get(
        "ch_company_number"
    ):
        reach += 3
        routes.append("filed address")
    company_name = str(record.get("company") or "").lower()
    if any(m in company_name for m in ("family office", "family investment", "holdings")):
        reach += 3
        routes.append("own investment vehicle")
    reach = min(reach, 15)
    components.append(Component(
        "Reachability", reach, 15,
        ", ".join(routes).capitalize() + "." if routes else "No route in identified yet.",
    ))

    # --- Patch --------------------------------------------------------------
    market = record.get("market_key")
    if market in TARGET_PROFILE_KEYS:
        patch, why = 10, "Inside the target geography."
    elif str(record.get("country") or "") == "United Kingdom":
        patch, why = 5, "Elsewhere in the UK."
    else:
        patch, why = 2, "Outside the UK."
    components.append(Component("Patch", patch, 10, why))

    score = sum(c.points for c in components)

    # --- Already being worked ----------------------------------------------
    contacted = _as_datetime(last_contacted_at)
    in_progress = bool(
        contacted and (now - contacted).days < CONTACT_COOL_OFF_DAYS
    )

    return Priority(
        score=max(0, min(100, score)),
        components=components,
        why_now=_why_now(record, latest, source_count, now),
        action=_action(record, state, adviser, in_progress),
        in_progress=in_progress,
    )


def _why_now(record: dict, latest: datetime | None, source_count: int, now: datetime) -> str:
    """One line: what happened, how sure we are, and how fresh it is."""
    parts: list[str] = []
    event = str(record.get("primary_event") or "Wealth event").lower()
    company = record.get("company")
    amount = _money(record.get("investable_mid_gbp"))
    income = _money(record.get("annual_income_gbp"))

    if company:
        parts.append(f"{event.capitalize()} — {company}")
    else:
        parts.append(event.capitalize())
    if latest is not None:
        days = max(0, (now - latest).days)
        parts.append("this week" if days <= 7 else f"{days} days ago")
    if amount is not None:
        parts.append(f"est. {_fmt(amount)} investable")
    elif income is not None:
        parts.append(f"{_fmt(income)}/yr income")
    state = record.get("verification_state") or "Unconfirmed"
    parts.append(
        "register-confirmed" if state == "Confirmed"
        else f"{source_count} source{'s' if source_count != 1 else ''}"
    )
    if record.get("known_adviser"):
        adviser = str(record["known_adviser"]).split(";")[0].split("(")[0].strip()
        parts.append(f"adviser: {adviser}")
    return " · ".join(parts)


def _action(record: dict, state: str, adviser: str, in_progress: bool) -> str:
    """The single thing to do next. One, not a menu."""
    if in_progress:
        return "Already approached this month — follow up rather than start again."
    if state == "Unconfirmed":
        return "Establish the company and confirm the person on Companies House first."
    if state == "Corroborated" and record.get("company"):
        return (
            f"Confirm them as an officer of {record['company']} on Companies House "
            f"— two minutes, and it moves the record to Confirmed."
        )
    if adviser:
        firm = adviser.split(";")[0].split("(")[0].strip()
        return f"Ask {firm} for an introduction — they acted on the transaction."
    if record.get("company"):
        return (
            f"Write to them as a director of {record['company']} at the registered "
            f"office."
        )
    return "Find a second independent source before any approach."


def shortlist(
    scored: list[tuple[dict, Priority]], *, size: int = 10,
) -> list[tuple[dict, Priority]]:
    """Today's list: verified, open, not already in hand, best first."""
    eligible = [
        (record, priority) for record, priority in scored
        if str(record.get("verification_state") or "") != "Unconfirmed"
        and str(record.get("status") or "New") not in CLOSED_STATUSES
        and not priority.in_progress
        and not record.get("suppressed_at")
    ]
    eligible.sort(key=lambda pair: pair[1].score, reverse=True)
    return eligible[:size]
