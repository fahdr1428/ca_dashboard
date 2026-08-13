"""Who is *not* a prospect, and which sources are never acceptable.

A prospecting tool is judged as much by what it keeps out as by what it finds.
Three kinds of record are actively harmful to an advisor's day:

  * **Celebrity wealth.** A footballer, actor or broadcaster with a reported net
    worth is not a realistic introduction. They are already served by people who
    reached them through a network, their public profile makes cold outreach
    obviously unworkable, and the reported figures are usually aggregator
    guesswork. Every one of them in the list costs the advisor the time it takes
    to work out why they are useless.

  * **Mega-wealth.** The top of a national rich list is not addressable by a
    regional private-client firm. A £19bn industrialist and a £12m second-
    generation family-business owner are different products; only one of them is
    this one.

  * **Aggregator "net worth" sites.** Celebrity Net Worth and its imitators
    publish numbers with no method, no filing behind them and no correction
    process. They are not weak evidence — they are not evidence, and a record
    that rests on one should not exist.

Every exclusion is recorded with its reason rather than silently dropped, so the
book can show what it rejected and why. A screening rule you cannot inspect is
indistinguishable from a bug.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Sources that are never acceptable
# ---------------------------------------------------------------------------

#: Domains publishing "estimated net worth" with no stated method. Not ranked
#: low — refused outright, for anyone.
BANNED_SOURCE_DOMAINS: frozenset[str] = frozenset({
    "celebritynetworth.com",
    "networthspot.com",
    "idolnetworth.com",
    "wealthygorilla.com",
    "celebsnetworthtoday.com",
    "networthlist.org",
    "thefamousnaija.com",
    "networthpost.org",
    "celebritynetworth.wiki",
    "networthroll.com",
    "allfamousbirthday.com",
    "famousbirthdays.com",
    "networthbro.com",
    "starsunfolded.com",
    "networthstats.com",
    "richestnetworths.com",
    "networthdaily.com",
})


def banned_source(url: str | None) -> str | None:
    """The banned domain a URL belongs to, or None.

    Subdomains count: `www.celebritynetworth.com` and `uk.celebritynetworth.com`
    are the same publisher.
    """
    if not url:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    if not host:
        return None
    for domain in BANNED_SOURCE_DOMAINS:
        if host == domain or host.endswith("." + domain):
            return domain
    return None


# ---------------------------------------------------------------------------
# Occupations that are not realistic introductions
# ---------------------------------------------------------------------------

#: Matched against the article text and the person's stated role. Deliberately
#: phrase-based rather than word-based: "director" appears in both "film
#: director" and "managing director", and only one of them is an exclusion.
_CELEBRITY_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("professional sport", re.compile(
        r"\b(footballer|premier league|england (?:captain|international)|"
        r"formula\s?1|f1 driver|grand prix winner|olympian|olympic (?:gold|medall?ist)|"
        r"test cricketer|county cricketer|rugby (?:international|union player|league player)|"
        r"golfer|tennis (?:player|champion)|boxer|heavyweight champion|"
        r"jockey|racing driver|athlete|sprinter|striker for|midfielder|"
        r"signed for [A-Z]|transfer fee|testimonial match|"
        r"manchester united|liverpool fc|arsenal fc|chelsea fc|tottenham hotspur)\b", re.I)),
    ("entertainment", re.compile(
        r"\b(actor|actress|film star|hollywood|movie star|starred in|"
        r"singer|songwriter|musician|rapper|dj\b|band frontman|lead singer|"
        r"album (?:sales|release)|chart-topping|tour dates|"
        r"comedian|stand-?up|film director|screenwriter|"
        r"reality (?:tv|star)|love island|strictly come dancing|"
        r"influencer|youtuber|tiktok star|onlyfans)\b", re.I)),
    ("broadcasting", re.compile(
        r"\b(broadcaster|tv presenter|television presenter|radio presenter|"
        r"news anchor|newsreader|chat show host|bbc presenter|itv presenter|"
        r"sports pundit|commentator for)\b", re.I)),
)

#: Roles that read like a title but mark an entertainment career.
EXCLUDED_TITLES: frozenset[str] = frozenset({
    "actor", "actress", "singer", "musician", "rapper", "comedian",
    "presenter", "broadcaster", "footballer", "athlete", "jockey", "boxer",
    "golfer", "dj", "influencer", "youtuber", "model",
})


# ---------------------------------------------------------------------------
# Wealth tiers that are out of scope at the top as well as the bottom
# ---------------------------------------------------------------------------

#: Above this, a person is a national rich-list name rather than a regional
#: private-client prospect. Set on *gross* estimated wealth, because that is what
#: rich lists quote.
MEGA_WEALTH_CEILING_GBP = 250_000_000


@dataclass(frozen=True)
class Exclusion:
    """Why a candidate was refused. Recorded, never silently dropped."""

    rule: str
    reason: str


def screen(
    *,
    text: str,
    person_name: str | None = None,
    job_title: str | None = None,
    url: str | None = None,
    gross_wealth_gbp: int | None = None,
) -> Exclusion | None:
    """Should this candidate be kept out of the book? Returns why, or None.

    Applied at extraction time, before a record is ever created — a prospect
    that exists and is then hidden still appears in exports, totals and
    yesterday's screenshots.
    """
    domain = banned_source(url)
    if domain:
        return Exclusion(
            "banned-source",
            f"“{domain}” publishes estimated net worth with no stated method and no "
            f"filing behind it. It is not weak evidence, it is not evidence, so no "
            f"record is created from it for anyone.",
        )

    if job_title and job_title.strip().lower() in EXCLUDED_TITLES:
        return Exclusion(
            "celebrity",
            f"Stated role is “{job_title}”. Entertainment, sport and broadcasting "
            f"wealth is excluded: not a realistic introduction, and already served.",
        )

    for label, pattern in _CELEBRITY_PATTERNS:
        match = pattern.search(text or "")
        if match:
            return Exclusion(
                "celebrity",
                f"The source is about {label} (“{match.group(0)}”). Entertainment, "
                f"sport and broadcasting wealth is excluded: a public profile makes "
                f"cold outreach unworkable and these prospects are already served.",
            )

    if gross_wealth_gbp is not None and gross_wealth_gbp > MEGA_WEALTH_CEILING_GBP:
        return Exclusion(
            "mega-wealth",
            f"Estimated gross wealth of £{gross_wealth_gbp / 1_000_000:.0f}m is above the "
            f"£{MEGA_WEALTH_CEILING_GBP / 1_000_000:.0f}m ceiling. National rich-list "
            f"names are not addressable by a regional private-client firm; the target is "
            f"owner-managers and family businesses who are not household names.",
        )

    return None
