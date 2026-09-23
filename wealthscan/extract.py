"""Reading wealth events out of news text.

Two principles pull against each other here, and both matter:

  * **Yield.** A search that finds a genuine £64m business sale naming its owner
    is worthless if the pipeline then discards it. The original version resolved
    geography only from the article text, so a Devon query returning a perfect
    Devon story got thrown away whenever the 200-character snippet didn't repeat
    the word "Devon". That threw away most of everything.

  * **Never inventing people.** A false name becomes a wrong claim about a real,
    identifiable individual. So the extractor is generous about *patterns* and
    strict about *evidence*: it recognises many ways a person can be named, and
    rejects anything that looks like a place, a publication or a company.

Where the geography comes from the search rather than the text, that is recorded
as `market_source="query"` and the confidence model marks it down accordingly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .markets import (
    MARKET_BY_KEY,
    MarketMatch,
    most_specific_place,
    resolve_market,
)
from .queries import EVENT_BY_KEY

# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------

#: Currency symbols and ISO codes seen in the markets we search.
_CURRENCY_PATTERN = (
    r"(?:£|\$|€|¥|₹|GBP|USD|EUR|AED|SAR|QAR|KWD|BHD|OMR|CHF|SGD|HKD|AUD|NZD|"
    r"CAD|JPY|INR|SEK|NOK|DKK|ZAR|ILS|TRY|Dh|Dhs|SR|RM)"
)

_MONEY = re.compile(
    rf"({_CURRENCY_PATTERN})\s?([\d,]+(?:\.\d+)?)\s?"
    r"(bn|billion|m|mn|million|k|thousand|cr|crore|lakh|trillion)?\b",
    re.IGNORECASE,
)
#: "40 million pounds", "2 billion dirhams" — amount before the currency word.
_MONEY_TRAILING = re.compile(
    r"\b([\d,]+(?:\.\d+)?)\s?(bn|billion|m|mn|million|k|thousand|trillion)?\s?"
    r"(pounds?|dollars?|euros?|dirhams?|riyals?|francs?|rupees?|yen|shekels?)\b",
    re.IGNORECASE,
)

_UNIT = {
    "trillion": 1_000_000_000_000,
    "bn": 1_000_000_000, "billion": 1_000_000_000,
    "m": 1_000_000, "mn": 1_000_000, "million": 1_000_000,
    "cr": 10_000_000, "crore": 10_000_000,  # Indian numbering
    "lakh": 100_000,
    "k": 1_000, "thousand": 1_000,
}

#: Rough FX to GBP. Directional only — used so a headline in dirhams doesn't
#: overstate a prospect by a factor of five.
_FX_TO_GBP = {
    "£": 1.0, "gbp": 1.0, "pound": 1.0, "pounds": 1.0,
    "$": 0.78, "usd": 0.78, "dollar": 0.78, "dollars": 0.78,
    "€": 0.85, "eur": 0.85, "euro": 0.85, "euros": 0.85,
    "aed": 0.21, "dh": 0.21, "dhs": 0.21, "dirham": 0.21, "dirhams": 0.21,
    "sar": 0.21, "sr": 0.21, "riyal": 0.21, "riyals": 0.21,
    "qar": 0.21, "kwd": 2.55, "bhd": 2.07, "omr": 2.03,
    "chf": 0.88, "franc": 0.88, "francs": 0.88,
    "sgd": 0.58, "hkd": 0.10, "aud": 0.52, "nzd": 0.48, "cad": 0.57,
    "¥": 0.0052, "jpy": 0.0052, "yen": 0.0052,
    "₹": 0.0094, "inr": 0.0094, "rupee": 0.0094, "rupees": 0.0094,
    "sek": 0.074, "nok": 0.072, "dkk": 0.114, "zar": 0.042,
    "ils": 0.21, "shekel": 0.21, "shekels": 0.21, "try": 0.023, "rm": 0.17,
}


def _to_gbp(raw_currency: str, amount: float) -> int:
    rate = _FX_TO_GBP.get(raw_currency.lower().strip(), 1.0)
    return int(round(amount * rate))


def parse_money(text: str) -> int | None:
    """Largest credible amount in the text, converted to GBP.

    Headlines carry several figures ("a £40m deal for the £8m-turnover firm");
    the largest is usually the transaction value, which is what a wealth
    estimate needs.
    """
    best: int | None = None

    for currency, digits, unit in _MONEY.findall(text):
        try:
            value = float(digits.replace(",", ""))
        except ValueError:
            continue
        multiplier = _UNIT.get((unit or "").lower(), 1)
        # A bare figure under 10,000 with no unit is a share price, a headcount
        # or a year — not a deal value.
        if multiplier == 1 and value < 10_000:
            continue
        gbp = _to_gbp(currency, value * multiplier)
        if best is None or gbp > best:
            best = gbp

    for digits, unit, word in _MONEY_TRAILING.findall(text):
        try:
            value = float(digits.replace(",", ""))
        except ValueError:
            continue
        multiplier = _UNIT.get((unit or "").lower(), 1)
        if multiplier == 1 and value < 10_000:
            continue
        gbp = _to_gbp(word, value * multiplier)
        if best is None or gbp > best:
            best = gbp

    return best


# ---------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------

_TITLE_WORDS = (
    "founder", "co-founder", "cofounder", "chief executive", "chairman",
    "chairwoman", "chairperson", "chair", "managing director", "owner",
    "co-owner", "entrepreneur", "president", "vice president",
    "chief financial officer", "finance director", "chief scientific officer",
    "chief technology officer", "chief operating officer",
    "chief investment officer", "chief commercial officer",
    "proprietor", "managing partner", "senior partner", "founding partner",
    "general partner", "partner", "shareholder", "investor", "director",
    "group chief executive", "executive chairman", "non-executive chairman",
    "billionaire", "millionaire", "tycoon", "magnate", "heiress", "heir",
    "boss", "co-chief executive",
    # Land and estate wealth. Without these the whole category yields companies
    # and no people, which is the same as not searching for it.
    "landowner", "land owner", "estate owner", "farmer", "farm owner",
    "landlord", "estate manager", "trustee",
    # Plurals. "Co-founders Alice Marchmont and Ruth Pelling" is one of the
    # commonest ways two prospects appear in a single sentence, and the singular
    # forms miss it entirely because of the trailing "s".
    "founders", "co-founders", "cofounders", "owners", "co-owners", "directors",
    "shareholders", "brothers", "sisters", "siblings", "partners",
    # Descriptors regional press puts in front of a name. Unrecognised, they
    # become part of it: "Hotelier Anna Pellow" was a three-word person.
    "businessman", "businesswoman", "hotelier", "restaurateur", "property developer",
    "developer", "housebuilder", "philanthropist", "financier", "industrialist",
    "publican", "brewer", "retailer", "animator", "engineer", "inventor",
    "designer", "architect", "dealmaker", "serial entrepreneur", "tech entrepreneur",
)
_TITLE_ACRONYMS = ("CEO", "CFO", "MD", "COO", "CTO", "CSO", "CIO", "CCO")

#: Verbs that take a person as their object. "acquired by" is excluded — that
#: nearly always takes a company.
_AGENT_VERBS = (
    "founded by", "co-founded by", "established by", "set up by", "created by",
    "registered by", "led by", "owned by", "started by", "launched by",
    "sold by", "built by", "backed by", "chaired by", "run by", "headed by",
)

#: Wealth verbs that follow a person's name in headlines. "Gareth Halberton has
#: sold…" is the single most common shape and used to be missed entirely.
_SUBJECT_VERBS = (
    "has sold", "have sold", "sells", "sold", "has agreed to sell", "exits",
    "has exited", "nets", "netted", "pockets", "banks", "cashes in",
    "has raised", "raises", "secures", "has secured", "buys", "has bought",
    "acquires", "has acquired", "steps down", "retires", "is stepping down",
    "has launched", "launches", "has set up", "sets up", "invests",
    "has invested", "takes a stake", "floats", "lists",
    # Deal language: "X has agreed the sale of…", "X completes the disposal…".
    "has agreed", "have agreed", "completes", "has completed", "confirmed",
    "has confirmed", "will retain", "retains", "has reduced", "reduces",
    "has disposed", "disposes",
    # Land, estate and succession language.
    "has restructured", "restructures", "inherits", "has inherited",
    "has transferred", "transfers", "has put", "puts", "has placed", "places",
    "received", "has received", "took home", "takes home", "was awarded",
)

#: Honorifics and name particles, so Gulf, Dutch, German and Iberian names parse.
_HONORIFIC = r"(?:Mr|Mrs|Ms|Miss|Dr|Sir|Dame|Lord|Lady|Sheikh|Sheikha|Prince|Princess|Prof)\.?\s+"
_PARTICLE = r"(?:al|Al|el|El|bin|Bin|bint|ibn|van|Van|von|Von|de|De|da|Da|di|Di|du|Du|le|La|dos|del)"

# Latin letters beyond ASCII, so Céline Duforêt, Emre Yıldırım and Paweł
# Kowalski are people rather than nothing. `re` has no \p{Lu}, so the ranges are
# spelled out: Latin-1 Supplement letters, Latin Extended-A, and the Turkish
# dotted/dotless i. Extended-A interleaves cases, so it appears in both classes —
# that costs a little precision on which strings count as capitalised and buys
# every European alphabet.
_UPPER = "A-ZÀ-ÖØ-ÞĀ-ſİ"
_LETTER = "A-Za-zÀ-ÿĀ-ſİı"
#: A word in a name. The single-letter form is allowed only before an apostrophe
#: or hyphen, so "O'Loughlin" parses without "US Firm" becoming a person.
_WORD = (
    rf"(?:[{_UPPER}][{_LETTER}]+|[{_UPPER}](?=[-'’]))"
    rf"(?:[-'’][{_UPPER}]?[{_LETTER}]+)*"
)
#: A name is 2–4 capitalised words, optionally separated by particles, with an
#: optional generational suffix.
_NAME = (
    rf"{_WORD}(?:\s+(?:{_PARTICLE}\s+)?{_WORD}){{1,3}}"
    r"(?:\s+(?:Jr|Sr|II|III|IV)\.?)?"
)


def _ci(word: str) -> str:
    return "".join(f"[{c.lower()}{c.upper()}]" if c.isalpha() else re.escape(c) for c in word)


_TITLES = "|".join([*(_ci(w) for w in _TITLE_WORDS), *_TITLE_ACRONYMS])
_AGENTS = "|".join(_ci(v) for v in _AGENT_VERBS)
_SUBJECTS = "|".join(_ci(v) for v in _SUBJECT_VERBS)

# Titles are matched case-insensitively; names never are, or `[A-Z][a-z]+`
# would swallow trailing lowercase words.
_PATTERNS: tuple[tuple[re.Pattern[str], int, int], ...] = (
    # "Gareth Halberton, chairman of…"  (name, title)
    (re.compile(rf"({_NAME}),?\s+(?:the\s+)?(?:company\s+|group\s+)?({_TITLES})\b"), 1, 2),
    # "chairman Gareth Halberton"  (title, name)
    (re.compile(rf"\b({_TITLES})\s+(?:{_HONORIFIC})?({_NAME})\b"), 2, 1),
)

#: "…established by Alastair Wren" — agent of the event, no title stated.
_AGENT_PATTERN = re.compile(rf"\b(?:{_AGENTS})\s+(?:{_HONORIFIC})?({_NAME})\b")
#: "Gareth Halberton has sold…" — subject of a wealth verb.
_SUBJECT_PATTERN = re.compile(rf"\b(?:{_HONORIFIC})?({_NAME})\s+(?:{_SUBJECTS})\b")
#: "Alice Marchmont and Ruth Pelling have sold…" — two prospects, one sentence.
#: Without this the first name is silently dropped, because only the second sits
#: next to the verb.
_PAIR_PATTERN = re.compile(
    rf"\b(?:{_HONORIFIC})?({_NAME})\s+and\s+(?:{_HONORIFIC})?({_NAME})"
    rf"\s+(?:{_SUBJECTS})\b"
)
#: "Castore founders Tom and Phil Beahon", "husband and wife Anna and Mark
#: Tresize" — two first names sharing one surname. This is how family businesses
#: are written up, and family businesses are the target. A relationship or
#: plural-role word must come first: without it, "Marks and Spencer" is a couple.
_FAMILY_LEAD = "|".join(_ci(w) for w in (
    "brothers", "sisters", "siblings", "twins", "cousins", "couple",
    "husband and wife", "husband-and-wife", "father and son", "father and daughter",
    "mother and son", "mother and daughter", "founders", "co-founders", "owners",
    "co-owners", "directors", "partners", "shareholders", "husband and wife team",
    "family",
))
_FIRST = rf"[{_UPPER}][{_LETTER}]+"
_FAMILY_PATTERN = re.compile(
    rf"\b(?:{_FAMILY_LEAD})\s+(?:team\s+)?({_FIRST})\s+(?:and|&)\s+({_FIRST})\s+"
    rf"({_WORD}(?:\s+(?:{_PARTICLE}\s+)?{_WORD})?)"
)

#: "Dale Vince's Ecotricity", "John Pellow's Cornish holiday park sold" — the
#: owner named possessively. Only when what follows is a business: "Sarah's
#: birthday" is not a wealth event, and requiring two name words already rules
#: out "Plymouth's".
_BUSINESS_NOUNS = (
    "firm", "company", "business", "group", "empire", "estate", "farm", "park",
    "brand", "chain", "stake", "shareholding", "holding", "family business",
    "portfolio", "hotel", "hotels", "brewery", "dairy", "factory", "manufacturer",
    "agency", "consultancy", "fund", "venture", "startup", "start-up",
)
_POSSESSIVE_PATTERN = re.compile(
    rf"(?:\b{_HONORIFIC})?\b({_NAME})['’]s\s+"
    rf"(?:[A-Z]|(?:[a-z-]+\s+){{0,3}}(?:{'|'.join(_ci(n) for n in _BUSINESS_NOUNS)})\b)"
)

#: "…founded by Alice Marchmont and Ruth Pelling" — same problem, other side.
_PAIR_AGENT_PATTERN = re.compile(
    rf"\b(?:{_AGENTS})\s+(?:{_HONORIFIC})?({_NAME})\s+and\s+(?:{_HONORIFIC})?({_NAME})\b"
)

#: First words that mark a phrase as not a personal name.
_STOPWORDS = frozenset({
    "The", "A", "An", "This", "That", "These", "Those", "New", "Business",
    "Company", "Group", "Limited", "Ltd", "Holdings", "Its", "His", "Her",
    "Their", "Our", "One", "Two", "Three", "Former", "Chief", "Managing",
    "Senior", "Deputy", "Vice", "North", "South", "East", "West", "Great",
    "Royal", "United", "British", "American", "Private", "Family", "Rich",
    "Wealth", "Global", "International", "National", "Sunday", "Financial",
    "Daily", "Weekly", "Exclusive", "Breaking", "Analysis", "Opinion",
    "Revealed", "How", "Why", "What", "When", "Where", "Who", "Meet",
    "Inside", "Top", "Best", "First", "Last", "Next", "Another",
    "US", "UK", "UAE", "EU", "EMEA", "APAC", "Saudi", "Emirati", "Gulf",
    "Middle", "European", "Asian", "African", "Indian", "Chinese", "Japanese",
})

#: Common nouns that appear capitalised in Title Case headlines. Rejected
#: wherever they appear in a candidate, not just at the front: "US Firm Sold for
#: £40m" would otherwise produce a prospect named "US Firm" with an estimated
#: £17m of investable assets.
_GENERIC = frozenset({
    "Firm", "Group", "Company", "Business", "Holdings", "Council", "City",
    "Bank", "Fund", "Trust", "Startup", "Start-up", "Investors", "Office",
    "Board", "Team", "Family", "Founder", "Founders", "Owner", "Owners",
    "Maker", "Retailer", "Developer", "Manufacturer", "Builder", "Operator",
    "Deal", "Sale", "Stake", "Shares", "Round", "Fundraise", "Buyout",
    "Exchange", "Market", "Markets", "Report", "News", "Times", "Post",
    "Journal", "Herald", "Gazette", "Magazine", "Review",
    # Words that only ever appear in business names. "Kinetic Data sold to US
    # buyer" has exactly the shape of "Gareth Halberton sold…", and without
    # these the company was being recorded as a person.
    "Data", "Tech", "Technology", "Technologies", "Software", "Systems", "Labs",
    "Digital", "Energy", "Homes", "Foods", "Food", "Dairies", "Dairy", "Brewery",
    "Brewing", "Aero", "Aerospace", "Holidays", "Precision", "Engineering",
    "Logistics", "Medical", "Health", "Healthcare", "Bio", "Biotech", "Media",
    "Solutions", "Services", "Consulting", "Estates", "Properties", "Property",
    "Motors", "Marine", "Industries", "Products", "Brands", "Provisions",
    "Tooling", "Boatworks", "Renewables", "Semiconductor", "Pharma", "Capital",
    "Ventures", "Partners", "Hotels", "Leisure", "Construction", "Developments",
    "Interiors", "Furniture", "Packaging", "Plastics", "Chemicals", "Textiles",
    "Insurance", "Finance", "Payments", "Robotics", "Analytics", "Networks",
    "Studios", "Agency", "Farms", "Nurseries", "Distillery", "Cider", "Gin",
    # Landscape and institutions — "Salisbury Plain Farmland sells for £12m" and
    # "Dartmoor National Park buys farm" have a person's shape and no person.
    # Only words that are never surnames: Park, Hill, Wood and Green are, and are
    # handled by length instead.
    "Farmland", "National", "Plain", "Moor", "Moors", "Valley", "Forest",
    "Council", "Councils", "Railway", "Railways", "Airport", "Hospital",
    "University", "College", "School", "Academy", "Awards", "Estate", "Estates",
    "Harbour", "Parish", "County", "Borough", "District", "Authority",
    "Authorities", "Commission", "Society", "Association", "Federation",
    "Institute", "Chamber", "Rovers", "United", "Athletic", "Wanderers",
})

#: Corporate suffixes: if a candidate ends in one it is a company, not a person.
_COMPANY_SUFFIX = re.compile(
    r"\b(Ltd|Limited|PLC|plc|LLP|LLC|Inc|Corp|Corporation|Group|Holdings|Partners|"
    r"Capital|Ventures|Technologies|Systems|Solutions|Bank|Trust|Fund|GmbH|AG|SA|"
    r"NV|BV|AB|AS|SpA|Pty|Bhd|PJSC|LLC\.?)\.?$"
)

_NOT_PEOPLE = frozenset({
    "business live", "insider media", "companies house", "rich list",
    "sunday times", "financial times", "wall street journal", "private equity",
    "family office", "the times", "sky news", "city am", "bloomberg news",
    "arabian business", "gulf news", "khaleej times", "the national",
})

#: Words that begin a job title, not a name. A sentence opening "Owner Matthias
#: von Hallwyl has agreed the sale…" puts a capitalised title immediately before
#: the name, and the subject pattern would otherwise swallow it and record a
#: person called "Owner Matthias von Hallwyl".
_TITLE_LEAD: frozenset[str] = frozenset(
    {token.capitalize() for word in _TITLE_WORDS for token in word.replace("-", " ").split()}
    | {word.capitalize() for word in _TITLE_WORDS}
    | {"Co-founder", "Cofounder", "Co-owner", "Non-executive", "Ex", "Former"}
    | set(_TITLE_ACRONYMS)
)

#: Every place name across all markets, lower-cased, so "Palm Beach has sold"
#: can't become a person.
_PLACE_NAMES: frozenset[str] = frozenset(
    place.lower()
    for market in MARKET_BY_KEY.values()
    for place in market.places
) | frozenset(market.name.lower() for market in MARKET_BY_KEY.values()) | frozenset(
    market.country.lower() for market in MARKET_BY_KEY.values()
)


@dataclass(frozen=True)
class Person:
    name: str
    title: str


def _normalise_title(title: str) -> str:
    lower = title.lower().strip()
    mapping = {
        "ceo": "Chief Executive", "chief executive": "Chief Executive",
        "cfo": "Chief Financial Officer", "md": "Managing Director",
        "coo": "Chief Operating Officer", "cto": "Chief Technology Officer",
        "cso": "Chief Scientific Officer", "cio": "Chief Investment Officer",
        "cco": "Chief Commercial Officer", "cofounder": "Co-founder",
        "boss": "Chief Executive",
    }
    if lower in mapping:
        return mapping[lower]
    return " ".join(w.capitalize() for w in lower.split())


def _plausible_name(candidate: str) -> bool:
    """Reject anything that is clearly not a person's name."""
    name = candidate.strip()
    words = name.split()
    if len(words) < 2 or len(words) > 5:
        return False
    if words[0] in _STOPWORDS:
        return False
    if any(word in _GENERIC for word in words):
        return False
    if name.lower() in _NOT_PEOPLE:
        return False
    if _COMPANY_SUFFIX.search(name):
        return False
    # A place is not a person, however capitalised.
    if name.lower() in _PLACE_NAMES:
        return False
    # Reject when every word is a stopword or a place.
    if all(w in _STOPWORDS or w.lower() in _PLACE_NAMES for w in words):
        return False
    # A name whose first two words are both places ("Palm Beach") is a location.
    if len(words) >= 2 and " ".join(words[:2]).lower() in _PLACE_NAMES:
        return False
    # A surname that is also a landscape word is fine in a two-word name ("Nick
    # Park") and never the last word of a three-word one ("Dartmoor National Park").
    if len(words) >= 3 and words[-1] in {"Park", "Parks", "Hill", "Hills", "Wood",
                                          "Woods", "Green", "Field", "Fields", "Bay"}:
        return False
    # Require at least one word of three or more letters — filters initials soup.
    if not any(len(w) >= 3 for w in words):
        return False
    return True


def extract_people(text: str) -> list[Person]:
    """Find named individuals, with their role where one is stated.

    Four patterns, in decreasing confidence: name-then-title, title-then-name,
    agent-of-verb, and subject-of-wealth-verb. Returns at most three, because an
    article naming more is a round-up rather than a story about one person.
    """
    found: list[Person] = []

    def add(name: str, title: str) -> None:
        name = re.sub(r"['’]s$", "", name.strip(" ,.;:"))
        words = " ".join(name.split()).strip(" ,.;:").split()
        # Drop any job title the pattern picked up in front of the name.
        while words and words[0] in _TITLE_LEAD:
            words.pop(0)
        cleaned = " ".join(words)
        if not _plausible_name(cleaned):
            return
        if any(p.name == cleaned for p in found):
            return
        found.append(Person(name=cleaned, title=title))

    for pattern, name_group, title_group in _PATTERNS:
        for match in pattern.finditer(text):
            add(match.group(name_group), _normalise_title(match.group(title_group)))

    for match in _POSSESSIVE_PATTERN.finditer(text):
        add(match.group(1), "")

    # Families first: "Tom and Phil Beahon" is two people with one surname, and
    # every other pattern either misses them or keeps only "Phil Beahon".
    for match in _FAMILY_PATTERN.finditer(text):
        surname = match.group(3)
        add(f"{match.group(1)} {surname}", "")
        add(f"{match.group(2)} {surname}", "")

    # Pairs next: both halves are wanted, and the singular patterns below would
    # only ever reach whichever name sits next to the verb.
    for pattern in (_PAIR_PATTERN, _PAIR_AGENT_PATTERN):
        for match in pattern.finditer(text):
            add(match.group(1), "")
            add(match.group(2), "")

    # No title stated in these two, and guessing one would invent detail.
    for match in _AGENT_PATTERN.finditer(text):
        add(match.group(1), "")
    for match in _SUBJECT_PATTERN.finditer(text):
        add(match.group(1), "")

    return found[:3]


# ---------------------------------------------------------------------------
# Companies
# ---------------------------------------------------------------------------
#
# A headline names two companies about as often as one, and they are not
# interchangeable: "Meridian Capital acquires Solent Semiconductor" is a story
# about the *seller's* business, and the seller is the prospect. So companies
# are read from **target positions** — the thing sold, bought, backed or founded
# — and never from buyer positions ("acquired by X", "sold to X", "X buys").
#
# Headlines almost never include "Ltd". Requiring a corporate suffix, as the
# first version did, meant most real records had no company, which the
# verification tiers then (correctly) refuse to promote. That combination hid
# nearly every genuine prospect a live sweep found.

_COMPANY = re.compile(
    r"\b((?:[A-Z][\w&'’.-]*\s+){0,4}"
    r"(?:Ltd|Limited|PLC|plc|LLP|LLC|Inc|Corp|Group|Holdings|Partners|Capital|"
    r"Ventures|Technologies|Systems|Solutions|GmbH|AG|PJSC|Bhd|Pty))\b"
)

#: A run of capitalised tokens — a proper name. "&" joins ("Smith & Sons").
_CAP = r"[A-Z][\w&'’.-]*"
_CAP_PHRASE = rf"(?:{_CAP})(?:\s+(?:{_CAP}|&))*"

#: What a business is called in a headline before its name is given.
_SECTOR_NOUNS = (
    "firm", "company", "business", "group", "maker", "manufacturer", "producer",
    "brewer", "brewery", "distiller", "distillery", "developer", "specialist",
    "supplier", "provider", "retailer", "operator", "brand", "agency", "consultancy",
    "startup", "start-up", "scale-up", "scaleup", "fintech", "biotech", "medtech",
    "dairy", "bakery", "housebuilder", "contractor", "chain", "manufacturers",
    "family business", "family firm", "engineer", "engineers", "designer",
    "producer", "processor", "wholesaler", "distributor", "haulier", "insurer",
    "lender", "platform", "studio", "practice", "cider maker", "gin maker",
)
_SECTOR = "|".join(_ci(n) for n in sorted(_SECTOR_NOUNS, key=len, reverse=True))

#: "Bath-based", "Truro-headquartered" — journalese before a company name.
_BASED = r"(?:[A-Z][\w'’.]*-(?:based|headquartered|listed|owned|founded)\s+)"
#: "Plymouth's", "Gloucestershire's" — a place possessive before a name. Only
#: *known* places qualify: "Arkell's Brewery" has the same shape, and treating
#: Arkell's as a town leaves a company called "Brewery".
_KNOWN_PLACE = "(?:" + "|".join(
    re.escape(place) for place in sorted(
        {p for m in MARKET_BY_KEY.values() for p in m.places}, key=len, reverse=True
    )
) + ")"
_PLACE_POSSESSIVE = rf"(?:{_KNOWN_PLACE}['’]s\s+)"

_TARGET_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "software firm Kinetic Data", "cider maker Thatchers"
    re.compile(rf"\b(?:{_SECTOR})\s+{_BASED}?({_CAP_PHRASE})"),
    # "Owner of Plymouth's Mount Batten Boatworks", "founder of Rengen"
    re.compile(
        rf"\b(?:{_ci('founder')}|{_ci('co-founder')}|{_ci('owner')}|{_ci('owners')}|"
        rf"{_ci('chairman')}|{_ci('boss')}|{_ci('chief executive')}|"
        rf"{_ci('managing director')}|{_ci('shareholders')})\s+{_ci('of')}\s+"
        rf"{_BASED}?{_PLACE_POSSESSIVE}?({_CAP_PHRASE})"
    ),
    # "Acquisition of Cotswold Provisions", "stake in Solent Semiconductor"
    re.compile(
        rf"\b(?:{_ci('acquisition')}|{_ci('takeover')}|{_ci('sale')}|{_ci('purchase')}|"
        rf"{_ci('buyout')}|{_ci('buy-out')})\s+(?:{_ci('of')}|{_ci('at')})\s+"
        rf"(?:{_ci('the')}\s+)?{_BASED}?{_PLACE_POSSESSIVE}?({_CAP_PHRASE})"
    ),
    re.compile(
        rf"\b{_ci('stake')}\s+{_ci('in')}\s+(?:[a-z]+\s+){{0,3}}{_BASED}?({_CAP_PHRASE})"
    ),
    # "Thales acquires Bath-based Coda Octopus" — the object is the target.
    re.compile(
        rf"\b(?:{_ci('buys')}|{_ci('acquires')}|{_ci('snaps up')}|{_ci('takes over')}|"
        rf"{_ci('backs')}|{_ci('sells')}|{_ci('sold')}|{_ci('has sold')})\s+"
        rf"(?:{_ci('the')}\s+)?{_BASED}({_CAP_PHRASE})"
    ),
    # "Gareth Halberton sells Halberton Precision" — a person selling a company.
    re.compile(rf"\b(?:{_ci('sells')}|{_ci('has sold')})\s+({_CAP_PHRASE})"),
    # "Halberton Precision bought by…", "Quantock Energy Ltd sold to…"
    re.compile(
        rf"(?:^|[.:;]\s+){_BASED}?{_PLACE_POSSESSIVE}?({_CAP_PHRASE})\s+"
        rf"(?:{_ci('has been')}\s+|{_ci('is')}\s+|{_ci('was')}\s+)?"
        rf"(?:{_ci('bought')}|{_ci('acquired')}|{_ci('sold')}|{_ci('snapped up')}|"
        rf"{_ci('taken over')}|{_ci('agrees sale')}|{_ci('changes hands')})\b"
    ),
    # "Castore founders Tom and Phil…", "Rengen founder Iestyn Lewis"
    re.compile(
        rf"(?:^|[.:;]\s+|\b(?:at|of)\s+)?({_CAP_PHRASE})\s+(?:{_ci('founders')}|"
        rf"{_ci('founder')}|{_ci('co-founder')}|{_ci('owner')}|{_ci('owners')}|"
        rf"{_ci('boss')}|{_ci('chairman')}|{_ci('chief')})\s+[A-Z]"
    ),
    # "Dale Vince's Ecotricity", "Gloucestershire's Kemble Aero"
    re.compile(rf"[A-Z][\w.-]*(?:\s+[A-Z][\w.-]*)?['’]s\s+({_CAP_PHRASE})"),
)

#: Tokens that end a company name when a Title Case headline runs everything
#: together ("Firm Kinetic Data Sold To US Buyer").
_COMPANY_STOP = frozenset({
    "sold", "to", "by", "for", "in", "acquired", "buys", "buy", "deal", "as", "after",
    "with", "from", "sells", "bought", "agrees", "agreed", "plans", "backed",
    "reports", "announces", "completes", "raises", "secures", "at", "on", "and",
    "founder", "founders", "owner", "owners", "boss", "chairman", "chief", "ceo",
    "co-founder", "has", "is", "was", "the", "a", "an", "of", "takes", "exits",
    "snapped", "taken", "changes", "backs", "expands", "enters", "lands", "wins",
})

#: A candidate made only of these is a description, not a name.
_COMPANY_GENERIC = frozenset({
    "private", "equity", "firm", "company", "business", "group", "holdings",
    "family", "us", "uk", "german", "french", "american", "british", "european",
    "rival", "buyer", "investor", "investors", "management", "team", "board",
    "founder", "owner", "shareholders", "gulf", "chinese", "japanese", "indian",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "brewery", "dairy", "bakery", "distillery", "agency", "studio", "practice",
    "cornish", "devonian", "welsh", "scottish", "english", "irish", "bristolian",
    "londoner", "dorset", "somerset", "wiltshire", "cotswold", "west", "south",
    "north", "east", "southern", "northern", "western", "eastern", "regional",
    "local", "national", "international", "global", "leading", "independent",
})


def _trim_company(candidate: str) -> str | None:
    """Cut a captured phrase down to the name and reject non-names."""
    words = candidate.replace("’", "'").split()
    kept: list[str] = []
    for word in words:
        if word.lower().strip(".,;:") in _COMPANY_STOP:
            break
        kept.append(word.strip(".,;:"))
    while kept and (
        _COMPANY_PREFIX.match(kept[0]) or kept[0].lower() in {"the", "a", "an"}
    ):
        kept.pop(0)
    while kept and kept[-1] in {"&", "and"}:
        kept.pop()
    if not kept or len(kept) > 5:
        return None
    lowered = [k.lower() for k in kept]
    if all(k in _COMPANY_GENERIC or k in _PLACE_NAMES for k in lowered):
        return None
    name = " ".join(kept)
    if name.lower() in _PLACE_NAMES or name.lower() in _NOT_PEOPLE:
        return None
    return name


#: Journalese that sits in front of a company name: "Connecticut-based Ellsworth
#: Ridge Capital", "the Türkiye-listed retailer". Capitalised, so the pattern
#: above swallows it and the record ends up naming a company that doesn't exist.
_COMPANY_PREFIX = re.compile(
    r"^[A-Z][\w'’.]*-(?:based|listed|headquartered|owned|backed|founded)$"
)

#: A company in one of these positions is the buyer or its backer.
_BUYER_CONTEXT = re.compile(
    r"(?:\b(?:by|to|from|with)\s+$)", re.I
)
_BUYER_FOLLOWS = re.compile(
    r"^\s+(?:acquires|buys|backs|invests|takes|has acquired|has bought|snaps)\b", re.I
)


def reconcile(text: str) -> tuple[list[Person], str | None]:
    """People and company, each checked against the other.

    The two extractors can claim the same words. "Kinetic Data sold to US buyer"
    has exactly the shape of "Gareth Halberton sold…", so one of them must be
    wrong about it. The tie-break is the strongest evidence of personhood
    available: a stated job title. "Founder Gareth Halberton" is a person
    whatever else matches; an untitled capitalised pair that the company
    extractor found in a company position is a company.
    """
    people = extract_people(text)
    titled = {p.name.lower() for p in people if p.title}

    company = extract_company(text, exclude=sorted(titled))
    if company:
        people = [p for p in people if p.name.lower() != company.lower()]
    return people, company


def extract_company(text: str, *, exclude: list[str] | tuple[str, ...] = ()) -> str | None:
    """The company the story is about — the one that was sold, bought or backed.

    ``exclude`` takes the people already extracted, so "Gareth Halberton sells…"
    cannot come back as a company called Gareth Halberton.
    """
    if not text:
        return None
    people = {e.lower() for e in exclude}

    def valid(candidate: str | None) -> str | None:
        if not candidate:
            return None
        name = _trim_company(candidate)
        if not name:
            return None
        if name.lower() in people or any(name.lower() == p.split()[0] for p in people):
            return None
        return name

    for pattern in _TARGET_PATTERNS:
        for match in pattern.finditer(text):
            name = valid(match.group(1))
            if name:
                return name

    # Fallback: an explicit corporate suffix, provided it is not sitting in a
    # buyer's position. "…acquired by Schmidt Holdings" is the acquirer.
    for match in _COMPANY.finditer(text):
        before = text[: match.start()]
        after = text[match.end():]
        if _BUYER_CONTEXT.search(before) or _BUYER_FOLLOWS.match(after):
            continue
        name = valid(match.group(1))
        if name and len(name.split()) >= 2:
            return name
    return None


# ---------------------------------------------------------------------------
# Event classification
# ---------------------------------------------------------------------------

_EVENT_SIGNATURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("business_exit", re.compile(
        r"\b(sells? (?:his|her|their|the) (?:stake|business|shareholding|company)"
        r"|sold (?:his|her|their|the) (?:stake|business|shareholding|company)"
        r"|completes? the sale|agreed the sale|agrees? (?:the )?sale|sale of the business"
        r"|exits? the business|has (?:now )?sold|been sold|divests?|offloads?"
        r"|cashes? out|exit(?:s|ed)? (?:from|the))\b", re.I)),
    ("acquisition", re.compile(
        r"\b(acquired by|acquires|acquisition of|takeover|snapped up|bought by"
        r"|merges? with|buys? (?:a )?(?:majority|controlling|minority)? ?stake"
        r"|agrees? to (?:buy|acquire)|swoops? (?:for|on))\b", re.I)),
    ("management_buyout", re.compile(
        r"\b(management buyout|\bMBO\b|employee ownership trust|\bEOT\b"
        r"|management buy-?in|\bMBI\b)", re.I)),
    ("ipo", re.compile(
        r"\b(\bIPO\b|initial public offering|floats? on|flotation|AIM listing"
        r"|listing on the|goes? public|stock market debut|direct listing)\b", re.I)),
    ("private_equity", re.compile(
        r"\b(private equity|growth capital|\bPE\b (?:firm|house|backer|investor)"
        r"|buyout (?:firm|house|group)|sovereign wealth fund)\b", re.I)),
    ("venture_funding", re.compile(
        r"\b(series [a-f]\b|seed round|pre-seed|funding round|investment round"
        r"|raises? [£$€]|secures? [£$€]|closes? (?:a )?[£$€]|funding of"
        r"|led a round|oversubscribed round)\b", re.I)),
    ("large_dividend", re.compile(
        r"\b(dividend|distribution to shareholders|paid out to shareholders"
        r"|special dividend|payout to (?:its )?owners?)\b", re.I)),
    ("windfall", re.compile(
        r"\b(windfall|payout|cashes? in|nets? [£$€]|pockets? [£$€]|banks? [£$€]"
        r"|walks? away with|set to (?:make|receive))\b", re.I)),
    ("share_sale", re.compile(
        r"\b(sells? shares|share sale|offloads? shares|reduces? (?:his|her|their) (?:stake|holding)"
        r"|trims? (?:his|her|their) stake|disposes? of shares|insider sale)\b", re.I)),
    ("family_office", re.compile(
        r"\b(family office|family investment company|single family office"
        r"|multi-family office|family holding company)\b", re.I)),
    ("rich_list", re.compile(
        r"\b(rich list|wealth list|richest|billionaires? (?:list|index)"
        r"|wealthiest|net worth of)\b", re.I)),
    ("property", re.compile(
        r"\b(buys?|bought|purchases?|acquires?|snaps? up)\b[^.]{0,50}"
        r"\b(estate|manor|mansion|country house|penthouse|villa|townhouse"
        r"|property portfolio|super-?prime)\b", re.I)),
    ("land_sale", re.compile(
        r"\b((?:farm|farmland|land|estate|acres?|holding)s? (?:is |has been |was |have been )?sold"
        r"|sells? (?:the )?(?:farm|farmland|land|estate)\b|sells? [\d,]+ acres?"
        r"|sale of the (?:estate|farm|land)|acres? of (?:farmland|land) (?:sold|for sale)"
        r"|agricultural land sale|acres? (?:go|goes|went) (?:on|under) the hammer)\b", re.I)),
    ("landholding", re.compile(
        r"\b(landowner|landed estate|country estate|farming family|family farm"
        r"|agricultural business|estate owner|tenanted estate"
        r"|[\d,]+ acres?)\b", re.I)),
    ("exec_comp", re.compile(
        r"\b(remuneration report|total remuneration|annual bonus|"
        r"long-?term incentive|\bLTIP\b|director shareholding|\bPDMR\b"
        r"|chief executive'?s? pay|pay package|took home)\b", re.I)),
    ("succession", re.compile(
        r"\b(steps? down|stepping down|retires?|retiring|hands over|succession plan"
        r"|passes? the reins|hands? the reins)\b", re.I)),
    ("company_growth", re.compile(
        r"\b(turnover (?:rises?|rose|up|climbs?)|revenue (?:jumps?|rises?|grew|soars?)"
        r"|profits? (?:soar|jump|rise|climb|double)|record (?:year|profits|results|revenue)"
        r"|fastest-growing)\b", re.I)),
)


@dataclass
class ExtractedEvent:
    """One wealth event read out of one article."""

    event_key: str
    event_label: str
    weight: int
    market_key: str
    market_name: str
    market_group: str
    country: str
    matched_place: str
    #: "text" if the article named the place, "query" if we relied on the search.
    market_source: str
    #: The narrowest place named — a town rather than the market. None when the
    #: source only gives the market, which is often.
    locality: str | None
    amount_gbp: int | None
    people: list[Person] = field(default_factory=list)
    company: str | None = None
    title: str = ""
    summary: str = ""
    url: str = ""
    publisher: str = ""
    published_at: datetime | None = None
    rationale: str = ""


#: Narrow, high-precision patterns. When one of these fires alongside a generic
#: one it should win, whatever the weights say: "sold in a management buyout" and
#: "1,200 acres sold by owner X" both also match the broad "has been sold"
#: pattern, and reporting them as a plain business exit throws away the thing
#: that made them worth finding.
_SPECIFIC_EVENTS = frozenset({
    "land_sale", "landholding", "exec_comp", "management_buyout", "ipo",
    "family_office", "rich_list", "large_dividend", "venture_funding",
    "private_equity",
})


def classify(text: str) -> list[str]:
    """All event types the text matches, most specific and strongest first."""
    hits = [key for key, pattern in _EVENT_SIGNATURES if pattern.search(text)]
    return sorted(
        hits,
        key=lambda k: (
            k in _SPECIFIC_EVENTS,
            EVENT_BY_KEY[k].weight if k in EVENT_BY_KEY else 0,
        ),
        reverse=True,
    )


def extract_event(
    *,
    title: str,
    summary: str,
    url: str,
    publisher: str,
    published_at: datetime | None,
    query_event_key: str | None = None,
    query_market_key: str | None = None,
    allowed_markets: tuple[str, ...] | list[str] | None = None,
) -> ExtractedEvent | None:
    """Turn an article into a wealth event, or reject it.

    ``query_market_key`` is the market whose search surfaced this article. When
    the text itself doesn't name a place — which is most of the time, because
    news snippets are short — that context is used instead and recorded as
    ``market_source="query"``. Discarding those was what limited the original
    version to a handful of results.

    Geography is resolved against *every* market, not just the selected ones, and
    only then checked against the selection. The distinction matters: an article
    that positively names Manchester during a Devon sweep must be rejected, while
    an article that names nowhere at all can legitimately inherit Devon from the
    query. Restricting the match to the selection would make the first case look
    like the second and file a Mancunian under Devon.

    Rejected when: no wealth event is recognised, the article is positively about
    a market outside the selection, or no market can be established at all.
    """
    text = f"{title}. {summary}".strip()
    if not text or text == ".":
        return None

    matched_events = classify(text)
    event_key = matched_events[0] if matched_events else query_event_key
    if not event_key:
        return None
    template = EVENT_BY_KEY.get(event_key)
    if template is None:
        return None

    match: MarketMatch | None = resolve_market(text, prefer=query_market_key)

    if match is not None and allowed_markets and match.market_key not in allowed_markets:
        return None

    if match is None and query_market_key:
        market = MARKET_BY_KEY.get(query_market_key)
        if market is None:
            return None
        match = MarketMatch(market.key, market.name, market.name, "query")

    if match is None:
        return None

    market = MARKET_BY_KEY[match.market_key]
    locality = most_specific_place(text, match.market_key)
    amount = parse_money(text)
    people, company = reconcile(text)

    reasons = [f"Matched a {template.label.lower()} pattern"]
    if match.source == "text":
        where = f"located in {match.market_name} via “{match.matched_place}”"
        if locality and locality.lower() != match.matched_place.lower():
            where += f", narrowed to {locality}"
        reasons.append(where)
    else:
        reasons.append(
            f"attributed to {match.market_name} because it was found by the "
            f"{match.market_name} search, though the article text does not name the place"
        )
    if amount:
        reasons.append(f"reported value £{amount:,}")
    if people:
        reasons.append(f"named {', '.join(p.name for p in people)}")
    else:
        reasons.append("no individual named, so this is a company-level lead only")

    return ExtractedEvent(
        event_key=event_key,
        event_label=template.label,
        weight=template.weight,
        market_key=match.market_key,
        market_name=match.market_name,
        market_group=market.group,
        country=market.country,
        matched_place=match.matched_place,
        market_source=match.source,
        locality=locality,
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
