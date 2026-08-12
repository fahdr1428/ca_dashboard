"""The search matrix.

This is how the app finds people rather than waiting to be told about them. Each
template describes one way that wealth arrives — a business sold, a round
raised, a dividend paid, a company floated — and is crossed with each of the 13
counties to produce a targeted news query.

Google News' RSS endpoint is the workhorse: it indexes thousands of publishers,
needs no API key, accepts quoted phrases, boolean OR and a `when:` recency
filter, and returns clean RSS. One query per event type per county gives good
coverage of the patch without hammering anybody.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote_plus

from .regions import REGIONS

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"


@dataclass(frozen=True)
class EventTemplate:
    """One kind of wealth event, and how to search for it."""

    key: str
    label: str
    #: Google News query fragment. Quoted phrases keep precision high.
    phrase: str
    #: How strongly this event indicates personal wealth, 0-100.
    weight: int
    #: What the advisor should understand this event to mean.
    meaning: str


EVENT_TEMPLATES: tuple[EventTemplate, ...] = (
    EventTemplate(
        "business_exit",
        "Business exit",
        '("sells business" OR "sold the business" OR "sold his stake" OR '
        '"sold her stake" OR "completes sale of" OR "agrees sale of")',
        95,
        "A completed disposal turns paper wealth into cash. The strongest single "
        "indicator that someone has investable assets right now.",
    ),
    EventTemplate(
        "acquisition",
        "Acquired",
        '("acquired by" OR "snapped up by" OR "takeover of" OR "buys stake in")',
        85,
        "An acquisition usually pays out the founders and any minority holders.",
    ),
    EventTemplate(
        "management_buyout",
        "Management buyout",
        '("management buyout" OR "MBO" OR "employee ownership trust")',
        80,
        "A buyout pays the exiting owner and creates newly-wealthy managers.",
    ),
    EventTemplate(
        "venture_funding",
        "Venture funding",
        '(raises OR secures OR closes) ("Series A" OR "Series B" OR "Series C" OR '
        '"funding round" OR "investment round")',
        65,
        "A priced round values the founder's stake, but it is paper wealth — the "
        "relationship is worth building before the exit, not after.",
    ),
    EventTemplate(
        "private_equity",
        "Private equity",
        '("private equity" OR "growth capital") (backs OR invests OR acquires OR "takes stake")',
        80,
        "A sponsor on the register means an exit is coming, usually inside five years.",
    ),
    EventTemplate(
        "ipo",
        "IPO or flotation",
        '(IPO OR "initial public offering" OR "floats on" OR "AIM listing" OR "stock market listing")',
        85,
        "A listing creates tradeable, valued holdings and a known liquidity date.",
    ),
    EventTemplate(
        "large_dividend",
        "Large dividend",
        '(dividend OR "distribution to shareholders") (director OR founder OR owner)',
        75,
        "Distributions move money from the company to the individual — directly "
        "investable, and repeatable.",
    ),
    EventTemplate(
        "windfall",
        "Windfall or payout",
        '(windfall OR payout OR "cashes in" OR "nets £")',
        85,
        "Explicit reporting of money reaching a named individual.",
    ),
    EventTemplate(
        "share_sale",
        "Share sale",
        '("sells shares" OR "share sale" OR "offloads shares" OR "reduces stake")',
        75,
        "A disclosed disposal of listed shares is realised, liquid cash.",
    ),
    EventTemplate(
        "rich_list",
        "Wealth list",
        '("rich list" OR "wealth list" OR "richest")',
        55,
        "Published lists are a starting point only; they are frequently wrong at "
        "the individual level and must be corroborated.",
    ),
    EventTemplate(
        "family_office",
        "Family office",
        '("family office" OR "family investment company")',
        85,
        "Setting one up means significant realised wealth and an active search "
        "for how to manage it.",
    ),
    EventTemplate(
        "property",
        "Significant property",
        '(buys OR purchases OR acquires) (estate OR manor OR "country house" OR "property portfolio")',
        50,
        "Large property purchases indicate wealth but tie it up; useful as "
        "corroboration rather than as a lead on its own.",
    ),
    EventTemplate(
        "company_growth",
        "Rapid growth",
        '("turnover rises" OR "revenue jumps" OR "profits soar" OR "record year" OR "record profits")',
        45,
        "Growth builds value over time. Weak on its own, useful in combination.",
    ),
    EventTemplate(
        "succession",
        "Succession or retirement",
        '("steps down" OR "retires" OR "hands over" OR "succession") (founder OR chairman OR "managing director")',
        60,
        "Owners approaching succession are often about to sell, and are actively "
        "thinking about what happens to the money.",
    ),
)

EVENT_BY_KEY: dict[str, EventTemplate] = {t.key: t for t in EVENT_TEMPLATES}


@dataclass(frozen=True)
class SearchQuery:
    region: str
    event_key: str
    query: str
    url: str


def google_news_url(query: str, *, days: int = 7, language: str = "en-GB") -> str:
    """Build a Google News RSS search URL.

    ``when:`` restricts to recent items, which is what makes a weekly sweep
    cheap — we ask only for what changed since the last run.
    """
    full = f"{query} when:{days}d"
    return (
        f"{GOOGLE_NEWS_RSS}?q={quote_plus(full)}"
        f"&hl={language}&gl=GB&ceid=GB:en"
    )


def build_search_matrix(
    *,
    days: int = 7,
    regions: tuple[str, ...] | list[str] | None = None,
    event_keys: tuple[str, ...] | list[str] | None = None,
) -> list[SearchQuery]:
    """Cross every event template with every county in scope.

    Thirteen counties by fourteen templates is 182 queries — a few minutes at a
    polite request rate, once a week.
    """
    selected_regions = tuple(regions) if regions else REGIONS
    templates = (
        [EVENT_BY_KEY[k] for k in event_keys if k in EVENT_BY_KEY]
        if event_keys
        else list(EVENT_TEMPLATES)
    )

    matrix: list[SearchQuery] = []
    for region in selected_regions:
        for template in templates:
            # Quoting the county keeps "West Sussex" together and stops Google
            # splitting it into two loose terms.
            query = f'"{region}" {template.phrase}'
            matrix.append(
                SearchQuery(
                    region=region,
                    event_key=template.key,
                    query=query,
                    url=google_news_url(query, days=days),
                )
            )
    return matrix


#: Regional business publishers, swept broadly in addition to targeted queries.
#: These carry deal news that never reaches national aggregation.
PUBLISHER_FEEDS: tuple[tuple[str, str], ...] = (
    ("BusinessLive South West", "https://www.business-live.co.uk/west-country/?service=rss"),
    ("BusinessLive South East", "https://www.business-live.co.uk/south-east/?service=rss"),
    ("Insider Media South West", "https://www.insidermedia.com/rss/southwest"),
    ("Insider Media South East", "https://www.insidermedia.com/rss/southeast"),
    ("UKTN", "https://www.uktech.news/feed"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("The Business Magazine", "https://thebusinessmagazine.co.uk/feed/"),
    ("Bdaily South West", "https://bdaily.co.uk/rss/south-west"),
)
