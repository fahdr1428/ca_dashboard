"""Is this actually a prospect, or just a name that appeared near a deal?

News articles about a business sale name several people, and only one of them is
usually the person who got paid:

  * the **owner** who sold — the prospect;
  * the **buyer**, often a private equity partner, who is well served already and
    is on the other side of the table;
  * the **adviser** who ran the process, who is a route *to* the prospect rather
    than a prospect;
  * a **commentator** — an analyst, a spokesperson, a council leader, a trade
    body chief — quoted for a line of colour.

Extracting all four and calling them prospects is what makes a list feel random.
This module does two separate jobs:

  1. **Refuses** the ones who are structurally not the target, by reading the
     words around their name rather than the name itself.
  2. **Grades** the survivors into Confirmed, Corroborated and Unconfirmed, so a
     book can be filtered down to the people who have actually been checked.

The grading is deliberately harsh. A single trade-press mention of a name with no
company and no role is not a prospect, it is a lead to research — and a list that
says so is more useful than a longer list that doesn't.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

CONFIRMED, CORROBORATED, UNCONFIRMED = "Confirmed", "Corroborated", "Unconfirmed"
STATE_ORDER = (CONFIRMED, CORROBORATED, UNCONFIRMED)


# ---------------------------------------------------------------------------
# People who are structurally not the prospect
# ---------------------------------------------------------------------------

#: Context is read one sentence at a time, never by character window. "Founder
#: Priya Nadkarni has sold her stake. Partner at Meridian Capital James Fowler
#: said the company had strong fundamentals." puts the seller and the buyer 40
#: characters apart, and a fixed window refuses both — losing a real prospect to
#: catch a fake one, which is the worse trade.
_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z“\"])")

_ROLE_MARKERS: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    (
        "buy-side",
        "named as the buyer or the buyer's executive, not the seller",
        re.compile(
            r"\b(the (?:acquirer|buyer|purchaser|bidder)|which acquired|"
            r"who acquired|acquiring (?:group|company|firm)|"
            r"on behalf of the (?:buyer|acquirer)|"
            r"(?:partner|principal|director) at [A-Z][\w&'’.-]*\s+(?:Capital|Partners|Equity|Ventures)|"
            r"of the private equity (?:firm|house|group)|"
            r"private equity (?:firm|house) [A-Z][\w&'’.-]*)\b", re.I),
    ),
    (
        "adviser",
        "named as an adviser on the transaction, which makes them a route to the "
        "prospect rather than the prospect",
        re.compile(
            r"\b(advised (?:the )?(?:shareholders?|sellers?|vendors?|management|buyer)|"
            r"acted for|corporate finance (?:partner|director|adviser)|"
            r"(?:partner|associate) at [A-Z][\w&'’.-]*\s+LLP|"
            r"provided legal advice|led the (?:legal|tax|financial) team|"
            r"of the law firm|managing partner of)\b", re.I),
    ),
    (
        "commentator",
        "quoted for comment rather than named as a principal",
        re.compile(
            r"\b(a spokes(?:man|woman|person)|spokesperson for|"
            r"analyst at|chief economist|research director at|"
            r"council leader|councillor|\bMP\b|minister|mayor|"
            r"chair of the (?:chamber|trade body|association)|"
            r"chief executive of the (?:chamber|association|federation|institute)|"
            r"union (?:leader|official)|professor (?:at|of))\b", re.I),
    ),
    (
        "employee",
        "described as an employee or manager rather than an owner",
        re.compile(
            r"\b(head of (?:marketing|sales|hr|operations|communications|policy)|"
            r"site manager|plant manager|store manager|"
            r"an employee|staff representative)\b", re.I),
    ),
)


@dataclass(frozen=True)
class RoleRefusal:
    marker: str
    reason: str
    evidence: str


def refuse_by_role(text: str, name: str) -> RoleRefusal | None:
    """Is this person named as somebody other than the principal?

    Reads the clause around their name, not the whole article: "Meridian Growth
    Partners' James Fowler said the Taunton business had strong fundamentals"
    puts a private equity executive two words from a genuine prospect, and only
    the immediate context tells them apart.
    """
    if not text or not name:
        return None

    for sentence in _SENTENCE.split(text):
        if name not in sentence:
            continue
        for marker, reason, pattern in _ROLE_MARKERS:
            hit = pattern.search(sentence)
            if hit:
                return RoleRefusal(marker, reason, hit.group(0))
    return None


#: Phrases that mark the sentence as attribution rather than a wealth event.
#: "X said" on its own is not disqualifying — owners are quoted about their own
#: sales — so this is used as a *negative signal*, not a refusal.
_ATTRIBUTION = re.compile(
    r"\b(said|added|commented|told|explained|noted|according to)\b", re.I
)


# ---------------------------------------------------------------------------
# Grading the survivors
# ---------------------------------------------------------------------------


@dataclass
class Check:
    key: str
    label: str
    passed: bool
    detail: str


@dataclass
class Legitimacy:
    """How much has actually been established about this person."""

    state: str
    score: int
    checks: list[Check] = field(default_factory=list)
    #: The single thing that would move them up a tier.
    next_step: str = ""

    @property
    def is_researchable(self) -> bool:
        """Can an advisor look this person up in a company database?

        The practical test: a name with a company behind it can be found in
        Companies House, Beauhurst or any register. A name on its own cannot,
        and no amount of press coverage changes that.
        """
        return any(c.key == "company" and c.passed for c in self.checks)


def assess(
    *,
    name: str,
    job_title: str | None,
    company: str | None,
    publisher: str | None,
    source_count: int,
    register_matched: bool,
    ownership_filed: bool,
    text: str = "",
    trusted_publisher: bool = False,
) -> Legitimacy:
    """Grade one person against what is actually known about them."""
    checks: list[Check] = []

    checks.append(Check(
        "company", "Attached to a named company",
        bool(company),
        f"Named alongside {company}." if company
        else "No company was extracted, so there is nothing to look this person up "
             "against — not in Companies House, not in Beauhurst, not anywhere.",
    ))
    checks.append(Check(
        "role", "Role stated",
        bool(job_title),
        f"Described as {job_title}." if job_title
        else "No role stated in the source, so their relationship to the company is "
             "unknown — they could be the owner or a manager quoted in passing.",
    ))
    checks.append(Check(
        "register", "Matched to a company register",
        register_matched,
        "Matched to a filed Companies House record, so the person exists and the "
        "connection to the company is a matter of record."
        if register_matched
        else "Not checked against a company register. Everything known comes from "
             "press reporting.",
    ))
    checks.append(Check(
        "ownership", "Shareholding filed",
        ownership_filed,
        "A PSC entry states their shareholding band."
        if ownership_filed
        else "No filed shareholding, so any stake used in an estimate is assumed.",
    ))
    checks.append(Check(
        "corroboration", "More than one source",
        source_count >= 2,
        f"{source_count} independent sources on file."
        if source_count >= 2
        else "Single source. One article naming one person is the commonest way a "
             "prospecting list acquires somebody who was never really a prospect.",
    ))
    checks.append(Check(
        "publisher", "Reliable publisher",
        trusted_publisher,
        f"Reported by {publisher}." if trusted_publisher
        else f"{publisher or 'The publisher'} is not on the known-reliable list.",
    ))
    checks.append(Check(
        "principal", "Named as a principal, not a quote",
        not bool(_ATTRIBUTION.search(text or "")) or bool(company and job_title),
        "Named in connection with the transaction itself."
        if not _ATTRIBUTION.search(text or "") or (company and job_title)
        else "Appears in an attribution clause. They may have been quoted about "
             "someone else's transaction rather than their own.",
    ))

    passed = {c.key for c in checks if c.passed}
    score = int(round(100 * len(passed) / len(checks)))

    if register_matched:
        state = CONFIRMED
    elif "company" in passed and "role" in passed and (
        "corroboration" in passed or "publisher" in passed
    ):
        state = CORROBORATED
    else:
        state = UNCONFIRMED

    if state == CONFIRMED and not ownership_filed:
        next_step = (
            "Confirmed as a real person at a real company. Pull the PSC register "
            "entry to replace the assumed stake with a filed band."
        )
    elif "company" not in passed:
        next_step = (
            "Identify the company before anything else. Without it this name cannot "
            "be looked up in any register or company database."
        )
    elif not register_matched:
        next_step = (
            f"Search Companies House for {company} and confirm {name} appears in its "
            f"filings. That single check moves this record from press-derived to "
            f"register-confirmed."
        )
    elif "corroboration" not in passed:
        next_step = "Find a second independent source before making contact."
    else:
        next_step = "Nothing outstanding — this record is as evidenced as it gets."

    return Legitimacy(state=state, score=score, checks=checks, next_step=next_step)


#: The default the prospect list opens on. Unconfirmed records still exist and
#: are still visible — in their own queue, described as what they are — but they
#: do not sit in the working book pretending to be qualified prospects.
DEFAULT_VISIBLE_STATES: tuple[str, ...] = (CONFIRMED, CORROBORATED)
