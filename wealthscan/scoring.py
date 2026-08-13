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

import re
from dataclasses import dataclass, field

from .config import (
    ANNUAL_INCOME_THRESHOLD_GBP,
    MODEL,
    PRIORITY_THRESHOLD_GBP,
    QUALIFYING_THRESHOLD_GBP,
)

# Events where money has actually changed hands.
REALISED_EVENTS = frozenset({
    "business_exit", "acquisition", "management_buyout", "windfall", "share_sale",
    "land_sale",
})
# Events that value a stake without realising it.
UNREALISED_EVENTS = frozenset({"venture_funding", "private_equity", "ipo"})
# Events that indicate wealth but cannot size it.
INDICATIVE_ONLY = frozenset({
    "property", "family_office", "succession", "company_growth", "landholding",
})
# Events that evidence recurring income rather than a capital position.
INCOME_EVENTS = frozenset({"exec_comp", "large_dividend"})

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
    #: Recurring income — executive pay, or an attributable dividend. A separate
    #: question from net worth: a listed-company executive on £2m a year may hold
    #: very little liquid capital, and is a live planning need either way.
    annual_income_gbp: int | None = None
    annual_income_basis: str | None = None


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


def parse_ownership_band(band: str | None) -> tuple[float, float, float] | None:
    """Turn a filed PSC band like "50–75%" into low/mid/high fractions."""
    if not band:
        return None
    # Decimals must be matched whole: r"\d+" reads "12.5%" as two numbers (12
    # and 5) and would report a band of 12%–5%.
    numbers = re.findall(r"\d+(?:\.\d+)?", band)
    if len(numbers) >= 2:
        low, high = float(numbers[0]) / 100, float(numbers[1]) / 100
        if high < low:
            low, high = high, low
        return low, (low + high) / 2, high
    if len(numbers) == 1:
        exact = float(numbers[0]) / 100
        return exact, exact, exact
    return None


def estimate_from_event(
    *,
    event_key: str,
    amount_gbp: int | None,
    text: str,
    has_named_person: bool,
    known_stake_band: str | None = None,
    co_principals: int = 1,
) -> Estimate:
    """Estimate an individual's position from one reported event.

    ``known_stake_band`` is a filed PSC band such as "50–75%". When supplied it
    replaces the assumed shareholding — which removes the single largest source
    of error, and means the output must no longer describe the stake as assumed.

    ``co_principals`` is how many individuals the source names for the same
    transaction. Storing all of them is right — an article naming two co-founders
    describes two prospects, and keeping only the first threw one away — but
    giving each of them the whole founder stake would report £64m three times
    over. The assumed stake is divided between them instead, and the record says
    so. A *filed* band is never divided: that is their actual shareholding.
    """
    co_principals = max(1, int(co_principals))

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
        # The largest figure in a headline is usually the consideration, but not
        # always: "sells minority stake at a $1.4bn valuation" prices the whole
        # company, not the proceeds, and treating the two alike overstates the
        # position several times over. The arithmetic cannot tell them apart from
        # a 200-character snippet, so the record says so instead of pretending.
        priced_off_valuation = bool(
            re.search(r"\b(valuation|valued at|values the (?:company|business|group))\b",
                      text, re.I)
        )
        filed = parse_ownership_band(known_stake_band)
        if filed:
            lows, mids, highs = filed
        else:
            # Split between everyone the source names, or the same transaction
            # gets counted once per co-founder.
            lows, mids, highs = (
                MODEL.assumed_founder_stake_low / co_principals,
                MODEL.assumed_founder_stake_mid / co_principals,
                MODEL.assumed_founder_stake_high / co_principals,
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
                + (
                    f"individual holds {lows:.0%}–{highs:.0%} per the filed PSC register "
                    f"(midpoint {mids:.0%} used)"
                    if filed
                    else f"individual is assumed to hold {mids:.0%} "
                         f"(range {lows:.0%}–{highs:.0%})"
                )
                + f", less {MODEL.exit_tax_rate:.0%} capital gains tax, of which "
                  f"{retention:.0%} is assumed retained rather than spent."
            ),
            caveats=(
                [
                    "The shareholding is taken from the filed PSC register, so the "
                    "largest source of error is removed. The band is 25 points wide, "
                    "so its midpoint is still an approximation.",
                ]
                if filed
                else [
                    "The individual's actual shareholding is not stated in the source. "
                    "The stake is an assumption and is the single largest source of error "
                    "in this figure — verify it on the Companies House PSC register before "
                    "relying on it.",
                ] + ([
                    f"The source names {co_principals} principals for this transaction, so "
                    f"the assumed founder stake is split equally between them. Real splits "
                    f"are rarely equal — a lead founder usually holds more — so treat this "
                    f"as a floor for whoever led the business.",
                ] if co_principals > 1 else [])
            ) + [
                "Reported transaction values often include debt, deferred "
                "consideration or earn-outs that never reach the seller.",
            ] + ([
                "The source describes a **valuation**, which is the price of the whole "
                "company rather than the money the seller received. If only part of the "
                "business changed hands, this figure is too high — possibly by a large "
                "multiple. Find the consideration before using it.",
            ] if priced_off_valuation else []),
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

    # --- Listed-company executive pay --------------------------------------
    if event_key == "exec_comp":
        # Uniquely among everything here, this figure is *disclosed*, not
        # modelled: a remuneration report states the number. So it is recorded as
        # income with no stake assumption, and no net-worth estimate is invented
        # from it — a large salary says nothing reliable about accumulated
        # capital.
        return Estimate(
            None, None, None, None, None, None,
            band="Not estimated",
            method="Income disclosed in a listed-company remuneration report.",
            caveats=[
                "This is annual remuneration, not net worth. Accumulated capital "
                "is unknown and may be far smaller or far larger.",
                "Reported packages usually include share awards that vest over "
                "several years and may never vest at all.",
            ],
            not_estimated_reason=(
                f"{_fmt(amount_gbp)} of annual remuneration is disclosed, which is "
                f"income rather than assets. No net-worth figure is derived from it, "
                f"because pay does not evidence accumulated capital. Check the "
                f"director shareholdings table in the same annual report for that."
            ),
            annual_income_gbp=amount_gbp,
            annual_income_basis=(
                f"{_fmt(amount_gbp)} total remuneration as disclosed by the company. "
                f"Stated, not modelled."
            ),
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
            annual_income_gbp=int(amount_gbp * stake),
            annual_income_basis=(
                f"{_fmt(amount_gbp)} distributed, of which the named individual is "
                f"assumed to receive {stake:.0%} — {_fmt(amount_gbp * stake)} before tax. "
                f"The split is assumed, not stated."
            ),
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

#: Publishers whose business reporting is reliable enough to lean on. Not a
#: judgement about journalism in general — only about whether a deal figure
#: attributed to a named person can be leaned on without a second source.
TRUSTED_PUBLISHERS = (
    # United Kingdom
    "bbc", "financial times", "ft.com", "reuters", "bloomberg", "the times",
    "sunday times", "telegraph", "guardian", "insider media", "businesslive",
    "business live", "uktn", "sky news", "city a.m", "the business magazine",
    "bdaily", "development finance", "growth business", "sifted",
    # United States
    "wall street journal", "wsj", "cnbc", "forbes", "fortune", "axios",
    "techcrunch", "business insider", "barron", "pitchbook", "the information",
    "associated press", "ap news", "new york times",
    # Middle East
    "arabian business", "zawya", "gulf business", "the national", "arab news",
    "khaleej times", "gulf news", "meed", "wamda",
    # Europe and Asia-Pacific
    "handelsblatt", "les echos", "il sole", "expansión", "nikkei",
    "south china morning post", "scmp", "straits times", "the australian",
    "australian financial review", "economic times", "livemint", "mint",
    "business standard", "tech.eu", "eu-startups",
    # Sector press
    "private equity wire", "family capital", "citywire", "ignites", "with intelligence",
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
    location_from_text: bool = True,
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
        0.20,
        f"Reported by {publisher or 'an unidentified publisher'}."
        + ("" if trusted else " Not a publisher on the known-reliable list, so the claim needs corroborating."),
    ))

    dims.append(ConfidenceDimension(
        "identity", "Individual identified",
        72 if has_named_person else 18,
        0.22,
        "An individual is named in the source."
        if has_named_person
        else "No individual is named — this is a company-level lead until someone is identified.",
    ))

    if companies_house_verified:
        dims[-1] = ConfidenceDimension(
            "identity", "Individual identified", 92, 0.22,
            "Matched to a Companies House officer record, so the person behind the "
            "appointments is confirmed.",
        )

    dims.append(ConfidenceDimension(
        "ownership", "Ownership evidence",
        90 if stake_verified else 25,
        0.22,
        "Shareholding evidenced by the PSC register."
        if stake_verified
        else "The individual's shareholding is assumed, not evidenced. This is the "
             "weakest link in any news-derived estimate.",
    ))

    dims.append(ConfidenceDimension(
        "amount", "Figure disclosed",
        70 if amount_disclosed else 20,
        0.13,
        "A monetary value is stated in the source."
        if amount_disclosed
        else "No monetary value was reported, so no figure could be derived.",
    ))

    # Where the location came from. An article surfaced by the Dubai search that
    # never says "Dubai" is still worth keeping — discarding those is what made
    # the first version of this app return almost nothing — but the location is
    # then an inference, and pretending otherwise would be the same class of
    # error as presenting an estimate as a fact.
    dims.append(ConfidenceDimension(
        "location", "Location evidence",
        80 if location_from_text else 35,
        0.10,
        "The source names the place, so the market is evidenced."
        if location_from_text
        else "The source does not name a place. The market is inferred from the search "
             "that found the article — check it before acting on the record.",
    ))

    corroboration = min(95, 30 + (source_count - 1) * 28)
    dims.append(ConfidenceDimension(
        "corroboration", "Corroboration",
        corroboration,
        0.13,
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
        "location": "Confirm where they are actually based — the market was inferred from the search, not stated in the source.",
        "corroboration": "Find a second independent source before making contact.",
    }

    return Confidence(
        score=score,
        band=_band(score),
        dimensions=dims,
        next_action=actions.get(weakest.key, "Corroborate with an additional public source."),
    )


def cohort_for(
    investable_mid: int | None,
    gross_mid: int | None,
    annual_income: int | None = None,
) -> str:
    """Which pipeline cohort a prospect belongs to.

    Income qualifies independently of assets. An owner-manager taking £1.5m a
    year in dividends, or a listed-company executive on a £2m package, is a live
    planning need whether or not they have accumulated investable capital — and
    they are reachable years before any exit.
    """
    if investable_mid is not None and investable_mid >= QUALIFYING_THRESHOLD_GBP:
        return "Qualifying"
    if annual_income is not None and annual_income >= ANNUAL_INCOME_THRESHOLD_GBP:
        return "High income"
    if gross_mid is not None and gross_mid >= PRIORITY_THRESHOLD_GBP:
        return "Pre-liquidity founder"
    if investable_mid is None and gross_mid is None and annual_income is None:
        return "Research lead"
    return "Below threshold"
