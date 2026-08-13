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
    #: The registered office, formatted as one line. A real, verifiable address —
    #: not the individual's home, and it must never be presented as one.
    registered_office: str | None = None
    company_status: str | None = None
    incorporated_on: str | None = None
    #: Where the person appears in the filings: 'psc', 'officer', or None.
    matched_via: str | None = None


def companies_house_available() -> bool:
    return bool(COMPANIES_HOUSE_API_KEY)


def _auth() -> tuple[str, str]:
    """HTTP Basic with the key as the username and an empty password.

    This is the whole of Companies House authentication, and the most common
    reason a key appears not to work is sending it as a Bearer token instead.
    """
    return (COMPANIES_HOUSE_API_KEY, "")


def _format_address(address: dict | None) -> str | None:
    if not address:
        return None
    parts = [
        address.get("premises"),
        address.get("address_line_1"),
        address.get("address_line_2"),
        address.get("locality"),
        address.get("region"),
        address.get("postal_code"),
        address.get("country"),
    ]
    joined = ", ".join(str(p).strip() for p in parts if p and str(p).strip())
    return joined or None


def companies_house_status(fetcher: Fetcher | None = None) -> tuple[bool, str]:
    """Is the key live? Returns ``(ok, human explanation)``.

    Worth doing as its own check: "no key", "wrong kind of key" and "the register
    is down" need three different actions, and a single "verification off"
    message hides which one you are looking at.
    """
    if not COMPANIES_HOUSE_API_KEY:
        return False, (
            "No API key set. Companies House verification is a bonus, not a "
            "requirement — set COMPANIES_HOUSE_API_KEY to switch it on."
        )

    client = fetcher or Fetcher()
    try:
        response = client.get(
            f"{COMPANIES_HOUSE_BASE}/search/companies",
            params={"q": "test", "items_per_page": 1},
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
    except requests.RequestException as error:
        return False, f"Could not reach Companies House: {type(error).__name__} — {error}"

    if response is None:
        return False, "Companies House did not respond."
    if response.status_code in (401, 403):
        return False, (
            f"Companies House rejected the key (HTTP {response.status_code}). It must be "
            "a REST API key from a *live* application, sent as the HTTP Basic username. "
            "A streaming key or a test-sandbox key will fail exactly like this."
        )
    if response.status_code == 429:
        return False, "Rate limited (HTTP 429). The key works; the register is throttling us."
    if response.status_code != 200:
        return False, f"Companies House returned HTTP {response.status_code}."
    return True, "Connected. Shareholdings will be checked against the PSC register."


def _company_profile(fetcher: Fetcher, number: str) -> dict:
    """Registered office and status for a company number, or an empty dict."""
    try:
        response = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/company/{number}",
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
    except requests.RequestException:
        return {}
    if response is None or response.status_code != 200:
        return {}
    try:
        return response.json() or {}
    except ValueError:
        return {}


def _pick_company(items: list[dict], company_name: str) -> dict | None:
    """Choose the closest name match, preferring companies that still trade.

    The register's own relevance ranking will happily return a dissolved
    namesake, and attaching a wrong company number to a person is a factual
    error about a real individual.
    """
    if not items:
        return None
    wanted = {w for w in re.findall(r"[a-z0-9]+", company_name.lower()) if len(w) > 2}

    def score(item: dict) -> tuple[int, int]:
        title = (item.get("title") or "").lower()
        words = {w for w in re.findall(r"[a-z0-9]+", title) if len(w) > 2}
        overlap = len(wanted & words)
        active = 1 if (item.get("company_status") == "active") else 0
        return (overlap, active)

    best = max(items, key=score)
    # No meaningful word in common means this is a different company.
    return best if score(best)[0] >= 1 else None


def verify_with_companies_house(
    fetcher: Fetcher, *, company_name: str | None, person_name: str | None
) -> tuple[CompaniesHouseMatch | None, str | None]:
    """Look up a company and, if possible, confirm the person's shareholding.

    Entirely optional. When no key is configured this returns ``(None, reason)``
    and the prospect simply keeps its assumed stake, clearly labelled as assumed.

    Three things are attempted, in descending order of value:

      1. the PSC register, which turns an assumed stake into a filed band;
      2. the officers list, which confirms the person is really attached to the
         company even when they hold under 25%;
      3. the registered office, which gives a real address to work from.
    """
    if not COMPANIES_HOUSE_API_KEY:
        return None, "No Companies House key configured — shareholding remains an assumption."
    if not company_name:
        return None, "No company name was extracted, so there is nothing to look up."

    try:
        search = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/search/companies",
            params={"q": company_name, "items_per_page": 10},
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
        if search is None:
            return None, "Companies House did not respond."
        if search.status_code in (401, 403):
            return None, (
                f"Companies House rejected the key (HTTP {search.status_code}). It must be a "
                "REST API key from a live application, sent as the HTTP Basic username."
            )
        if search.status_code != 200:
            return None, f"Companies House search returned HTTP {search.status_code}."

        best = _pick_company(search.json().get("items") or [], company_name)
        if best is None:
            return None, f"No company on the register matched “{company_name}”."

        number = str(best.get("company_number"))
        profile = _company_profile(fetcher, number)
        match = CompaniesHouseMatch(
            company_number=number,
            company_name=profile.get("company_name") or best.get("title") or company_name,
            officer_name=None,
            ownership_band=None,
            profile_url=(
                "https://find-and-update.company-information.service.gov.uk/company/" + number
            ),
            registered_office=_format_address(
                profile.get("registered_office_address") or best.get("address")
            ),
            company_status=profile.get("company_status") or best.get("company_status"),
            incorporated_on=profile.get("date_of_creation"),
        )

        if not person_name:
            return match, None

        surname = person_name.split()[-1].lower()

        psc = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/company/{number}/persons-with-significant-control",
            params={"items_per_page": 50},
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
        # 404 is the register's way of saying "this company has filed no PSC
        # statements", which is information, not an error.
        if psc is not None and psc.status_code == 200:
            for entry in psc.json().get("items") or []:
                if entry.get("ceased_on"):
                    continue
                name = (entry.get("name") or "").lower()
                if surname and surname in name:
                    natures = " ".join(entry.get("natures_of_control") or [])
                    match.officer_name = entry.get("name")
                    match.ownership_band = next(
                        (label for pattern, label in _OWNERSHIP_BANDS
                         if re.search(pattern, natures)),
                        None,
                    )
                    match.matched_via = "psc"
                    return match, None

        # Not a PSC. They may still be an officer, which confirms the connection
        # without evidencing a shareholding — a materially weaker claim, recorded
        # as such rather than as verification of the stake.
        officers = fetcher.get(
            f"{COMPANIES_HOUSE_BASE}/company/{number}/officers",
            params={"items_per_page": 50},
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
        if officers is not None and officers.status_code == 200:
            for entry in officers.json().get("items") or []:
                if entry.get("resigned_on"):
                    continue
                name = (entry.get("name") or "").lower()
                if surname and surname in name:
                    match.officer_name = entry.get("name")
                    match.matched_via = "officer"
                    return match, (
                        f"“{person_name}” is a filed officer of {match.company_name} but not a "
                        f"person with significant control. The appointment is confirmed; the "
                        f"shareholding is not, and remains an assumption."
                    )

        return match, (
            f"{match.company_name} was found on the register, but “{person_name}” appears "
            f"neither as a person with significant control nor as a current officer. They "
            f"may hold under 25%, hold through another entity, or the name match may be wrong."
        )
    except requests.RequestException as error:
        return None, f"Companies House unreachable: {error}"
    except (ValueError, KeyError) as error:
        return None, f"Unexpected Companies House response: {error}"
