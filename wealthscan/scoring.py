"""Turning a reported event into an estimate — and saying what it rests on.

The governing rule: news tells you a *transaction* happened and often its size.
It almost never tells you what share of it reached a named individual. So every
figure here is derived from a stated assumption, the assumption is written into
the output in plain English, and the confidence reflects how much of the chain
is assumed rather than observed.

Where an event cannot support a monetary estimate at all — a property purchase,
a retirement, a family office being set up — this module says so and returns no
number, rather than inventing one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import MODEL, PRIORITY_THRESHOLD_GBP, QUALIFYING_THRESHOLD_GBP

# Events where money has actually changed hands.
REALISED_EVENTS = frozenset({
    "business_exit", "acquisition", "management_buyout", "windfall", "share_sale",
})
# Events that value a stake without realising it.
UNREALISED_EVENTS = frozenset({"venture_funding", "private_equity", "ipo"})
# Events that indicate wealth but cannot size it.
INDICATIVE_ONLY = frozenset({
    "property", "family_office", "succession", "company_growth",
})

WEALTH_BANDS: tuple[tuple[str, int, int | None], ...] = (
    ("Below £7.5m", 0, 7_500_000),
    ("£7.5m – £15m", 7_500_000, 15_000_000),
    ("£15m – £30m", 15_000_000, 30_000_000),
    ("£30m – £50m", 30_000_000, 50_000_000),
    ("£50m – £100m", 50_000_000, 100_000_000),
    ("£100m+", 100_000_000, None),
)


def band_for(amount_gbp: int | None) -> str:
    if amount_gbp is None:
        return "Not estimated"
    for label, low, high in reversed(WEALTH_BANDS):
        if amount_gbp >= low:
            return label
    return "Below £7.5m"


@dataclass
class Estimate:
    """A wealth estimate, or an explicit statement that none is possible."""

    #: None means "cannot be estimated from this evidence" — never zero.
    gross_low_gbp: int | None
    gross_mid_gbp: int | None
    gross_high_gbp: int | None
    investable_low_gbp: int | None
    investable_mid_gbp: int | None
    investable_high_gbp: int | None
    band: str
    #: The arithmetic, in plain English, shown next to the number.
    method: str
    #: Why the figure is uncertain, or why there is no figure.
    caveats: list[str] = field(default_factory=list)
    is_realised: bool = False
    #: Set when no monetary estimate was possible, explaining why.
    not_estimated_reason: str | None = None


def _fmt(amount: float) -> str:
    if abs(amount) >= 1_000_000_000:
        return f"£{amount / 1_000_000_000:.2f}bn"
    if abs(amount) >= 1_000_000:
        return f"£{amount / 1_000_000:.1f}m"
    if abs(amount) >= 1_000:
        return f"£{amount / 1_000:.0f}k"
    return f"£{amount:.0f}"


def _founder_share_for_stage(text: str) -> tuple[float, str]:
    """Assumed founder shareholding after a given funding stage."""
    lowered = text.lower()
    if "series c" in lowered or "series d" in lowered or "series e" in lowered:
        return MODEL.founder_share_after_later, "Series C or later"
    if "series b" in lowered:
        return MODEL.founder_share_after_series_b, "Series B"
    if "series a" in lowered:
        return MODEL.founder_share_after_series_a, "Series A"
    if "seed" in lowered:
        return MODEL.founder_share_after_seed, "seed stage"
    return MODEL.founder_share_after_series_a, "an unspecified round"


def estimate_from_event(
    *,
    event_key: str,
    amount_gbp: int | None,
    text: str,
    has_named_person: bool,
) -> Estimate:
    """Estimate an individual's position from one reported event."""

    none_estimate = lambda reason: Estimate(  # noqa: E731 - terse by design
        None, None, None, None, None, None,
        band="Not estimated",
        method="No monetary estimate attempted.",
        caveats=[],
        not_estimated_reason=reason,
    )

    if event_key in INDICATIVE_ONLY:
        return none_estimate(
            "This event indicates wealth but cannot size it. It is recorded as "
            "corroboration, and the prospect will only carry a figure once a "
            "transaction, dividend or holding is found."
        )

    if amount_gbp is None:
        return none_estimate(
            "No monetary value was reported, so there is nothing to estimate "
            "from. The event is recorded as a lead for manual research."
        )

    if not has_named_person:
        return none_estimate(
            f"A {_fmt(amount_gbp)} transaction was reported but no individual was "
            "named, so it cannot be attributed to a person. Tracked as a "
            "company-level lead — identify the owner to produce an estimate."
        )

    # --- Realised: money has actually changed hands ------------------------
    if event_key in REALISED_EVENTS:
        lows, mids, highs = (
            MODEL.assumed_founder_stake_low,
            MODEL.assumed_founder_stake_mid,
            MODEL.assumed_founder_stake_high,
        )
        after_tax = 1 - MODEL.exit_tax_rate
        gross_low = int(amount_gbp * lows * after_tax)
        gross_mid = int(amount_gbp * mids * after_tax)
        gross_high = int(amount_gbp * highs * after_tax)

        retention = MODEL.retention_rate
        liquidity = MODEL.liquidity_realised
        inv_low = int(gross_low * retention * liquidity)
        inv_mid = int(gross_mid * retention * liquidity)
        inv_high = int(gross_high * retention * liquidity)

        return Estimate(
            gross_low, gross_mid, gross_high,
            inv_low, inv_mid, inv_high,
            band=band_for(inv_mid),
            method=(
                f"{_fmt(amount_gbp)} reported transaction value, of which the named "
                f"individual is assumed to hold {mids:.0%} (range {lows:.0%}–{highs:.0%}), "
                f"less {MODEL.exit_tax_rate:.0%} capital gains tax, of which "
                f"{retention:.0%} is assumed retained rather than spent."
            ),
            caveats=[
                "The individual's actual shareholding is not stated in the source. "
                "The stake is an assumption and is the single largest source of error "
                "in this figure — verify it on the Companies House PSC register before "
                "relying on it.",
                "Reported transaction values often include debt, deferred "
                "consideration or earn-outs that never reach the seller.",
            ],
            is_realised=True,
        )

    # --- Unrealised: a valuation event, not a payday -----------------------
    if event_key in UNREALISED_EVENTS:
        founder_share, stage_label = _founder_share_for_stage(text)

        if event_key == "venture_funding":
            # The raise is not the valuation. Implied post-money assumes the
            # round bought 15-25% of the company — a crude but standard rule.
            post_low, post_mid, post_high = (
                amount_gbp / 0.25, amount_gbp / 0.20, amount_gbp / 0.15,
            )
            basis = (
                f"{_fmt(amount_gbp)} raised implies a post-money valuation of roughly "
                f"{_fmt(post_mid)} (assuming the round bought 15–25% of the company)"
            )
            extra_caveat = (
                "The raise amount was reported but the valuation was not. Implying a "
                "valuation from the round size is crude — if the actual post-money "
                "figure is reported anywhere, enter it manually and re-estimate."
            )
        else:
            post_low = post_mid = post_high = float(amount_gbp)
            basis = f"{_fmt(amount_gbp)} reported company valuation"
            extra_caveat = (
                "The valuation is as reported at the time of the transaction and "
                "will have moved since."
            )

        gross_low = int(post_low * founder_share * 0.6)
        gross_mid = int(post_mid * founder_share)
        gross_high = int(post_high * founder_share * 1.4)

        liquidity = MODEL.liquidity_unrealised
        return Estimate(
            gross_low, gross_mid, gross_high,
            int(gross_low * liquidity), int(gross_mid * liquidity), int(gross_high * liquidity),
            band=band_for(int(gross_mid * liquidity)),
            method=(
                f"{basis}, of which the founder is assumed to retain "
                f"{founder_share:.0%} after {stage_label}. Only "
                f"{liquidity:.0%} is counted as investable, because unexited "
                f"founder equity cannot be sold."
            ),
            caveats=[
                extra_caveat,
                "This is paper wealth. The individual may have very little "
                "investable cash despite a large headline figure — which is exactly "
                "why the relationship is worth building before an exit, not after.",
            ],
            is_realised=False,
        )

    # --- Dividends ---------------------------------------------------------
    if event_key == "large_dividend":
        stake = MODEL.assumed_founder_stake_mid
        net = amount_gbp * stake * (1 - MODEL.dividend_tax_rate)
        retained = net * MODEL.retention_rate
        liquidity = MODEL.liquidity_dividend
        return Estimate(
            int(retained * 0.6), int(retained), int(retained * 1.5),
            int(retained * 0.6 * liquidity), int(retained * liquidity), int(retained * 1.5 * liquidity),
            band=band_for(int(retained * liquidity)),
            method=(
                f"{_fmt(amount_gbp)} distribution, of which the named individual is "
                f"assumed to receive {stake:.0%}, less {MODEL.dividend_tax_rate:.1%} "
                f"dividend tax, of which {MODEL.retention_rate:.0%} is assumed retained."
            ),
            caveats=[
                "This is one period's distribution only. A recurring dividend at "
                "this level compounds quickly, so check whether it is repeated.",
                "The shareholding split is assumed, not stated.",
            ],
            is_realised=True,
        )

    if event_key == "rich_list":
        return Estimate(
            int(amount_gbp * 0.5), amount_gbp, int(amount_gbp * 1.5),
            int(amount_gbp * 0.5 * 0.6), int(amount_gbp * 0.6), int(amount_gbp * 1.5 * 0.6),
            band=band_for(int(amount_gbp * 0.6)),
            method=(
                f"{_fmt(amount_gbp)} as published by a third-party wealth list. Not "
                f"derived by this system; 60% assumed investable in the absence of a "
                f"breakdown."
            ),
            caveats=[
                "Published wealth lists are frequently inaccurate at the individual "
                "level and rarely distinguish liquid from illiquid assets. Treat as a "
                "starting point for research, not as a figure to quote.",
            ],
            is_realised=False,
        )

    return none_estimate(
        "This event type does not support a monetary estimate."
    )


# ---------------------------------------------------------------------------
# Confidence
# ---------------------------------------------------------------------------

#: Publishers whose business reporting is reliable enough to lean on.
TRUSTED_PUBLISHERS = (
    "bbc", "financial times", "ft.com", "reuters", "bloomberg", "the times",
    "sunday times", "telegraph", "guardian", "insider media", "businesslive",
    "business live", "uktn", "sky news", "city a.m", "the business magazine",
    "bdaily", "development finance", "growth business",
)


@dataclass
class ConfidenceDimension:
    key: str
    label: str
    score: int
    weight: float
    explanation: str


@dataclass
class Confidence:
    score: int
    band: str
    dimensions: list[ConfidenceDimension]
    next_action: str


def _band(score: int) -> str:
    if score >= 85:
        return "Verified"
    if score >= 68:
        return "High"
    if score >= 45:
        return "Medium"
    return "Low"


def score_confidence(
    *,
    publisher: str,
    has_named_person: bool,
    amount_disclosed: bool,
    source_count: int,
    event_weight: int,
    stake_verified: bool = False,
    companies_house_verified: bool = False,
    estimate_is_none: bool = False,
) -> Confidence:
    """How much should an advisor trust this record?

    A separate question from how wealthy the person is, and scored separately so
    a weak spot is visible rather than averaged away.
    """
    dims: list[ConfidenceDimension] = []
    lowered = (publisher or "").lower()

    trusted = any(t in lowered for t in TRUSTED_PUBLISHERS)
    dims.append(ConfidenceDimension(
        "source", "Source reliability",
        78 if trusted else 45,
        0.22,
        f"Reported by {publisher or 'an unidentified publisher'}."
        + ("" if trusted else " Not a publisher on the known-reliable list, so the claim needs corroborating."),
    ))

    dims.append(ConfidenceDimension(
        "identity", "Individual identified",
        72 if has_named_person else 18,
        0.24,
        "An individual is named in the source."
        if has_named_person
        else "No individual is named — this is a company-level lead until someone is identified.",
    ))

    if companies_house_verified:
        dims[-1] = ConfidenceDimension(
            "identity", "Individual identified", 92, 0.24,
            "Matched to a Companies House officer record, so the person behind the "
            "appointments is confirmed.",
        )

    dims.append(ConfidenceDimension(
        "ownership", "Ownership evidence",
        90 if stake_verified else 25,
        0.24,
        "Shareholding evidenced by the PSC register."
        if stake_verified
        else "The individual's shareholding is assumed, not evidenced. This is the "
             "weakest link in any news-derived estimate.",
    ))

    dims.append(ConfidenceDimension(
        "amount", "Figure disclosed",
        70 if amount_disclosed else 20,
        0.14,
        "A monetary value is stated in the source."
        if amount_disclosed
        else "No monetary value was reported, so no figure could be derived.",
    ))

    corroboration = min(95, 30 + (source_count - 1) * 28)
    dims.append(ConfidenceDimension(
        "corroboration", "Corroboration",
        corroboration,
        0.16,
        f"{source_count} independent source{'' if source_count == 1 else 's'} on file."
        + (" Single-source records are the most common cause of false positives."
           if source_count == 1 else ""),
    ))

    total = sum(d.score * d.weight for d in dims)
    # A strong event type lends a little weight; a weak one takes some away.
    total += (event_weight - 60) * 0.06
    if estimate_is_none:
        total -= 6
    score = max(0, min(100, round(total)))

    # Rank by headroom, not by contribution: the most useful next action is the
    # one that would raise the total score most if fixed. Ranking by
    # score × weight instead picks whichever dimension merely matters least,
    # which for a news-derived record wrongly suggests hunting a second article
    # rather than verifying the shareholding the whole estimate rests on.
    weakest = max(dims, key=lambda d: (100 - d.score) * d.weight)
    actions = {
        "source": "Find the same event reported by a second, more reliable publisher.",
        "identity": "Identify the owner — search the company on Companies House and read the officers list.",
        "ownership": "Pull the PSC register entry to replace the assumed stake with a filed band.",
        "amount": "Look for a reported transaction value, or the filed accounts, to put a figure on it.",
        "corroboration": "Find a second independent source before making contact.",
    }

    return Confidence(
        score=score,
        band=_band(score),
        dimensions=dims,
        next_action=actions.get(weakest.key, "Corroborate with an additional public source."),
    )


def cohort_for(investable_mid: int | None, gross_mid: int | None) -> str:
    """Which pipeline cohort a prospect belongs to."""
    if investable_mid is not None and investable_mid >= QUALIFYING_THRESHOLD_GBP:
        return "Qualifying"
    if gross_mid is not None and gross_mid >= PRIORITY_THRESHOLD_GBP:
        return "Pre-liquidity founder"
    if investable_mid is None and gross_mid is None:
        return "Research lead"
    return "Below threshold"
