"""Reading wealth events out of news text.

Everything here is deliberately conservative. A false name in this system
becomes a wrong claim about a real, identifiable person, so the extractor would
rather find nothing than guess. Anything it does find is graded REPORTED — a
lead to verify, never evidence on its own.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import MODEL
from .queries import EVENT_BY_KEY
from .regions import resolve_region

# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------

_MONEY = re.compile(
    r"([£$€])\s?([\d,]+(?:\.\d+)?)\s?(bn|billion|m|million|k|thousand)?\b",
    re.IGNORECASE,
)

_UNIT_MULTIPLIER = {
    "bn": 1_000_000_000,
    "billion": 1_000_000_000,
    "m": 1_000_000,
    "million": 1_000_000,
    "k": 1_000,
    "thousand": 1_000,
}


def parse_money(text: str) -> int | None:
    """Largest credible GBP amount in the text.

    Headlines often carry several figures ("a £40m deal for the £8m-turnover
    firm"); the largest is usually the transaction value, which is what matters
    for a wealth estimate.
    """
    best: int | None = None
    for currency, digits, unit in _MONEY.findall(text):
        try:
            value = float(digits.replace(",", ""))
        except ValueError:
            continue
        multiplier = _UNIT_MULTIPLIER.get((unit or "").lower(), 1)
        amount = value * multiplier
        # A bare number under £10,000 with no unit is almost never a deal value;
        # it is a share price, a headcount or a date.
        if multiplier == 1 and amount < 10_000:
            continue
        gbp = int(round(amount * MODEL.fx_to_gbp.get(currency, 1.0)))
        if best is None or gbp > best:
            best = gbp
    return best


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

_TITLE_WORDS = (
    "founder", "co-founder", "chief executive", "chairman", "chairwoman",
    "chair", "managing director", "owner", "co-owner", "entrepreneur",
    "president", "chief financial officer", "finance director",
    "chief scientific officer", "chief technology officer",
    "chief operating officer", "chief investment officer",
    "proprietor", "managing partner", "senior partner", "founding partner",
    "partner", "shareholder", "director",
)
_TITLE_ACRONYMS = ("CEO", "CFO", "MD", "COO", "CTO", "CSO", "CIO")

#: Verbs that take a *person* as their object. "acquired by" is excluded on
#: purpose — that is nearly always another company.
_AGENT_VERBS = (
    "founded by", "co-founded by", "established by", "set up by", "created by",
    "registered by", "led by", "owned by", "started by", "launched by",
    "sold by", "built by",
)

_NAME = r"[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,2}"


def _case_insensitive(word: str) -> str:
    return "".join(
        f"[{c.lower()}{c.upper()}]" if c.isalpha() else re.escape(c) for c in word
    )


# Titles match either case; names must not, or `[A-Z][a-z]+` would swallow
# trailing lowercase words and turn "chairman Gareth Halberton has" into the
# name "Gareth Halberton has".
_TITLES = "|".join([*(_case_insensitive(w) for w in _TITLE_WORDS), *_TITLE_ACRONYMS])

_AGENT_ALTERNATION = "|".join(_case_insensitive(v) for v in _AGENT_VERBS)

_PERSON_PATTERNS = (
    re.compile(rf"({_NAME}),?\s+(?:the\s+)?(?:company\s+)?({_TITLES})\b"),
    re.compile(rf"\b({_TITLES})\s+({_NAME})\b"),
)

#: "…established by Alastair Wren" — a person named as the agent of a wealth
#: event, without an adjacent job title.
_AGENT_PATTERN = re.compile(rf"\b(?:{_AGENT_ALTERNATION})\s+({_NAME})\b")

#: Words that begin a phrase which looks like a name but is not.
_NAME_STOPWORDS = frozenset({
    "The", "A", "An", "This", "That", "New", "Business", "Company", "Group",
    "Limited", "Ltd", "Holdings", "Its", "His", "Her", "Their", "Our", "One",
    "Two", "Three", "Former", "Chief", "Managing", "Senior", "Deputy", "Vice",
    "North", "South", "East", "West", "Great", "Royal", "United", "British",
})

#: Publications and organisations that regularly appear in a name position.
_NOT_PEOPLE = frozenset({
    "Business Live", "Insider Media", "Companies House", "Rich List",
    "Sunday Times", "Financial Times", "Private Equity", "Family Office",
})


@dataclass(frozen=True)
class Person:
    name: str
    title: str


def _normalise_title(title: str) -> str:
    lower = title.lower()
    if lower in {"ceo", "chief executive"}:
        return "Chief Executive"
    if lower in {"cfo", "chief financial officer"}:
        return "Chief Financial Officer"
    if lower == "md":
        return "Managing Director"
    if lower == "coo":
        return "Chief Operating Officer"
    return " ".join(w.capitalize() for w in lower.split())


def extract_people(text: str) -> list[Person]:
    """Find "Name, title" or "title Name" attributions.

    Returns at most three, because an article naming more than that is usually
    a round-up rather than a story about one person.
    """
    found: list[Person] = []
    for index, pattern in enumerate(_PERSON_PATTERNS):
        for match in pattern.finditer(text):
            name = (match.group(1) if index == 0 else match.group(2)).strip()
            title = (match.group(2) if index == 0 else match.group(1)).strip()

            parts = name.split()
            if len(parts) < 2:
                continue
            if parts[0] in _NAME_STOPWORDS:
                continue
            if name in _NOT_PEOPLE:
                continue
            # A name where every word is a known non-name token is a false hit.
            if all(p in _NAME_STOPWORDS for p in parts):
                continue
            if any(p.name == name for p in found):
                continue
            found.append(Person(name=name, title=_normalise_title(title)))

    # Then people named as the agent of the event but without a nearby title.
    for match in _AGENT_PATTERN.finditer(text):
        name = match.group(1).strip()
        parts = name.split()
        if len(parts) < 2 or parts[0] in _NAME_STOPWORDS or name in _NOT_PEOPLE:
            continue
        if all(p in _NAME_STOPWORDS for p in parts):
            continue
        if any(p.name == name for p in found):
            continue
        # No title was stated, and guessing one would be inventing detail.
        found.append(Person(name=name, title=""))

    return found[:3]


# ---------------------------------------------------------------------------
# Companies
# ---------------------------------------------------------------------------

_COMPANY = re.compile(
    r"\b((?:[A-Z][\w&'’.-]*\s+){0,4}"
    r"(?:Ltd|Limited|PLC|plc|LLP|Group|Holdings|Partners|Technologies|Systems|Solutions))\b"
)


def extract_company(text: str) -> str | None:
    """Best-guess company name from a headline or standfirst."""
    for match in _COMPANY.finditer(text):
        candidate = " ".join(match.group(1).split()).strip(" .,")
        # A lone suffix ("Group") is not a company name.
        if len(candidate.split()) < 2:
            continue
        return candidate
    return None


# ---------------------------------------------------------------------------
# Event classification
# ---------------------------------------------------------------------------

#: Independent classifiers, so an article found by one query can still be
#: recognised as a different kind of event than the query that surfaced it.
_EVENT_SIGNATURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("business_exit", re.compile(
        r"\b(sells? (?:his|her|their|the) (?:stake|business|shareholding)|sold (?:his|her|their) stake"
        r"|completes? the sale|agreed the sale|sale of the business|exits? the business"
        r"|has sold|been sold|divests?)\b", re.I)),
    ("acquisition", re.compile(
        r"\b(acquired by|acquires|acquisition of|takeover|snapped up|bought by|merges? with)\b", re.I)),
    ("management_buyout", re.compile(
        r"\b(management buyout|MBO\b|employee ownership trust|EOT\b)", re.I)),
    ("ipo", re.compile(
        r"\b(IPO\b|initial public offering|floats? on|flotation|AIM listing|listing on the London)\b", re.I)),
    ("private_equity", re.compile(
        r"\b(private equity|growth capital|PE (?:firm|house|backer)|buyout (?:firm|house))\b", re.I)),
    ("venture_funding", re.compile(
        r"\b(series [a-e]\b|seed round|funding round|investment round|raises? £|secures? £)\b", re.I)),
    ("large_dividend", re.compile(
        r"\b(dividend|distribution to shareholders|paid out to shareholders)\b", re.I)),
    ("windfall", re.compile(r"\b(windfall|payout|cashes? in|nets £|pockets £)\b", re.I)),
    ("share_sale", re.compile(r"\b(sells? shares|share sale|offloads? shares|reduces? (?:his|her|their) stake)\b", re.I)),
    ("family_office", re.compile(r"\b(family office|family investment company)\b", re.I)),
    ("rich_list", re.compile(r"\b(rich list|wealth list|richest)\b", re.I)),
    ("property", re.compile(
        r"\b(buys?|bought|purchases?|acquires?)\b[^.]{0,40}\b(estate|manor|mansion|country house|property portfolio)\b", re.I)),
    ("succession", re.compile(r"\b(steps? down|retires?|hands over|succession plan)\b", re.I)),
    ("company_growth", re.compile(
        r"\b(turnover (?:rises?|rose|up)|revenue (?:jumps?|rises?|grew)|profits? (?:soar|jump|rise)|record (?:year|profits|results))\b", re.I)),
)


@dataclass
class ExtractedEvent:
    """One wealth event read out of one article."""

    event_key: str
    event_label: str
    weight: int
    region: str
    matched_place: str
    amount_gbp: int | None
    people: list[Person] = field(default_factory=list)
    company: str | None = None
    title: str = ""
    summary: str = ""
    url: str = ""
    publisher: str = ""
    published_at: datetime | None = None
    #: Why this article was accepted, for the audit trail.
    rationale: str = ""


def classify(text: str) -> list[str]:
    """All event types the text matches, strongest first."""
    hits = [key for key, pattern in _EVENT_SIGNATURES if pattern.search(text)]
    return sorted(hits, key=lambda k: EVENT_BY_KEY[k].weight if k in EVENT_BY_KEY else 0, reverse=True)


def extract_event(
    *,
    title: str,
    summary: str,
    url: str,
    publisher: str,
    published_at: datetime | None,
    query_event_key: str | None = None,
) -> ExtractedEvent | None:
    """Turn an article into a wealth event, or reject it.

    Rejection reasons, all deliberate:
      * no in-scope county could be resolved
      * no recognised wealth event in the text
    """
    text = f"{title}. {summary}".strip()
    if not text:
        return None

    region, place = resolve_region(text)
    if not region:
        return None

    matched = classify(text)
    # Fall back to the query that surfaced it, but only if the text is at least
    # consistent with it — otherwise we would tag an article with an event it
    # never mentions.
    event_key = matched[0] if matched else (query_event_key if query_event_key else None)
    if not event_key:
        return None

    template = EVENT_BY_KEY.get(event_key)
    if template is None:
        return None

    amount = parse_money(text)
    people = extract_people(text)
    company = extract_company(text)

    reasons = [f"Matched a {template.label.lower()} pattern"]
    if place:
        reasons.append(f"located in {region} via “{place}”")
    if amount:
        reasons.append(f"reported value {amount:,} GBP")
    if people:
        reasons.append(f"named {', '.join(p.name for p in people)}")
    if not people:
        reasons.append("no individual named, so this is a company-level lead only")

    return ExtractedEvent(
        event_key=event_key,
        event_label=template.label,
        weight=template.weight,
        region=region,
        matched_place=place or region,
        amount_gbp=amount,
        people=people,
        company=company,
        title=title.strip(),
        summary=summary.strip()[:600],
        url=url,
        publisher=publisher,
        published_at=published_at or datetime.now(timezone.utc),
        rationale="; ".join(reasons) + ".",
    )
