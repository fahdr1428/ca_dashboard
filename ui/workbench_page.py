"""Add & import: the advisor's own research, back into the book.

A person met at a dinner, a name from a colleague, a list exported from a
company database — all of it goes through the same screen, the same refusal of
buyers and commentators, and the same verification tiers as the sweep.
"""

from __future__ import annotations

import io
import re

import pandas as pd
import streamlit as st

from wealthscan.markets import ALL_MARKETS, MARKET_BY_KEY, TARGET_PROFILE_KEYS
from wealthscan.queries import EVENT_BY_KEY, EVENT_TEMPLATES
from wealthscan.workbench import FIELD_ALIASES, add_prospect, guess_mapping, import_rows

from .common import guarded, refresh

FIELD_LABELS = {
    "full_name": "Person's name",
    "company": "Company",
    "job_title": "Role",
    "company_number": "Companies House number",
    "location": "Location (town or county)",
    "source_url": "Source web address",
    "amount": "Deal value / amount",
}

_MARKET_KEYS = list(TARGET_PROFILE_KEYS) + sorted(
    (m.key for m in ALL_MARKETS if m.key not in TARGET_PROFILE_KEYS),
    key=lambda k: MARKET_BY_KEY[k].name,
)

_ROW_NUMBER = re.compile(r"^Row (\d+)")

TEMPLATE_CSV = (
    "Person name,Company name,Role,Company number,Location,Source URL,Deal value\n"
    "Jane Example,Example Engineering Ltd,Founder,01234567,Bath,"
    "https://www.example.com/news/example-engineering-sold,£24m\n"
)


def read_upload(raw: bytes) -> pd.DataFrame:
    """A CSV as exported by Excel, a research platform, or this app.

    Excel writes a byte-order mark and sometimes Windows-1252; this app's own
    exports start with ``#`` notes. Only *leading* ``#`` lines are dropped — a
    ``#`` inside a value ("Unit #3") is data.
    """
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - cp1252 decodes almost anything
        text = raw.decode("latin-1")
    lines = text.splitlines()
    while lines and lines[0].lstrip().startswith("#"):
        lines.pop(0)
    return pd.read_csv(io.StringIO("\n".join(lines)), dtype=str)


def page_workbench() -> None:
    st.title("Add & import")
    st.caption(
        "Bring in people the sweep did not find. Everything entered here is screened "
        "and graded exactly like the sweep's own finds — a hand-entered name gets no "
        "special treatment, and one without a source is refused."
    )

    tabs = st.tabs(["Add one person", "Import a list (CSV)"])
    with tabs[0], guarded("The add form"):
        _add_one()
    with tabs[1], guarded("The importer"):
        _import_list()


def _add_one() -> None:
    with st.form("add_one", clear_on_submit=False):
        top = st.columns(3)
        name = top[0].text_input("Person's name", placeholder="e.g. Jane Example")
        role = top[1].text_input("Role", placeholder="Founder, managing director…")
        company = top[2].text_input("Company", placeholder="Example Engineering Ltd")

        mid = st.columns(3)
        location = mid[0].text_input(
            "Where they are", placeholder="Town or county, e.g. Bath",
            help="A town or county. It is matched to one of the app's markets.",
        )
        market = mid[1].selectbox(
            "…or pick the market", [""] + _MARKET_KEYS,
            format_func=lambda k: "—" if not k else MARKET_BY_KEY[k].name,
            help="Used only when the location above is empty or not recognised.",
        )
        event = mid[2].selectbox(
            "What happened", [t.key for t in EVENT_TEMPLATES],
            format_func=lambda k: EVENT_BY_KEY[k].label,
        )

        low = st.columns([2, 2, 1])
        url = low[0].text_input("Source web address", placeholder="https://…")
        title = low[1].text_input("Its headline (optional)")
        amount = low[2].text_input("Amount (optional)", placeholder="£24m")
        who = st.text_input("Added by", placeholder="Your initials")

        submitted = st.form_submit_button("Add to the book", type="primary")

    if submitted:
        result = add_prospect(
            full_name=name, company=company or None, job_title=role or None,
            location=location or None, market_key=market or None, event_key=event,
            amount_text=amount or None, source_url=url, source_title=title or None,
            added_by=who,
        )
        if result.ok:
            refresh()
            st.success(result.message + " Open **Prospect list** to see the record.")
        else:
            st.warning(result.message)


def _import_list() -> None:
    st.markdown(
        "Upload a CSV — for example an export from Beauhurst, a spreadsheet of "
        "introductions, or a list from a colleague. Columns are matched automatically; "
        "check the matching before importing."
    )
    st.download_button(
        "Download a template", data=TEMPLATE_CSV, file_name="import-template.csv",
        mime="text/csv",
    )
    upload = st.file_uploader("CSV file", type=["csv"])
    if upload is None:
        return

    try:
        frame = read_upload(upload.getvalue())
    except Exception as error:  # noqa: BLE001 - a bad file is the user's input, not a crash
        st.error(f"That file could not be read as CSV ({error}).")
        return
    if frame.empty:
        st.warning("The file has no rows.")
        return

    st.caption(f"{len(frame)} rows, {len(frame.columns)} columns.")
    st.dataframe(frame.head(8).fillna(""), hide_index=True, width="stretch")

    guessed = guess_mapping(list(frame.columns))
    options = [""] + list(frame.columns)
    st.markdown("**Match the columns**")
    mapping: dict[str, str | None] = {}
    columns = st.columns(4)
    for index, field_name in enumerate(FIELD_ALIASES):
        default = guessed.get(field_name) or ""
        chosen = columns[index % 4].selectbox(
            FIELD_LABELS[field_name], options,
            index=options.index(default) if default in options else 0,
            format_func=lambda c: "— not in this file —" if not c else c,
            key=f"map_{field_name}",
        )
        mapping[field_name] = chosen or None

    if not (mapping["full_name"] or mapping["company"]):
        st.warning("Match at least a person or a company column.")
        return

    settings = st.columns(3)
    label = settings[0].text_input(
        "Where the list came from", value="Beauhurst export",
        help="Shown as the source on every imported record.",
    )
    default_market = settings[1].selectbox(
        "Market when a row has no location", [""] + _MARKET_KEYS,
        format_func=lambda k: "— refuse the row —" if not k else MARKET_BY_KEY[k].name,
    )
    event = settings[2].selectbox(
        "What the list represents", [t.key for t in EVENT_TEMPLATES],
        format_func=lambda k: EVENT_BY_KEY[k].label,
    )
    who = st.text_input("Imported by", placeholder="Your initials", key="import_by")

    st.caption(
        "Rows without a web source are kept and labelled as coming from this list. "
        "Rows naming only a company go to **Find the owner**. A Companies House number "
        "on a row is recorded against the person, which moves them towards Confirmed."
    )
    if st.button(f"Import {len(frame)} rows", type="primary"):
        rows = frame.to_dict(orient="records")
        progress = st.progress(0.0, text="Importing…")
        # In chunks so a long list shows progress rather than a frozen page.
        totals = {"added": 0, "matched": 0, "leads": 0, "refused": []}
        chunk = 25
        for start in range(0, len(rows), chunk):
            summary = import_rows(
                rows[start:start + chunk], mapping, source_label=label or "import",
                default_market_key=default_market or None, event_key=event, added_by=who,
            )
            totals["added"] += summary.added
            totals["matched"] += summary.matched
            totals["leads"] += summary.leads
            # import_rows numbers rows within the chunk; restate them in file terms.
            totals["refused"].extend(
                _ROW_NUMBER.sub(lambda m, s=start: f"Row {int(m.group(1)) + s}", line, 1)
                for line in summary.refused
            )
            progress.progress(min(1.0, (start + chunk) / len(rows)),
                              text=f"Imported {min(len(rows), start + chunk)} of {len(rows)}")
        refresh()
        result = st.columns(4)
        result[0].metric("New people", totals["added"])
        result[1].metric("Matched to existing", totals["matched"])
        result[2].metric("Company-only leads", totals["leads"])
        result[3].metric("Refused", len(totals["refused"]))
        if totals["refused"]:
            count = len(totals["refused"])
            with st.expander(f"Why {count} row{'s were' if count != 1 else ' was'} refused"):
                for line in totals["refused"]:
                    st.text(line)
