"""Evidence grading: how *direct* is the source behind a record?

Separate from the numeric confidence score, and deliberately so. The score
answers "how much of this record is evidenced" across several dimensions and
comes out as a number. This answers a blunter question an advisor asks first:

    Am I reading a filing, or am I reading a journalist's estimate?

A statutory filing and a rich-list mention can produce identical-looking numbers
on a screen. Grading the source directness keeps them distinguishable:

  * **High** — a document the subject or their company was legally obliged to
    file: the PSC register, a confirmation statement, filed accounts, a listed
    company's annual report or RNS, a Land Registry title.
  * **Medium** — competent trade or business press reporting a transaction.
    Usually right about *that a deal happened*, frequently wrong about who got
    what share of it.
  * **Low** — inclusion on a rich list with no published breakdown. Tells you
    someone is wealthy; tells you nothing about how, or how liquid.

A record inherits the grade of its *strongest* source, because one filing beats
any amount of commentary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

HIGH, MEDIUM, LOW = "High", "Medium", "Low"

#: Grades in descending strength, so "strongest wins" is a min() on the index.
GRADE_ORDER = (HIGH, MEDIUM, LOW)


@dataclass(frozen=True)
class SourceTier:
    key: str
    label: str
    grade: str
    #: What this kind of source can and cannot establish.
    meaning: str


TIERS: tuple[SourceTier, ...] = (
    SourceTier(
        "companies_house", "Companies House filing", HIGH,
        "A statutory filing: the PSC register, a confirmation statement, a "
        "director appointment or filed accounts. Establishes ownership bands, "
        "appointments and company financials as fact rather than inference.",
    ),
    SourceTier(
        "annual_report", "Annual report or RNS", HIGH,
        "A listed company's own disclosure. Executive remuneration and director "
        "shareholdings are stated exactly, not estimated.",
    ),
    SourceTier(
        "land_registry", "Land Registry or estate record", HIGH,
        "Registered title or a filed agricultural/estate business record. "
        "Establishes holdings; rarely establishes their value.",
    ),
    SourceTier(
        "trade_press", "Trade or business press", MEDIUM,
        "Competent reporting of a transaction. Usually right that a deal "
        "happened and roughly what it was worth; almost never states what share "
        "reached a named individual.",
    ),
    SourceTier(
        "rich_list", "Rich list", LOW,
        "Inclusion on a published wealth ranking with no breakdown. Indicates "
        "wealth without evidencing its source, size or liquidity. A starting "
        "point for research, never a figure to quote.",
    ),
    SourceTier(
        "other", "Other public reporting", MEDIUM,
        "General news coverage from a publisher not on the known-reliable list. "
        "Treated as press reporting: usually right that something happened, "
        "unreliable on who received what.",
    ),
)

TIER_BY_KEY: dict[str, SourceTier] = {t.key: t for t in TIERS}

#: Order the brief asks research to work in, strongest first.
PREFERRED_ORDER: tuple[str, ...] = (
    "companies_house", "rich_list", "annual_report", "trade_press", "land_registry",
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("companies_house", re.compile(
        r"(company-information\.service\.gov\.uk|companies\s?house|"
        r"psc register|persons with significant control|confirmation statement|"
        r"filed accounts|director appointment)", re.I)),
    ("annual_report", re.compile(
        r"(londonstockexchange\.com|rns-?pdf|investegate|"
        r"annual report|remuneration report|regulatory news service|\bRNS\b|"
        r"\bTR-1\b|director/pdmr shareholding)", re.I)),
    ("land_registry", re.compile(
        r"(land\s?registry|gov\.uk/search-property-information|"
        r"title register|rural payments agency|agricultural holding|"
        r"estate records)", re.I)),
    ("rich_list", re.compile(
        r"(rich list|wealth list|richest|wealthiest|billionaires? (?:list|index)|"
        r"sunday times rich)", re.I)),
    ("trade_press", re.compile(
        r"(insidermedia|insider media|business-?live|businessleader|business leader|"
        r"thebusinessmagazine|the business magazine|bdaily|uktech|uktn|"
        r"financial times|ft\.com|reuters|bloomberg|city a\.?m|"
        r"private equity wire|growth business)", re.I)),
)


def classify_source(*, url: str | None = None, publisher: str | None = None,
                    title: str | None = None) -> SourceTier:
    """Which tier a citation belongs to. Falls back to general reporting."""
    haystack = " ".join(part for part in (url, publisher, title) if part)
    for key, pattern in _PATTERNS:
        if pattern.search(haystack):
            return TIER_BY_KEY[key]
    return TIER_BY_KEY["other"]


def strongest(grades: list[str] | tuple[str, ...]) -> str:
    """The best grade on a record. One filing beats any amount of commentary."""
    present = [g for g in grades if g in GRADE_ORDER]
    if not present:
        return LOW
    return min(present, key=GRADE_ORDER.index)


def grade_record(sources: list[dict]) -> tuple[str, str]:
    """``(grade, plain-English justification)`` for a set of citations."""
    if not sources:
        return LOW, "No sources on file."

    tiers = [
        classify_source(
            url=source.get("url"),
            publisher=source.get("publisher"),
            title=source.get("title"),
        )
        for source in sources
    ]
    grade = strongest([t.grade for t in tiers])
    best = next(t for t in tiers if t.grade == grade)
    others = len(sources) - 1
    tail = f" ({others} further source{'' if others == 1 else 's'} on file.)" if others else ""
    return grade, f"Strongest source is a {best.label.lower()}. {best.meaning}{tail}"
