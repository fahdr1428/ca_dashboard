"""The search matrix.

This is how the app finds people rather than waiting to be told about them. Each
template describes one way that wealth arrives — a business sold, a round
raised, a dividend paid, a company floated — and is crossed with each selected
market to produce a targeted news query.

Google News' RSS endpoint is the workhorse: it indexes thousands of publishers,
needs no API key, accepts quoted phrases, boolean OR and a `when:` recency
filter, and returns clean RSS.

Two things drive yield, and both are set here:

  * **Place breadth.** A query for "Devon" misses the article that only says
    "Newton Abbot". Towns are OR-ed into the query rather than searched
    separately, so recall rises without the query count exploding.
  * **Depth.** A one-minute sweep and a ten-minute sweep are different products.
    `DEPTHS` makes that an explicit choice with an honest time estimate, instead
    of something the user has to infer from a slider.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote_plus

from .config import REQUEST_DELAY_SECONDS
from .markets import ALL_MARKETS, MARKET_BY_KEY, expand_selection, locale_for

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
        '"sold her stake" OR "completes sale of" OR "agrees sale of" OR '
        '"exits business" OR "sells majority stake")',
        95,
        "A completed disposal turns paper wealth into cash. The strongest single "
        "indicator that someone has investable assets right now.",
    ),
    EventTemplate(
        "acquisition",
        "Acquired",
        '("acquired by" OR "snapped up by" OR "takeover of" OR "buys stake in" OR '
        '"agrees to acquire" OR "acquires majority")',
        85,
        "An acquisition usually pays out the founders and any minority holders.",
    ),
    EventTemplate(
        "management_buyout",
        "Management buyout",
        '("management buyout" OR "MBO" OR "employee ownership trust" OR '
        '"management buy-in")',
        80,
        "A buyout pays the exiting owner and creates newly-wealthy managers.",
    ),
    EventTemplate(
        "venture_funding",
        "Venture funding",
        '(raises OR secures OR closes) ("Series A" OR "Series B" OR "Series C" OR '
        '"funding round" OR "investment round" OR "growth round")',
        65,
        "A priced round values the founder's stake, but it is paper wealth — the "
        "relationship is worth building before the exit, not after.",
    ),
    EventTemplate(
        "private_equity",
        "Private equity",
        '("private equity" OR "growth capital" OR "sovereign wealth fund") '
        '(backs OR invests OR acquires OR "takes stake")',
        80,
        "A sponsor on the register means an exit is coming, usually inside five years.",
    ),
    EventTemplate(
        "ipo",
        "IPO or flotation",
        '(IPO OR "initial public offering" OR "floats on" OR "AIM listing" OR '
        '"stock market listing" OR "lists shares")',
        85,
        "A listing creates tradeable, valued holdings and a known liquidity date.",
    ),
    EventTemplate(
        "large_dividend",
        "Large dividend",
        '(dividend OR "distribution to shareholders" OR "special dividend") '
        '(director OR founder OR owner OR shareholder)',
        75,
        "Distributions move money from the company to the individual — directly "
        "investable, and repeatable.",
    ),
    EventTemplate(
        "windfall",
        "Windfall or payout",
        '(windfall OR payout OR "cashes in" OR "nets" OR "pockets" OR '
        '"walks away with")',
        85,
        "Explicit reporting of money reaching a named individual.",
    ),
    EventTemplate(
        "share_sale",
        "Share sale",
        '("sells shares" OR "share sale" OR "offloads shares" OR "reduces stake" OR '
        '"trims stake")',
        75,
        "A disclosed disposal of listed shares is realised, liquid cash.",
    ),
    EventTemplate(
        "rich_list",
        "Wealth list",
        '("rich list" OR "wealth list" OR "richest" OR "wealthiest" OR '
        '"net worth")',
        55,
        "Published lists are a starting point only; they are frequently wrong at "
        "the individual level and must be corroborated.",
    ),
    EventTemplate(
        "family_office",
        "Family office",
        '("family office" OR "family investment company" OR "family holding company")',
        85,
        "Setting one up means significant realised wealth and an active search "
        "for how to manage it.",
    ),
    EventTemplate(
        "property",
        "Significant property",
        '(buys OR purchases OR acquires) (estate OR manor OR mansion OR '
        '"country house" OR penthouse OR "property portfolio")',
        50,
        "Large property purchases indicate wealth but tie it up; useful as "
        "corroboration rather than as a lead on its own.",
    ),
    EventTemplate(
        "company_growth",
        "Rapid growth",
        '("turnover rises" OR "revenue jumps" OR "profits soar" OR "record year" OR '
        '"record profits" OR "fastest growing")',
        45,
        "Growth builds value over time. Weak on its own, useful in combination.",
    ),
    EventTemplate(
        "succession",
        "Succession or retirement",
        '("steps down" OR retires OR "hands over" OR succession) '
        '(founder OR chairman OR "managing director" OR "chief executive")',
        60,
        "Owners approaching succession are often about to sell, and are actively "
        "thinking about what happens to the money.",
    ),
)

EVENT_BY_KEY: dict[str, EventTemplate] = {t.key: t for t in EVENT_TEMPLATES}

#: The events where money has genuinely changed hands. Highest yield per query,
#: so a short sweep uses only these.
REALISED_EVENT_KEYS: tuple[str, ...] = (
    "business_exit", "acquisition", "management_buyout", "windfall", "share_sale",
)


# ---------------------------------------------------------------------------
# Depth
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Depth:
    """How hard to look. Quality-over-speed made explicit and costed."""

    key: str
    label: str
    description: str
    #: Empty means every event template.
    event_keys: tuple[str, ...]
    #: Look-back windows in days. Two windows find both this week's news and the
    #: back catalogue, at the cost of doubling the query count.
    windows: tuple[int, ...]
    #: How many town names to OR into each query alongside the market name.
    places: int
    #: Towns per query block. More places per block means fewer, broader queries.
    block_size: int
    include_publishers: bool


DEPTHS: tuple[Depth, ...] = (
    Depth(
        "quick", "Quick look",
        "The five events where money has actually changed hands, market names only. "
        "Use it to check the plumbing works.",
        REALISED_EVENT_KEYS, (30,), 0, 6, False,
    ),
    Depth(
        "standard", "Standard sweep",
        "All 14 wealth events, with the main towns in each market folded into the "
        "queries. The normal weekly run.",
        (), (30,), 6, 7, True,
    ),
    Depth(
        "deep", "Deep search",
        "All events, every town in each market, and both a recent and a wider "
        "window. This is the setting to use when you want volume.",
        (), (7, 90), 14, 7, True,
    ),
    Depth(
        "exhaustive", "Exhaustive",
        "Everything the app knows how to ask, over three windows. Leave it running.",
        (), (7, 30, 180), 24, 5, True,
    ),
)

DEPTH_BY_KEY: dict[str, Depth] = {d.key: d for d in DEPTHS}
#: Standard over a multi-market preset is roughly ten minutes of searching, which
#: is the point where yield stops improving much per minute spent.
DEFAULT_DEPTH = "standard"


# ---------------------------------------------------------------------------
# Building queries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SearchQuery:
    market_key: str
    market_name: str
    event_key: str
    query: str
    url: str
    window_days: int


def google_news_url(
    query: str, *, days: int = 7, market_key: str | None = None
) -> str:
    """Build a Google News RSS search URL.

    ``when:`` restricts to recent items, which is what makes a weekly sweep
    cheap — we ask only for what changed since the last run. The locale comes
    from the market, because `gl` decides which publishers Google will surface at
    all: searching Dubai on the GB edition quietly hides the Gulf press.
    """
    hl, gl = locale_for(market_key) if market_key else ("en-GB", "GB")
    full = f"{query} when:{days}d"
    return (
        f"{GOOGLE_NEWS_RSS}?q={quote_plus(full)}"
        f"&hl={hl}&gl={gl}&ceid={gl}:en"
    )


def place_blocks(market_key: str, *, places: int, block_size: int) -> list[str]:
    """Query fragments naming the market and, optionally, its towns.

    Towns are OR-ed together rather than searched one at a time. A single
    `("Devon" OR "Exeter" OR "Plymouth" OR "Torbay")` query finds everything four
    separate queries would, for a quarter of the requests.
    """
    market = MARKET_BY_KEY.get(market_key)
    if market is None or not market.places:
        return []

    # Search terms come from `places`, never from `name`. Several markets are
    # grouped under an editorial label — "Connecticut & Tri-State", "Home
    # Counties" — and searching for the label itself finds nothing. `places[0]`
    # is always a real place, and for simple markets it is the name anyway.
    names = [market.places[0]]
    if places:
        names += [p for p in market.places[1:][:places]]

    blocks: list[str] = []
    for start in range(0, len(names), block_size):
        chunk = names[start:start + block_size]
        joined = " OR ".join(f'"{name}"' for name in chunk)
        blocks.append(f"({joined})" if len(chunk) > 1 else joined)
    return blocks


def build_search_matrix(
    *,
    market_keys: tuple[str, ...] | list[str] | None = None,
    depth: str = DEFAULT_DEPTH,
    event_keys: tuple[str, ...] | list[str] | None = None,
    days: int | None = None,
) -> list[SearchQuery]:
    """Cross every event template with every place block in every market.

    ``days`` overrides the depth's own windows when the caller wants one specific
    look-back (a weekly cron run asks for 7 and nothing else).
    """
    settings = DEPTH_BY_KEY.get(depth, DEPTH_BY_KEY[DEFAULT_DEPTH])
    keys = expand_selection(market_keys)

    chosen = event_keys or settings.event_keys
    templates = (
        [EVENT_BY_KEY[k] for k in chosen if k in EVENT_BY_KEY]
        if chosen
        else list(EVENT_TEMPLATES)
    )
    windows = (days,) if days else settings.windows

    matrix: list[SearchQuery] = []
    for key in keys:
        market = MARKET_BY_KEY[key]
        blocks = place_blocks(key, places=settings.places, block_size=settings.block_size)
        for block in blocks:
            for template in templates:
                for window in windows:
                    query = f"{block} {template.phrase}"
                    matrix.append(
                        SearchQuery(
                            market_key=key,
                            market_name=market.name,
                            event_key=template.key,
                            query=query,
                            url=google_news_url(query, days=window, market_key=key),
                            window_days=window,
                        )
                    )
    return matrix


@dataclass(frozen=True)
class Plan:
    """What a sweep will cost, so the user can see it before pressing go."""

    queries: int
    markets: int
    events: int
    windows: int
    seconds: float

    @property
    def human_time(self) -> str:
        minutes = self.seconds / 60
        if minutes < 1.5:
            return "under a minute"
        if minutes < 90:
            return f"about {round(minutes)} minutes"
        return f"about {minutes / 60:.1f} hours"


def plan_sweep(
    *,
    market_keys: tuple[str, ...] | list[str] | None = None,
    depth: str = DEFAULT_DEPTH,
    event_keys: tuple[str, ...] | list[str] | None = None,
    days: int | None = None,
    include_publishers: bool | None = None,
    max_queries: int | None = None,
) -> Plan:
    """Estimate a sweep without running it.

    Counting the matrix is cheap — it is string building, no requests — so the UI
    can show an honest number rather than a guess.
    """
    settings = DEPTH_BY_KEY.get(depth, DEPTH_BY_KEY[DEFAULT_DEPTH])
    matrix = build_search_matrix(
        market_keys=market_keys, depth=depth, event_keys=event_keys, days=days
    )
    count = len(matrix)
    if max_queries:
        count = min(count, max_queries)
    publishers = PUBLISHER_FEEDS if (
        settings.include_publishers if include_publishers is None else include_publishers
    ) else ()
    count += len(publishers)

    return Plan(
        queries=count,
        markets=len(expand_selection(market_keys)),
        events=len({q.event_key for q in matrix}),
        windows=len({q.window_days for q in matrix}),
        # One request per query plus the delay between them, and a little for
        # parsing and the database writes.
        seconds=count * (REQUEST_DELAY_SECONDS + 0.45),
    )


#: Business publishers swept broadly in addition to the targeted queries. These
#: carry deal news that never reaches national aggregation, and between them
#: cover the UK regions, the US, the Gulf and Asia.
PUBLISHER_FEEDS: tuple[tuple[str, str], ...] = (
    # United Kingdom
    ("BusinessLive South West", "https://www.business-live.co.uk/west-country/?service=rss"),
    ("BusinessLive South East", "https://www.business-live.co.uk/south-east/?service=rss"),
    ("BusinessLive National", "https://www.business-live.co.uk/?service=rss"),
    ("Insider Media South West", "https://www.insidermedia.com/rss/southwest"),
    ("Insider Media South East", "https://www.insidermedia.com/rss/southeast"),
    ("UKTN", "https://www.uktech.news/feed"),
    ("The Business Magazine", "https://thebusinessmagazine.co.uk/feed/"),
    ("Bdaily", "https://bdaily.co.uk/rss"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("Sky News Business", "https://feeds.skynews.com/feeds/rss/business.xml"),
    # United States
    ("Reuters Deals", "https://news.google.com/rss/search?q=site:reuters.com+(acquires+OR+%22sells+stake%22)&hl=en-US&gl=US&ceid=US:en"),
    ("Axios Pro Rata", "https://api.axios.com/feed/pro-rata"),
    ("TechCrunch", "https://techcrunch.com/feed/"),
    ("Forbes Billionaires", "https://www.forbes.com/billionaires/feed/"),
    # Middle East
    ("Arabian Business", "https://www.arabianbusiness.com/feed"),
    ("Zawya Deals", "https://www.zawya.com/en/rss/deals"),
    ("Gulf Business", "https://gulfbusiness.com/feed/"),
    ("The National Business", "https://www.thenationalnews.com/arc/outboundfeeds/rss/category/business/"),
    # Wider
    ("Private Equity Wire", "https://www.privateequitywire.co.uk/feed/"),
    ("Family Capital", "https://www.famcap.com/articles?format=rss"),
)
