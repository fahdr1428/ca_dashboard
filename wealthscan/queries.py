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

import re
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
        '("sold his stake" OR "sold her stake" OR "sells his stake" OR '
        '"sells her stake" OR "the founder sold" OR "owner sold" OR '
        '"sells business" OR "sold the business" OR "completes sale of" OR '
        '"exits business" OR "sells majority stake")',
        95,
        "A completed disposal turns paper wealth into cash. The strongest single "
        "indicator that someone has investable assets right now.",
    ),
    EventTemplate(
        "acquisition",
        "Acquired",
        '("acquired by" OR "snapped up by" OR "takeover of" OR "buys stake in" OR '
        '"agrees to acquire" OR "acquires majority") '
        '(founder OR owner OR "family business" OR director OR chairman)',
        85,
        "An acquisition usually pays out the founders and any minority holders.",
    ),
    EventTemplate(
        "management_buyout",
        "Management buyout",
        '("management buyout" OR "MBO" OR "employee ownership trust" OR '
        '"management buy-in") (led by OR founder OR "managing director" OR '
        '"chief executive" OR owner)',
        80,
        "A buyout pays the exiting owner and creates newly-wealthy managers.",
    ),
    EventTemplate(
        "venture_funding",
        "Venture funding",
        '(raises OR secures OR closes) ("Series A" OR "Series B" OR "Series C" OR '
        '"funding round" OR "investment round" OR "growth round") '
        '(founder OR "co-founder" OR "chief executive")',
        65,
        "A priced round values the founder's stake, but it is paper wealth — the "
        "relationship is worth building before the exit, not after.",
    ),
    EventTemplate(
        "private_equity",
        "Private equity",
        '("private equity" OR "growth capital" OR "buyout house") '
        '(backs OR invests OR acquires OR "takes stake") '
        '(founder OR owner OR "management team" OR "family shareholders")',
        80,
        "A sponsor on the register means an exit is coming, usually inside five years.",
    ),
    EventTemplate(
        "ipo",
        "IPO or flotation",
        '(IPO OR "initial public offering" OR "floats on" OR "AIM listing" OR '
        '"stock market listing" OR "lists shares") '
        '(founder OR "will retain" OR "stake worth" OR chairman)',
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
        "land_sale",
        "Land or estate sale",
        '("farmland sold" OR "farm sold" OR "estate sold" OR "sells farmland" OR '
        '"sells the estate" OR "land sale" OR "acres sold" OR "agricultural land '
        'sale" OR "sale of the estate")',
        85,
        "Land converts to cash rarely and in large amounts. Agricultural and "
        "estate wealth is systematically under-covered by prospecting tools "
        "because it generates no funding rounds and no tech press, which is "
        "precisely why it is worth searching for deliberately.",
    ),
    EventTemplate(
        "landholding",
        "Landowner or estate",
        '("landowner" OR "landed estate" OR "country estate" OR "farming family" OR '
        '"agricultural business" OR "estate owner" OR "acres of farmland" OR '
        '"family farm" OR "tenanted estate")',
        70,
        "Substantial land indicates substantial wealth, almost all of it "
        "illiquid. These owners are rarely approached and often face an "
        "inheritance-tax problem they have not solved.",
    ),
    EventTemplate(
        "exec_comp",
        "Executive pay or shareholding",
        '("remuneration report" OR "total remuneration" OR "annual bonus" OR '
        '"long-term incentive" OR "LTIP" OR "director shareholding" OR '
        '"PDMR shareholding" OR "chief executive pay")',
        75,
        "Listed-company disclosures state executive pay and shareholdings "
        "exactly, so no assumption is needed. A £1m+ package is a live income "
        "planning need even where liquid capital is modest.",
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
        "Every wealth event, with the main towns in each market folded into the "
        "queries, over the last month. The normal weekly run.",
        (), (30,), 6, 7, True,
    ),
    Depth(
        "deep", "Deep search",
        "Every event, every town in each market, over the last three months. The "
        "setting to use when you want the fullest list.",
        # One 90-day window rather than a 7-day and a 90-day pair: the wider
        # window already contains the narrower one, so the second pass mostly
        # re-read the same items and doubled the run time for little.
        (), (90,), 14, 7, True,
    ),
    Depth(
        "exhaustive", "Exhaustive",
        "Everything the app knows how to ask, over the last month and the last "
        "year. Builds a backlog on a first run; leave it going.",
        (), (30, 365), 24, 5, True,
    ),
)

DEPTH_BY_KEY: dict[str, Depth] = {d.key: d for d in DEPTHS}
#: Deep over the target-profile preset is about a quarter of an hour: the point
#: where an advisor who asked for quality over speed still gets a result the
#: same morning.
DEFAULT_DEPTH = "deep"


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


#: Google web search ignores every term after the 32nd, silently. Assumed to
#: hold for News as well: the cost of assuming it and being wrong is a few more
#: requests; the cost of ignoring it and being right is that half the queries
#: lose their tails — which, for the acquisition template, is the "founder OR
#: owner" clause that makes a result name a person.
QUERY_TERM_LIMIT = 32
#: Terms a place block may use, leaving room for the event phrase.
PLACE_TERM_BUDGET = 9


def count_terms(query: str) -> int:
    """Terms as Google counts them: words, including OR, excluding brackets."""
    return len(query.replace("(", " ").replace(")", " ").split())


def _group(alternatives: list[str] | tuple[str, ...]) -> str:
    joined = " OR ".join(alternatives)
    return f"({joined})" if len(alternatives) > 1 else joined


def place_blocks(
    market_key: str, *, places: int, block_size: int,
    term_budget: int = PLACE_TERM_BUDGET,
) -> list[str]:
    """Query fragments naming the market and, optionally, its towns.

    Towns are OR-ed together rather than searched one at a time. A single
    `("Devon" OR "Exeter" OR "Plymouth" OR "Torbay")` query finds everything four
    separate queries would, for a quarter of the requests. Blocks are packed by
    term count rather than place count, because "Weston-super-Mare" and "Bath"
    do not cost the same.
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
    current: list[str] = []
    for name in names:
        candidate = current + [f'"{name}"']
        if current and (
            len(candidate) > block_size or count_terms(_group(candidate)) > term_budget
        ):
            blocks.append(_group(current))
            current = [f'"{name}"']
        else:
            current = candidate
    if current:
        blocks.append(_group(current))
    return blocks


def template_groups(phrase: str) -> list[list[str]]:
    """A template phrase as its AND-ed groups, each a list of OR-ed alternatives."""
    groups = [
        [alt.strip() for alt in re.split(r"\s+OR\s+", body) if alt.strip()]
        for body in re.findall(r"\(([^()]*)\)", phrase)
    ]
    return groups or [[phrase.strip()]]


def fit_queries(block: str, phrase: str, *, limit: int = QUERY_TERM_LIMIT) -> list[str]:
    """Every alternative in the phrase, packed into queries that fit the limit.

    The largest OR-group is split across as many queries as it takes; the other
    groups — the constraints — are kept whole in every one, because dropping a
    constraint changes what the query means rather than just how much it asks.
    """
    groups = template_groups(phrase)
    split_at = max(range(len(groups)), key=lambda i: count_terms(_group(groups[i])))
    fixed = [g for i, g in enumerate(groups) if i != split_at]
    # One term for the when:Nd operator appended at request time.
    budget = (
        limit - 1 - count_terms(block)
        - sum(count_terms(_group(g)) for g in fixed)
    )

    chunks: list[list[str]] = []
    current: list[str] = []
    for alternative in groups[split_at]:
        candidate = current + [alternative]
        if current and count_terms(_group(candidate)) > budget:
            chunks.append(current)
            current = [alternative]
        else:
            current = candidate
    if current:
        chunks.append(current)

    queries = []
    for chunk in chunks:
        parts = [
            _group(chunk) if i == split_at else _group(groups[i])
            for i in range(len(groups))
        ]
        queries.append(f"{block} {' '.join(parts)}")
    return queries


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
                for query in fit_queries(block, template.phrase):
                    for window in windows:
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
    publishers_on = (
        settings.include_publishers if include_publishers is None else include_publishers
    )
    if publishers_on:
        count += len(DIRECT_FEEDS)
        count += len(build_site_sweeps(
            market_keys=market_keys, days=days or max(settings.windows)
        ))

    return Plan(
        queries=count,
        markets=len(expand_selection(market_keys)),
        events=len({q.event_key for q in matrix}),
        windows=len({q.window_days for q in matrix}),
        # One request per query plus the delay between them, and a little for
        # parsing and the database writes.
        seconds=count * (REQUEST_DELAY_SECONDS + 0.45),
    )


#: Publisher feeds read directly, for their standfirsts — Google News returns
#: headlines only, and a standfirst is where an owner's name and the adviser on a
#: deal usually appear. Only feeds whose address is confirmed are listed: every
#: guessed URL is a warning on every run, and a list of warnings trains people to
#: ignore warnings.
DIRECT_FEEDS: tuple[tuple[str, str], ...] = (
    ("BusinessLive", "https://www.business-live.co.uk/?service=rss"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("Sky News Business", "https://feeds.skynews.com/feeds/rss/business.xml"),
)

#: Kept under its old name for the parts of the app that count feeds.
PUBLISHER_FEEDS = DIRECT_FEEDS


@dataclass(frozen=True)
class SiteSweep:
    """A specialist publisher, reached through a site-scoped Google News search.

    For publishers whose feed address cannot be confirmed, this is strictly
    better than guessing one: it uses an endpoint already known to work, and it
    carries a market context, so a result that names no place still has one.
    """

    name: str
    domain: str
    phrase: str
    event_key: str


SITE_SWEEPS: tuple[SiteSweep, ...] = (
    SiteSweep(
        "Insider Media", "insidermedia.com",
        '(acquired OR "management buyout" OR sold OR "takes stake" OR exit)',
        "acquisition",
    ),
    SiteSweep(
        "Business Leader", "businessleader.co.uk",
        '(acquired OR sold OR exit OR buyout OR "sells stake")',
        "business_exit",
    ),
    SiteSweep(
        "Real Deals", "realdeals.eu.com",
        '(backs OR acquires OR exit OR buyout OR "secondary buyout")',
        "private_equity",
    ),
    # Land and estate sales — the wealth a deal-news sweep otherwise never sees,
    # and the category the brief singled out as under-covered.
    SiteSweep(
        "Farmers Weekly", "fwi.co.uk",
        '(farmland OR estate OR acres) (sold OR sale OR buyer OR "changed hands")',
        "land_sale",
    ),
)


def build_site_sweeps(
    *,
    market_keys: tuple[str, ...] | list[str] | None = None,
    days: int = 90,
) -> list[SearchQuery]:
    """One site-scoped search per specialist publisher per market."""
    queries: list[SearchQuery] = []
    for key in expand_selection(market_keys):
        market = MARKET_BY_KEY[key]
        block = place_blocks(key, places=0, block_size=1)[0]
        for sweep in SITE_SWEEPS:
            query = f"site:{sweep.domain} {block} {sweep.phrase}"
            queries.append(SearchQuery(
                market_key=key,
                market_name=market.name,
                event_key=sweep.event_key,
                query=query,
                url=google_news_url(query, days=days, market_key=key),
                window_days=days,
            ))
    return queries
