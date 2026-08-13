"""What the business actually does.

Sector matters for two reasons an advisor cares about. It changes the shape of
the wealth — a manufacturer's owner holds illiquid plant and a software founder
holds options — and it is how a book gets divided between people who know the
market. It is also the field any company database keys on, so a record without
one is harder to take anywhere else.

Two sources, and the difference is recorded rather than blended:

  * **Filed SIC codes** from Companies House. The company chose them and files
    them annually. Authoritative.
  * **Keyword inference** from the article and company name. A guess, marked as
    a guess, used only when nothing is filed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SECTORS: tuple[str, ...] = (
    "Technology & software",
    "Manufacturing & engineering",
    "Healthcare & life sciences",
    "Financial services",
    "Property & construction",
    "Retail & consumer",
    "Food & drink",
    "Energy & renewables",
    "Transport & logistics",
    "Professional services",
    "Agriculture & land",
    "Hospitality & leisure",
    "Media & marketing",
    "Education",
    "Other",
)

#: SIC section prefixes → sector. Companies House files five-digit SIC 2007
#: codes; the leading two digits carry the division, which is all that is needed.
_SIC_PREFIXES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("01", "02", "03"), "Agriculture & land"),
    (("05", "06", "07", "08", "09", "35", "36", "37", "38", "39"), "Energy & renewables"),
    (("10", "11", "12"), "Food & drink"),
    (("13", "14", "15", "16", "17", "18", "19", "20", "22", "23", "24", "25",
      "26", "27", "28", "29", "30", "31", "32", "33"), "Manufacturing & engineering"),
    (("21", "86", "87", "88"), "Healthcare & life sciences"),
    (("41", "42", "43", "68"), "Property & construction"),
    (("45", "46", "47"), "Retail & consumer"),
    (("49", "50", "51", "52", "53"), "Transport & logistics"),
    (("55", "56", "79", "90", "91", "92", "93"), "Hospitality & leisure"),
    (("58", "59", "60", "73"), "Media & marketing"),
    (("61", "62", "63", "95"), "Technology & software"),
    (("64", "65", "66"), "Financial services"),
    (("69", "70", "71", "72", "74", "77", "78", "80", "81", "82"), "Professional services"),
    (("85",), "Education"),
)

_KEYWORDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Technology & software", re.compile(
        r"\b(software|saas|fintech|cyber|cloud|platform|app\b|ai\b|artificial intelligence|"
        r"machine learning|semiconductor|chip designer|data (?:group|business)|tech firm|"
        r"deeptech|developer of)\b", re.I)),
    ("Healthcare & life sciences", re.compile(
        r"\b(biotech|pharma|clinical|diagnostics|medical device|healthcare|health group|"
        r"therapeutics|life sciences|dental|care home|genomics|nhs supplier)\b", re.I)),
    ("Financial services", re.compile(
        r"\b(asset manager|wealth manager|insurance|insurer|broker|bank\b|lender|"
        r"payments|fund manager|hedge fund|investment manager|mortgage)\b", re.I)),
    ("Manufacturing & engineering", re.compile(
        r"\b(manufactur|engineering|precision|foundry|fabricat|machining|toolmaker|"
        r"aerospace|automotive|components|industrial group|plant)\b", re.I)),
    ("Property & construction", re.compile(
        r"\b(property|developer|housebuilder|construction|contractor|real estate|"
        r"estate agency|surveyor|architect|regeneration)\b", re.I)),
    ("Food & drink", re.compile(
        r"\b(brewer|brewery|distiller|food group|bakery|dairy|drinks|beverage|"
        r"confection|provisions|meat|farm shop|snack)\b", re.I)),
    ("Energy & renewables", re.compile(
        r"\b(renewable|solar|wind farm|energy group|utilities|oil and gas|hydrogen|"
        r"battery|ecotricity|power group)\b", re.I)),
    ("Transport & logistics", re.compile(
        r"\b(logistics|haulage|freight|shipping|courier|distribution group|fleet|"
        r"transport group|warehousing)\b", re.I)),
    ("Retail & consumer", re.compile(
        r"\b(retailer|retail group|e-?commerce|consumer brand|clothing|footwear|"
        r"homeware|garden centre|supermarket|direct-to-consumer)\b", re.I)),
    ("Agriculture & land", re.compile(
        r"\b(farm|farming|agricultur|arable|livestock|estate|acres|landowner|"
        r"forestry|horticultur)\b", re.I)),
    ("Hospitality & leisure", re.compile(
        r"\b(hotel|hospitality|restaurant|pub group|leisure|resort|holiday park|"
        r"gym|fitness|travel group|tourism)\b", re.I)),
    ("Media & marketing", re.compile(
        r"\b(agency group|advertising|marketing|creative agency|publisher|media group|"
        r"production company|pr firm|broadcast)\b", re.I)),
    ("Professional services", re.compile(
        r"\b(consultancy|accountancy|law firm|legal services|recruitment|staffing|"
        r"advisory firm|outsourcing|facilities management)\b", re.I)),
    ("Education", re.compile(
        r"\b(education|school group|edtech|training provider|university|academy trust|"
        r"tuition)\b", re.I)),
)


@dataclass(frozen=True)
class SectorGuess:
    sector: str
    #: "filed" when it comes from the company's own SIC codes, "inferred" when
    #: read out of the text. Never blended — one is a fact, one is a guess.
    basis: str
    detail: str


def sector_from_sic(sic_codes: list[str] | tuple[str, ...] | None) -> SectorGuess | None:
    """Sector from filed SIC codes. Authoritative when present."""
    if not sic_codes:
        return None
    for code in sic_codes:
        digits = re.sub(r"\D", "", str(code))
        if len(digits) < 2:
            continue
        division = digits[:2]
        for prefixes, sector in _SIC_PREFIXES:
            if division in prefixes:
                return SectorGuess(
                    sector, "filed",
                    f"From the company's filed SIC code {code}, which it files "
                    f"annually and chose itself.",
                )
    return None


def sector_from_text(*parts: str | None) -> SectorGuess:
    """Sector inferred from the article and company name. A guess, labelled."""
    text = " ".join(p for p in parts if p)
    if not text.strip():
        return SectorGuess("Other", "inferred", "Nothing in the source indicates a sector.")

    scores: dict[str, int] = {}
    for sector, pattern in _KEYWORDS:
        hits = len(pattern.findall(text))
        if hits:
            scores[sector] = scores.get(sector, 0) + hits

    if not scores:
        return SectorGuess("Other", "inferred", "No sector keywords matched the source.")

    best = max(scores, key=lambda s: scores[s])
    return SectorGuess(
        best, "inferred",
        f"Inferred from wording in the source, not from a filing. "
        f"{scores[best]} matching term(s).",
    )


def classify(
    *,
    sic_codes: list[str] | tuple[str, ...] | None = None,
    company: str | None = None,
    text: str | None = None,
) -> SectorGuess:
    """Filed SIC first, inference second. Never the other way round."""
    return sector_from_sic(sic_codes) or sector_from_text(company, text)
