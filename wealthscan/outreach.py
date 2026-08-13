"""How to reach a prospect, and how not to.

The honest answer to "can you find me their email" is no, and the reason is worth
stating rather than burying:

  * **Guessed addresses are wrong addresses.** Permuting
    firstname.lastname@company.com produces mail that reaches somebody — often a
    different real person at the same firm, sometimes a shared inbox, sometimes a
    bounce that tells a mail filter the sender guesses. None of those outcomes is
    the one intended.
  * **A personal inbox is not a business contact.** UK GDPR treats corporate
    subscribers and individual subscribers differently, and PECR bites hardest on
    unsolicited electronic mail to individuals. A registered office and a
    published switchboard are contact details the organisation *chose* to
    publish; a personal address is not.
  * **Residential addresses are protected on purpose.** Companies House suppresses
    directors' home addresses, and reconstructing one for cold outreach is the
    kind of thing that ends a firm's relationship with its regulator.

So this module builds the routes that *do* work, ranked by how warm they are. The
best of them is not a contact detail at all: it is the adviser who just handled
the transaction. Corporate finance houses, law firms and accountants are named in
deal announcements precisely so that people know who did the work, they already
have the client's trust, and an introduction from one is worth more than any
number of guessed inboxes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Advisers named in the announcement
# ---------------------------------------------------------------------------

#: Firm names run to several capitalised words and often contain "&", "LLP" or a
#: comma-separated partnership name.
_FIRM = r"[A-Z][\w&'’.-]*(?:\s+(?:&\s+)?[A-Z][\w&'’.-]*){0,4}(?:\s+LLP|\s+LLP\.)?"

def _ci(text: str) -> str:
    """Case-insensitive literal.

    Built into the cue words rather than set as a flag, because `re.I` would also
    apply to `_FIRM` and let `[A-Z]` match lowercase — which turns "advised by the
    board" into a firm called "the board".
    """
    return "".join(
        f"[{c.lower()}{c.upper()}]" if c.isalpha() else re.escape(c) for c in text
    )


_ADVISER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Corporate finance", re.compile(
        rf"\b(?:{_ci('corporate finance')} (?:{_ci('advice')}|{_ci('adviser')}|"
        rf"{_ci('advisor')}|{_ci('team')}) (?:{_ci('was')} )?(?:{_ci('provided')} )?"
        rf"(?:{_ci('by')}|{_ci('from')})|{_ci('advised by')})\s+({_FIRM})")),
    # "X advised the shareholders" states the side but not the discipline, so the
    # role is left open rather than guessed — a law firm and a corporate finance
    # house both "act for the sellers".
    ("Adviser (discipline not stated)", re.compile(
        rf"\b({_FIRM})\s+(?:{_ci('advised')}|{_ci('acted for')}|{_ci('acted on behalf of')})"
        rf"\s+(?:{_ci('the')}\s+)?(?:{_ci('shareholders')}|{_ci('shareholder')}|"
        rf"{_ci('sellers')}|{_ci('seller')}|{_ci('vendors')}|{_ci('vendor')}|"
        rf"{_ci('management')}|{_ci('founders')}|{_ci('founder')}|{_ci('owners')}|"
        rf"{_ci('owner')}|{_ci('company')})")),
    ("Legal", re.compile(
        rf"\b(?:{_ci('legal')} (?:{_ci('advice')}|{_ci('counsel')}|{_ci('adviser')}|"
        rf"{_ci('advisor')}) (?:{_ci('was')} )?(?:{_ci('provided')} )?"
        rf"(?:{_ci('by')}|{_ci('from')})|{_ci('lawyers')}\s+(?:{_ci('were')}\s+)?)"
        rf"\s*({_FIRM})")),
    ("Legal", re.compile(rf"\b({_FIRM})\s+{_ci('provided legal advice')}")),
    ("Accountancy or tax", re.compile(
        rf"\b(?:{_ci('tax')} (?:{_ci('advice')}|{_ci('adviser')}) (?:{_ci('was')} )?"
        rf"(?:{_ci('provided')} )?(?:{_ci('by')}|{_ci('from')})|"
        rf"{_ci('accountants')}\s+(?:{_ci('were')}\s+)?|"
        rf"{_ci('due diligence')} (?:{_ci('was')} )?(?:{_ci('provided')} )?{_ci('by')})"
        rf"\s*({_FIRM})")),
    ("Debt or banking", re.compile(
        rf"\b(?:{_ci('funding')}|{_ci('debt facility')}|{_ci('banking facilities')}|"
        rf"{_ci('debt package')})\s+(?:{_ci('was')} |{_ci('were')} )?"
        rf"(?:{_ci('provided')} |{_ci('arranged')} )?{_ci('by')}\s+({_FIRM})")),
)

#: Words that mean the capitalised phrase is not a firm name.
_NOT_A_FIRM = frozenset({
    "the", "a", "an", "its", "his", "her", "their", "our", "this", "that",
    "management", "shareholders", "sellers", "vendors", "founders", "owners",
    "company", "business", "group", "board", "team", "buyer", "purchaser",
})


@dataclass(frozen=True)
class Adviser:
    firm: str
    role: str


def extract_advisers(text: str) -> list[Adviser]:
    """Professional firms named in a transaction announcement.

    These are the warm route. A corporate finance partner who has just banked a
    client's exit is the single most useful introduction an advisor can get, and
    the firm's name is in the press release for exactly that reason.
    """
    found: list[Adviser] = []
    seen: set[str] = set()

    for role, pattern in _ADVISER_PATTERNS:
        for match in pattern.finditer(text or ""):
            firm = " ".join(match.group(1).split())
            # A full stop followed by a space ends the sentence, not the firm
            # name. Without this, "…by Ashfords Corporate Finance. Legal advice…"
            # yields a firm called "Ashfords Corporate Finance. Legal".
            firm = re.split(r"\.\s", firm)[0].strip(" ,.;:")
            words = firm.split()
            if not words or words[0].lower() in _NOT_A_FIRM:
                continue
            # A single capitalised word is as likely to be a sentence start.
            if len(words) < 2 and not firm.upper() == firm:
                continue
            key = firm.lower()
            if key in seen:
                continue
            seen.add(key)
            found.append(Adviser(firm=firm, role=role))

    return found[:4]


# ---------------------------------------------------------------------------
# Contact routes
# ---------------------------------------------------------------------------


@dataclass
class Route:
    """One way to reach a prospect, with its warmth and its caveat."""

    kind: str
    label: str
    detail: str
    #: 1 = warmest. Ranking is the whole point: an advisor should try the
    #: introduction before the switchboard, not work down a list of addresses.
    warmth: int
    url: str | None = None
    caution: str | None = None


#: Company-name shapes that mean the vehicle is the family's own investment
#: entity — which is both the contact point and a strong signal of realised
#: wealth looking for a home.
FAMILY_OFFICE_MARKERS = (
    "family office", "family investment", "family holdings", "family trust",
    "investments limited", "investments ltd", "holdings limited", "capital llp",
)


def looks_like_family_office(company: str | None) -> bool:
    if not company:
        return False
    lowered = company.lower()
    return any(marker in lowered for marker in FAMILY_OFFICE_MARKERS)


def contact_routes(record: dict) -> list[Route]:
    """Every lawful way to reach this person, warmest first.

    ``record`` is a prospect row. Nothing here is inferred: each route is either
    something the organisation published itself, something filed at Companies
    House, or a search the advisor runs by hand.
    """
    routes: list[Route] = []
    name = str(record.get("full_name") or "").strip()
    company = record.get("company") or record.get("ch_company_name")
    query_name = name.replace(" ", "+")

    adviser = record.get("known_adviser")
    if adviser:
        routes.append(Route(
            kind="adviser",
            label="Introduction through their adviser",
            detail=(
                f"{adviser} acted on the transaction. They have the relationship and "
                f"the client's trust, and a warm introduction from them is worth more "
                f"than any direct approach."
            ),
            warmth=1,
            caution=(
                "Approach the firm, not the client, and expect to give a reason why "
                "the introduction helps their client rather than you."
            ),
        ))

    if looks_like_family_office(company):
        routes.append(Route(
            kind="family-office",
            label="Their family office or investment vehicle",
            detail=(
                f"{company} looks like the family's own investment entity. That is "
                f"both the correct place to write and a signal that realised wealth is "
                f"already being managed somewhere."
            ),
            warmth=2,
            caution="Find out who already advises the vehicle before approaching it.",
        ))

    office = record.get("ch_registered_office") or record.get("address")
    if office:
        routes.append(Route(
            kind="registered-office",
            label="Registered office",
            detail=f"{office}",
            warmth=3,
            url=record.get("ch_profile_url"),
            caution=(
                "This is the company's filed address, not a home address, and must "
                "never be treated as one. Address correspondence to them in their "
                "capacity as a director."
            ),
        ))

    if record.get("ch_company_number"):
        routes.append(Route(
            kind="companies-house",
            label="Companies House record",
            detail=(
                f"Company {record['ch_company_number']}"
                + (f" — {record['ch_company_name']}" if record.get("ch_company_name") else "")
                + ". Officers' correspondence addresses and other appointments are "
                  "filed here, and other appointments often reveal a better route in."
            ),
            warmth=4,
            url=record.get("ch_profile_url"),
        ))

    if company:
        routes.append(Route(
            kind="switchboard",
            label="The company's own published contact details",
            detail=(
                f"Find {company}'s website and use the contact details it publishes — "
                f"a switchboard number or a general enquiries address that the business "
                f"chose to make public."
            ),
            warmth=5,
            url=f"https://duckduckgo.com/?q={str(company).replace(' ', '+')}+contact",
            caution=(
                "Corporate contact details only. A general enquiries inbox is a "
                "business contact; an individual's personal address is not."
            ),
        ))

    if name:
        routes.append(Route(
            kind="officer-search",
            label="Their other directorships",
            detail=(
                "Their other appointments frequently include a trade body, a charity "
                "or a joint venture where you already know somebody."
            ),
            warmth=6,
            url=(
                "https://find-and-update.company-information.service.gov.uk/"
                f"search/officers?q={query_name}"
            ),
        ))
        routes.append(Route(
            kind="professional-network",
            label="Shared connections",
            detail=(
                "Check by hand for a mutual connection before any cold approach. This "
                "app never automates LinkedIn — its User Agreement prohibits scraping."
            ),
            warmth=7,
            url=f"https://www.linkedin.com/search/results/people/?keywords={query_name}",
        ))

    return sorted(routes, key=lambda r: r.warmth)


#: Stated in the interface rather than silently omitted, so nobody assumes the
#: feature is missing rather than declined.
REFUSED_ROUTES: tuple[tuple[str, str], ...] = (
    (
        "Personal email addresses",
        "Not guessed, not bought, not harvested. Permuted addresses reach other "
        "real people at the same firm, and unsolicited mail to an individual "
        "subscriber is exactly what PECR restricts. Use the company's published "
        "enquiries address, or the adviser.",
    ),
    (
        "Home addresses",
        "Companies House suppresses directors' residential addresses deliberately. "
        "Reconstructing one for cold outreach is a privacy harm and a regulatory "
        "problem, whatever the commercial case.",
    ),
    (
        "Personal mobile numbers",
        "Same reasoning as personal email, with a lower tolerance from the person "
        "on the other end.",
    ),
    (
        "Automated LinkedIn lookups",
        "Its User Agreement prohibits scraping. The app generates a search link "
        "for you to open by hand instead.",
    ),
)
