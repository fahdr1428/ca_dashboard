"""Fetching and parsing public sources.

Three sources, in descending order of what they can tell you:

  1. Google News RSS search — the discovery engine. No API key, indexes
     thousands of publishers, and takes targeted queries. This is what finds
     people the advisor has never heard of.
  2. Regional publisher RSS — deal news that never reaches national
     aggregation, swept broadly.
  3. Companies House — optional. Turns an assumed shareholding into a filed one.
     A bonus verification step, not a dependency.

Only publisher-provided feeds are read. No article bodies are scraped, no
paywalls circumvented, and the client identifies itself honestly so publishers
can block it if they wish.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, parse_qs

import requests

from .config import (
    COMPANIES_HOUSE_API_KEY,
    COMPANIES_HOUSE_BASE,
    MAX_RETRIES,
    REQUEST_DELAY_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    USER_AGENT,
)


@dataclass
class Article:
    title: str
    url: str
    summary: str
    publisher: str
    published_at: datetime | None


class Fetcher:
    """Polite HTTP client: one session, a delay between calls, bounded retries."""

    def __init__(self, delay: float = REQUEST_DELAY_SECONDS) -> None:
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        })
        self.delay = delay
        self._last_call = 0.0
        self.request_count = 0

    def get(self, url: str, **kwargs) -> requests.Response | None:
        elapsed = time.monotonic() - self._last_call
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)

        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                self.request_count += 1
                self._last_call = time.monotonic()
                response = self.session.get(url, timeout=REQUEST_TIMEOUT_SECONDS, **kwargs)
                if response.status_code == 429:
                    time.sleep(2 ** (attempt + 1))
                    continue
                if response.status_code >= 500:
                    time.sleep(1.5 ** (attempt + 1))
                    continue
                return response
            except requests.RequestException as error:
                last_error = error
                time.sleep(1.5 ** (attempt + 1))
        if last_error:
            raise last_error
        return None


# ---------------------------------------------------------------------------
# RSS / Atom parsing
# ---------------------------------------------------------------------------

_ITEM = re.compile(r"<(item|entry)\b[\s\S]*?</\1>", re.IGNORECASE)
_CDATA = re.compile(r"<!\[CDATA\[([\s\S]*?)\]\]>")
_TAGS = re.compile(r"<[^>]+>")

_ENTITIES = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&#160;": " ",
    "&pound;": "£", "&#163;": "£", "&euro;": "€", "&hellip;": "…",
    "&mdash;": "—", "&ndash;": "–", "&rsquo;": "’", "&lsquo;": "‘",
}


def _decode(text: str) -> str:
    for entity, char in _ENTITIES.items():
        text = text.replace(entity, char)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    return text


def _tag(block: str, name: str) -> str:
    match = re.search(rf"<{name}[^>]*>([\s\S]*?)</{name}>", block, re.IGNORECASE)
    if not match:
        return ""
    inner = _CDATA.sub(r"\1", match.group(1))
    return _decode(_TAGS.sub(" ", inner)).strip()


def _parse_date(text: str) -> datetime | None:
    if not text:
        return None
    try:
        parsed = parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text.strip(), fmt)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _unwrap_google_url(url: str) -> str:
    """Google News wraps publisher links. Recover the original where possible."""
    if "news.google.com" not in url:
        return url
    query = parse_qs(urlparse(url).query)
    return query.get("url", [url])[0]


def parse_feed(xml: str, *, default_publisher: str = "") -> list[Article]:
    """Read RSS or Atom into articles. Deliberately dependency-free."""
    articles: list[Article] = []
    for match in _ITEM.finditer(xml):
        block = match.group(0)

        title = _tag(block, "title")
        link = _tag(block, "link")
        if not link:
            href = re.search(r"<link[^>]*href=[\"']([^\"']+)[\"']", block, re.IGNORECASE)
            link = href.group(1) if href else ""
        if not title or not link:
            continue

        summary = _tag(block, "description") or _tag(block, "summary") or _tag(block, "content")
        # Google News puts the publisher in a <source> element.
        publisher = _tag(block, "source") or default_publisher
        published = _parse_date(
            _tag(block, "pubDate") or _tag(block, "published") or _tag(block, "updated")
        )

        articles.append(Article(
            title=title,
            url=_unwrap_google_url(link.strip()),
            summary=summary,
            publisher=publisher.strip() or default_publisher,
            published_at=published,
        ))
    return articles


def fetch_feed(fetcher: Fetcher, url: str, *, publisher: str = "") -> tuple[list[Article], str | None]:
    """Fetch and parse one feed. Returns ``(articles, warning)``."""
    try:
        response = fetcher.get(url)
    except requests.RequestException as error:
        return [], f"{publisher or url}: {type(error).__name__} — {error}"
    if response is None:
        return [], f"{publisher or url}: no response"
    if response.status_code != 200:
        return [], f"{publisher or url}: HTTP {response.status_code}"
    return parse_feed(response.text, default_publisher=publisher), None


# ---------------------------------------------------------------------------
# Companies House — optional verification bonus
# ---------------------------------------------------------------------------

_OWNERSHIP_BANDS = (
    (r"(ownership-of-shares|voting-rights)-75-to-100-percent", "75–100%"),
    (r"(ownership-of-shares|voting-rights)-50-to-75-percent", "50–75%"),
    (r"(ownership-of-shares|voting-rights)-25-to-50-percent", "25–50%"),
)


@dataclass
class CompaniesHouseMatch:
    company_number: str
    company_name: str
    officer_name: str | None
    ownership_band: str | None
    profile_url: str


def companies_house_available() -> bool:
    return bool(COMPANIES_HOUSE_API_KEY)


def verify_with_companies_house(
    fetcher: Fetcher, *, company_name: str, person_name: str | None
) -> tuple[CompaniesHouseMatch | None, str | None]:
    """Look up a company and, if possible, confirm the person's shareholding.

    Entirely optional. When no key is configured this returns ``(None, reason)``
    and the prospect simply keeps its assumed stake, clearly labelled as assumed.
    """
    if not COMPANIES_HOUSE_API_KEY:
        return None, "No Companies House key configured — shareholding remains an assumption."

    auth = (COMPANIES_HOUSE_API_KEY, "")
    try:
        search = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/search/companies",
            params={"q": company_name, "items_per_page": 5},
            auth=auth,
            headers={"Accept": "application/json"},
        )
        if search is None or search.status_code == 401 or search.status_code == 403:
            return None, "Companies House rejected the key (401/403). Check it is a REST API key."
        if search.status_code != 200:
            return None, f"Companies House search returned HTTP {search.status_code}."

        items = search.json().get("items") or []
        if not items:
            return None, f"No company on the register matched “{company_name}”."

        best = items[0]
        number = best.get("company_number")
        profile_url = (
            "https://find-and-update.company-information.service.gov.uk/company/" + str(number)
        )
        match = CompaniesHouseMatch(
            company_number=str(number),
            company_name=best.get("title") or company_name,
            officer_name=None,
            ownership_band=None,
            profile_url=profile_url,
        )

        if not person_name:
            return match, None

        psc = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/company/{number}/persons-with-significant-control",
            params={"items_per_page": 50},
            auth=auth,
            headers={"Accept": "application/json"},
        )
        if psc is None or psc.status_code != 200:
            return match, "Company found, but the PSC register could not be read."

        surname = person_name.split()[-1].lower()
        for entry in psc.json().get("items") or []:
            if entry.get("ceased_on"):
                continue
            name = (entry.get("name") or "").lower()
            if surname and surname in name:
                natures = " ".join(entry.get("natures_of_control") or [])
                band = next(
                    (label for pattern, label in _OWNERSHIP_BANDS if re.search(pattern, natures)),
                    None,
                )
                match.officer_name = entry.get("name")
                match.ownership_band = band
                return match, None

        return match, (
            f"Company found on the register, but “{person_name}” does not appear as a "
            f"person with significant control. They may hold under 25%, or hold through "
            f"another entity."
        )
    except requests.RequestException as error:
        return None, f"Companies House unreachable: {error}"
    except (ValueError, KeyError) as error:
        return None, f"Unexpected Companies House response: {error}"
