"""The advisor's own research, feeding back into the book.

The sweep finds candidates; people confirm them. Until now nothing an advisor
learned — a company number looked up, an officer confirmed, a second article
found, a list pulled from a research platform — could go back into the app, so
the book was only ever as good as the headlines. This module is the way back in.

Everything entered here goes through the same path as the sweep: the same
exclusion screen, the same refusal of buyers and commentators, the same
verification tiers. Hand-entered is not the same as unchecked.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlparse

from . import db
from .exclusions import screen
from .extract import ExtractedEvent, Person, parse_money
from .legitimacy import refuse_by_role
from .markets import MARKET_BY_KEY, market_for_place
from .queries import EVENT_BY_KEY
from .research import _refresh_corroboration, _store_event
from .sources import Fetcher

CH_PROFILE = "https://find-and-update.company-information.service.gov.uk/company/"

#: England & Wales numbers are eight digits; Scotland, Northern Ireland and LLPs
#: carry a two-letter prefix (SC, NI, OC, SO, NC, R…).
_CH_NUMBER = re.compile(r"^(?:[A-Z]{2}\d{6}|\d{8})$")


def normalise_company_number(raw: str | None) -> str | None:
    """"7890123" → "07890123"; "sc 123456" → "SC123456"; junk → None."""
    if not raw:
        return None
    cleaned = re.sub(r"\s+", "", str(raw)).upper()
    if cleaned.isdigit() and len(cleaned) < 8:
        cleaned = cleaned.zfill(8)
    return cleaned if _CH_NUMBER.match(cleaned) else None


def _valid_url(url: str | None) -> bool:
    if not url:
        return False
    parsed = urlparse(url.strip())
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _publisher_for(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


# ---------------------------------------------------------------------------
# Verifying a record by hand
# ---------------------------------------------------------------------------


@dataclass
class VerificationResult:
    ok: bool
    message: str
    new_state: str | None = None


def verify_manually(
    prospect_id: int,
    *,
    verified_by: str,
    company_number: str | None = None,
    officer_confirmed: bool = False,
    ownership_band: str | None = None,
    second_source_url: str | None = None,
    second_source_title: str | None = None,
    note: str | None = None,
) -> VerificationResult:
    """Apply what the advisor checked, and re-grade the record from it.

    Confirming someone as an officer requires the company number that the check
    was made against. "I looked them up" with nothing recorded is not an audit
    trail, and it is the audit trail that makes Confirmed mean something.
    """
    if not verified_by.strip():
        return VerificationResult(False, "Say who checked it — the record keeps the name.")

    number = normalise_company_number(company_number)
    if company_number and not number:
        return VerificationResult(
            False,
            f"“{company_number}” is not a Companies House number. It should be eight "
            f"digits, or two letters and six digits for Scottish, Northern Irish and "
            f"LLP registrations.",
        )
    if officer_confirmed and not number:
        return VerificationResult(
            False,
            "Enter the company number the officer was confirmed against — it is what "
            "makes the confirmation checkable by someone else.",
        )
    if second_source_url and not _valid_url(second_source_url):
        return VerificationResult(False, "The second source must be a full web address.")

    band = (ownership_band or "").strip() or None
    with db.connect() as conn:
        row = db.prospect(conn, prospect_id)
        if row is None:
            return VerificationResult(False, "That record no longer exists.")
        if row["suppressed_at"]:
            return VerificationResult(False, "That record is suppressed and cannot be edited.")

        changes: list[str] = []
        if number:
            profile = CH_PROFILE + number
            updates = {
                "ch_company_number": number,
                "company_number": number,
                "ch_profile_url": profile,
            }
            if officer_confirmed:
                updates.update({
                    "ch_officer_name": row["full_name"],
                    "ch_verified_at": db.now_iso(),
                    "evidence_grade": "High",
                    "evidence_basis": (
                        f"Confirmed by {verified_by} against the Companies House record "
                        f"for company {number}."
                    ),
                })
                if band:
                    updates["ch_ownership_band"] = band
            assignments = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE prospects SET {assignments}, last_updated = ? WHERE id = ?",
                (*updates.values(), db.now_iso(), prospect_id),
            )
            db.add_source(conn, prospect_id, {
                "url": profile,
                "title": f"Companies House record {number}",
                "publisher": "Companies House",
                "event_label": "Statutory filing",
                "rationale": f"Checked by {verified_by}."
                             + (f" {note}" if note else ""),
            })
            changes.append(
                f"confirmed as an officer of company {number}" if officer_confirmed
                else f"company number {number} recorded"
            )
            if band and officer_confirmed:
                changes.append(f"shareholding band {band} from the PSC register")

        if second_source_url:
            added = db.add_source(conn, prospect_id, {
                "url": second_source_url.strip(),
                "title": (second_source_title or "").strip() or "Second source added by hand",
                "publisher": _publisher_for(second_source_url),
                "rationale": f"Added by {verified_by}.",
            })
            if added:
                changes.append("second source added")

        if not changes:
            return VerificationResult(False, "Nothing to record — enter at least one check.")

        _refresh_corroboration(conn, prospect_id)
        state = db.prospect(conn, prospect_id)["verification_state"]
        db.add_event(
            conn, prospect_id, "verified",
            f"Verified by {verified_by}: {'; '.join(changes)}.", note,
        )
    return VerificationResult(
        True, f"Recorded: {'; '.join(changes)}. The record is now {state}.", state,
    )


# ---------------------------------------------------------------------------
# Adding a person by hand
# ---------------------------------------------------------------------------


@dataclass
class AddResult:
    ok: bool
    message: str
    prospect_ids: list[int] = field(default_factory=list)
    lead: bool = False


def add_prospect(
    *,
    full_name: str | None,
    source_url: str | None,
    market_key: str | None = None,
    location: str | None = None,
    company: str | None = None,
    job_title: str | None = None,
    event_key: str = "business_exit",
    amount_text: str | None = None,
    source_title: str | None = None,
    added_by: str = "",
    allow_unlinked_source: bool = False,
    source_label: str | None = None,
) -> AddResult:
    """A person found outside the sweep, entered through the sweep's own path.

    A source is required. The whole book rests on every record pointing at
    something someone else can check, and a hand-entered record is exactly the
    one most likely to be remembered rather than evidenced. Imports may carry a
    platform reference instead (``allow_unlinked_source``), and are labelled as
    such.
    """
    name = " ".join((full_name or "").split())
    company = " ".join((company or "").split()) or None
    url = (source_url or "").strip()

    if not name and not company:
        return AddResult(False, "A name or a company is needed.")
    if not _valid_url(url):
        if not allow_unlinked_source:
            return AddResult(
                False,
                "Add the web address of the source. Every record points at something "
                "someone else can check — that is what makes the book trustworthy.",
            )
        url = f"import://{source_label or 'manual'}/{db.slugify(name or company or 'row')}"

    # A location on the row beats the default: an import of fifty companies is
    # rarely all in one county.
    market = market_for_place(location) if location else None
    if market is None:
        market = MARKET_BY_KEY.get(market_key or "")
    if market is None:
        return AddResult(False, f"Could not place “{location or '—'}” in a known market.")

    template = EVENT_BY_KEY.get(event_key) or EVENT_BY_KEY["business_exit"]
    title = (source_title or "").strip() or (
        f"{name or company} — {template.label.lower()}"
        + (f" ({company})" if company and name else "")
    )
    text = f"{title}. {job_title or ''} {name} {company or ''}"

    refusal = screen(text=text, person_name=name or None, job_title=job_title, url=url)
    if refusal is not None:
        return AddResult(False, f"Not added: {refusal.reason}")
    if name:
        role_refusal = refuse_by_role(title, name)
        if role_refusal is not None:
            return AddResult(
                False, f"Not added: {name} is {role_refusal.reason} — “{role_refusal.evidence}”."
            )

    publisher = source_label or _publisher_for(url) or "Added by hand"
    event = ExtractedEvent(
        event_key=template.key,
        event_label=template.label,
        weight=template.weight,
        market_key=market.key,
        market_name=market.name,
        market_group=market.group,
        country=market.country,
        matched_place=location or market.name,
        # The advisor states where they are, which is evidence, not inference.
        market_source="text",
        locality=(location or None) if location and location != market.name else None,
        amount_gbp=parse_money(amount_text or ""),
        people=[Person(name=name, title=(job_title or "").strip())] if name else [],
        company=company,
        title=title,
        summary="",
        url=url,
        publisher=publisher,
        published_at=datetime.now(timezone.utc),
        rationale=f"Added by {added_by or 'an advisor'}"
                  + (f" from {source_label}" if source_label else "") + ".",
    )

    outcome = _store_event(event, fetcher=Fetcher(delay=0.0), verify_ch=False)

    if outcome["kind"] == "company_lead":
        return AddResult(True, f"{company} added to Find the owner — no person named.",
                         lead=True)
    ids = [int(i) for i in outcome.get("prospect_ids", [])]
    with db.connect() as conn:
        for prospect_id in ids:
            db.add_event(conn, prospect_id, "added",
                         f"Added by {added_by or 'an advisor'}.", url)
    verb = "Added" if outcome["kind"] == "new" else "Matched to an existing record and added a source for"
    return AddResult(True, f"{verb} {outcome['name']}.", ids)


# ---------------------------------------------------------------------------
# Importing a list
# ---------------------------------------------------------------------------

#: Header names seen in company-database exports, lower-cased, per field. The
#: first match wins, so the more specific names come first.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "full_name": ("full name", "person name", "person", "name", "director",
                  "director name", "contact", "contact name", "founder", "officer"),
    "company": ("company name", "company", "organisation", "organization",
                "business", "business name", "registered name", "entity"),
    "job_title": ("job title", "role", "title", "position", "person role"),
    "company_number": ("companies house number", "companies house id",
                       "company number", "registration number", "crn",
                       "company registration number", "ch number"),
    "location": ("location", "town", "city", "region", "county", "registered address",
                 "address", "hq location", "headquarters"),
    "source_url": ("source url", "url", "source", "link", "beauhurst url",
                   "profile url", "website"),
    "amount": ("deal value", "amount", "value", "transaction value",
               "total funding received", "latest valuation", "valuation"),
}


def guess_mapping(columns: list[str]) -> dict[str, str | None]:
    """Match an export's columns to the fields the book needs."""
    lowered = {c.strip().lower(): c for c in columns}
    mapping: dict[str, str | None] = {}
    used: set[str] = set()
    for field_name, aliases in FIELD_ALIASES.items():
        mapping[field_name] = None
        for alias in aliases:
            original = lowered.get(alias)
            if original and original not in used:
                mapping[field_name] = original
                used.add(original)
                break
    return mapping


@dataclass
class ImportSummary:
    added: int = 0
    matched: int = 0
    leads: int = 0
    refused: list[str] = field(default_factory=list)


def import_rows(
    rows: list[dict],
    mapping: dict[str, str | None],
    *,
    source_label: str,
    default_market_key: str | None,
    event_key: str = "business_exit",
    added_by: str = "",
) -> ImportSummary:
    """Every row through the same screening and grading as the sweep."""
    summary = ImportSummary()

    def get(row: dict, field_name: str) -> str | None:
        column = mapping.get(field_name)
        if not column:
            return None
        value = row.get(column)
        if value is None:
            return None
        text = str(value).strip()
        return None if text.lower() in ("", "nan", "none", "null") else text

    for index, row in enumerate(rows, start=1):
        result = add_prospect(
            full_name=get(row, "full_name"),
            company=get(row, "company"),
            job_title=get(row, "job_title"),
            source_url=get(row, "source_url"),
            market_key=default_market_key,
            location=get(row, "location"),
            event_key=event_key,
            amount_text=get(row, "amount"),
            added_by=added_by,
            allow_unlinked_source=True,
            source_label=source_label,
        )
        label = get(row, "full_name") or get(row, "company") or f"row {index}"
        if not result.ok:
            summary.refused.append(f"Row {index} ({label}): {result.message}")
            continue
        if result.lead:
            summary.leads += 1
        elif result.message.startswith("Added"):
            summary.added += len(result.prospect_ids) or 1
        else:
            summary.matched += 1

        number = normalise_company_number(get(row, "company_number"))
        if number:
            for prospect_id in result.prospect_ids:
                verify_manually(
                    prospect_id, verified_by=f"import: {source_label}",
                    company_number=number, officer_confirmed=False,
                )
    return summary
