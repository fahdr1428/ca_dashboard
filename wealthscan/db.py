"""SQLite storage.

SQLite because it removes an entire class of setup problem: no server to
install, no connection string, no credentials, nothing to provision before the
app will start. The whole book lives in one file you can copy or back up.

Schema notes:
  * Provenance is not optional. Every prospect has at least one row in
    `sources`, and estimates carry the method text that produced them.
  * `runs` and `events` are append-only, so the weekly report can always say
    what changed and when it was found.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH
from .markets import MARKET_BY_NAME

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospects (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                 TEXT UNIQUE NOT NULL,
    full_name            TEXT NOT NULL,
    job_title            TEXT,
    company              TEXT,
    -- Where they are. market_* is the searchable geography; locality and
    -- address are the specific detail an advisor actually needs.
    market_key           TEXT NOT NULL,
    market_name          TEXT NOT NULL,
    market_group         TEXT,
    country              TEXT,
    -- 'text' when the article named the place, 'query' when the market was
    -- inherited from the search that found it. Never collapsed into one field:
    -- an inherited location is a weaker claim and has to look like one.
    market_source        TEXT NOT NULL DEFAULT 'text',
    locality             TEXT,
    address              TEXT,
    matched_place        TEXT,
    -- Wealth figures are nullable on purpose: NULL means "could not be
    -- estimated", which is different from zero and must never be shown as zero.
    gross_low_gbp        INTEGER,
    gross_mid_gbp        INTEGER,
    gross_high_gbp       INTEGER,
    investable_low_gbp   INTEGER,
    investable_mid_gbp   INTEGER,
    investable_high_gbp  INTEGER,
    wealth_band          TEXT NOT NULL DEFAULT 'Not estimated',
    cohort               TEXT NOT NULL DEFAULT 'Research lead',
    estimate_method      TEXT,
    estimate_caveats     TEXT,
    not_estimated_reason TEXT,
    confidence           INTEGER NOT NULL DEFAULT 0,
    confidence_band      TEXT NOT NULL DEFAULT 'Low',
    confidence_detail    TEXT,
    next_action          TEXT,
    rationale            TEXT,
    primary_event        TEXT,
    -- Companies House verification is a bonus, applied after the fact.
    ch_company_number    TEXT,
    ch_company_name      TEXT,
    ch_officer_name      TEXT,
    ch_ownership_band    TEXT,
    ch_registered_office TEXT,
    ch_profile_url       TEXT,
    ch_verified_at       TEXT,
    status               TEXT NOT NULL DEFAULT 'New',
    relationship_stage   TEXT NOT NULL DEFAULT 'Unaware',
    owner                TEXT,
    notes                TEXT,
    first_seen           TEXT NOT NULL,
    last_updated         TEXT NOT NULL,
    first_seen_week      TEXT NOT NULL,
    suppressed_at        TEXT,
    suppression_reason   TEXT
);

CREATE TABLE IF NOT EXISTS sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id  INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL,
    publisher    TEXT,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    event_key    TEXT,
    event_label  TEXT,
    amount_gbp   INTEGER,
    excerpt      TEXT,
    rationale    TEXT,
    UNIQUE (prospect_id, url)
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    message     TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    week           TEXT NOT NULL,
    trigger        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'running',
    depth          TEXT,
    markets        TEXT,
    queries_run    INTEGER NOT NULL DEFAULT 0,
    queries_planned INTEGER NOT NULL DEFAULT 0,
    articles_seen  INTEGER NOT NULL DEFAULT 0,
    events_kept    INTEGER NOT NULL DEFAULT 0,
    new_prospects  INTEGER NOT NULL DEFAULT 0,
    updated_prospects INTEGER NOT NULL DEFAULT 0,
    company_leads  INTEGER NOT NULL DEFAULT 0,
    warnings       TEXT,
    log            TEXT
);

CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week         TEXT UNIQUE NOT NULL,
    generated_at TEXT NOT NULL,
    markdown     TEXT NOT NULL,
    payload      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_urls (
    url        TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prospects_market ON prospects(market_key);
CREATE INDEX IF NOT EXISTS idx_prospects_country ON prospects(country);
CREATE INDEX IF NOT EXISTS idx_prospects_investable ON prospects(investable_mid_gbp);
CREATE INDEX IF NOT EXISTS idx_prospects_week ON prospects(first_seen_week);
CREATE INDEX IF NOT EXISTS idx_sources_prospect ON sources(prospect_id);
"""

#: Columns added after the first release. Existing databases get them with an
#: ALTER rather than being thrown away.
ADDED_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "prospects": (
        ("market_group", "TEXT"),
        ("country", "TEXT"),
        ("market_source", "TEXT NOT NULL DEFAULT 'text'"),
        ("locality", "TEXT"),
        ("address", "TEXT"),
        ("ch_company_name", "TEXT"),
        ("ch_registered_office", "TEXT"),
        ("ch_profile_url", "TEXT"),
    ),
    "runs": (
        ("depth", "TEXT"),
        ("markets", "TEXT"),
        ("queries_planned", "INTEGER NOT NULL DEFAULT 0"),
        ("company_leads", "INTEGER NOT NULL DEFAULT 0"),
    ),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_week(when: datetime | None = None) -> str:
    """ISO week label, e.g. ``2026-W32``. The unit the whole app works in."""
    moment = when or datetime.now(timezone.utc)
    year, week, _ = moment.isocalendar()
    return f"{year}-W{week:02d}"


@contextmanager
def connect(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    target = Path(path or DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [row["name"] for row in conn.execute(f"PRAGMA table_info({table})")]
    except sqlite3.Error:
        return []


def _rebuild_prospects(conn: sqlite3.Connection) -> None:
    """Move a `region`-based table onto the market model, keeping the records.

    The 13 original counties are all markets in their own right, so a legacy
    region maps straight across. Done as a rename-and-copy with foreign keys off,
    because dropping the parent table with them on would cascade the sources and
    events away.
    """
    legacy = _columns(conn, "prospects")
    conn.execute("ALTER TABLE prospects RENAME TO prospects_legacy")
    # Indexes follow the rename, and a taken name makes CREATE INDEX IF NOT
    # EXISTS skip the new table silently.
    for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_prospects_%'"
    ).fetchall():
        conn.execute(f"DROP INDEX IF EXISTS {row['name']}")
    conn.executescript(SCHEMA)

    carried = [c for c in _columns(conn, "prospects") if c in legacy and c != "region"]
    rows = conn.execute("SELECT * FROM prospects_legacy").fetchall()

    for row in rows:
        record = {column: row[column] for column in carried}
        region = row["region"] if "region" in legacy else None
        market = MARKET_BY_NAME.get(region or "")
        record["market_key"] = market.key if market else slugify(region or "unknown")
        record["market_name"] = market.name if market else (region or "Unknown")
        record["market_group"] = market.group if market else None
        record["country"] = market.country if market else None
        record.setdefault("market_source", "text")

        names = ", ".join(record)
        placeholders = ", ".join("?" for _ in record)
        conn.execute(
            f"INSERT INTO prospects ({names}) VALUES ({placeholders})",
            tuple(record.values()),
        )

    conn.execute("DROP TABLE prospects_legacy")


def _migrate(conn: sqlite3.Connection) -> None:
    existing = _columns(conn, "prospects")
    if existing and "market_key" not in existing:
        _rebuild_prospects(conn)

    for table, columns in ADDED_COLUMNS.items():
        present = _columns(conn, table)
        if not present:
            continue
        for name, definition in columns:
            if name not in present:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def init_db(path: Path | None = None) -> None:
    """Create or upgrade the database. Safe to call on every page load."""
    target = Path(path or DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)

    # Autocommit, because PRAGMA foreign_keys is silently ignored inside a
    # transaction and the migration depends on it being off.
    conn = sqlite3.connect(target, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        # Migration first: the schema script indexes columns a legacy table does
        # not have yet, so creating it before upgrading would fail on the index.
        _migrate(conn)
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def slugify(value: str) -> str:
    cleaned = "".join(c.lower() if c.isalnum() else "-" for c in value)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-")[:80]


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def upsert_prospect(conn: sqlite3.Connection, record: dict[str, Any]) -> tuple[int, bool]:
    """Insert or update a prospect. Returns ``(id, created)``.

    An existing record is never silently overwritten with weaker data: a figure
    is only replaced when the new one is better evidenced (higher confidence), so
    a later thin article cannot undo a well-sourced estimate.
    """
    slug = record["slug"]
    existing = conn.execute(
        "SELECT * FROM prospects WHERE slug = ?", (slug,)
    ).fetchone()

    if existing is None:
        columns = ", ".join(record.keys())
        placeholders = ", ".join("?" for _ in record)
        cursor = conn.execute(
            f"INSERT INTO prospects ({columns}) VALUES ({placeholders})",
            tuple(record.values()),
        )
        return int(cursor.lastrowid), True

    # Respect suppression: an objection stops all future updates.
    if existing["suppressed_at"]:
        return int(existing["id"]), False

    updates: dict[str, Any] = {"last_updated": now_iso()}
    # Fill in blanks only: a later article may name the town or the company the
    # first one omitted, but must not overwrite what is already recorded.
    for key in (
        "job_title", "company", "matched_place", "locality", "address",
        "primary_event", "rationale", "ch_company_number", "ch_company_name",
        "ch_officer_name", "ch_ownership_band", "ch_registered_office",
        "ch_profile_url", "ch_verified_at",
    ):
        if record.get(key) and not existing[key]:
            updates[key] = record[key]

    # A located article upgrades a market that was only inherited from the query.
    if record.get("market_source") == "text" and existing["market_source"] != "text":
        updates["market_source"] = "text"
        for key in ("market_key", "market_name", "market_group", "country"):
            if record.get(key):
                updates[key] = record[key]

    # Better-evidenced estimate wins.
    if record.get("confidence", 0) >= (existing["confidence"] or 0):
        for key in (
            "gross_low_gbp", "gross_mid_gbp", "gross_high_gbp",
            "investable_low_gbp", "investable_mid_gbp", "investable_high_gbp",
            "wealth_band", "cohort", "estimate_method", "estimate_caveats",
            "not_estimated_reason", "confidence", "confidence_band",
            "confidence_detail", "next_action",
        ):
            if key in record:
                updates[key] = record[key]

    assignments = ", ".join(f"{k} = ?" for k in updates)
    conn.execute(
        f"UPDATE prospects SET {assignments} WHERE id = ?",
        (*updates.values(), existing["id"]),
    )
    return int(existing["id"]), False


def add_source(conn: sqlite3.Connection, prospect_id: int, source: dict[str, Any]) -> bool:
    """Attach a citation. Returns False if this URL was already on the record."""
    try:
        conn.execute(
            """INSERT INTO sources
               (prospect_id, url, title, publisher, published_at, retrieved_at,
                event_key, event_label, amount_gbp, excerpt, rationale)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                prospect_id, source["url"], source["title"], source.get("publisher"),
                source.get("published_at"), now_iso(), source.get("event_key"),
                source.get("event_label"), source.get("amount_gbp"),
                source.get("excerpt"), source.get("rationale"),
            ),
        )
        return True
    except sqlite3.IntegrityError:
        return False


def add_event(conn: sqlite3.Connection, prospect_id: int, kind: str, message: str, detail: str | None = None) -> None:
    conn.execute(
        "INSERT INTO events (prospect_id, kind, message, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (prospect_id, kind, message, detail, now_iso()),
    )


def source_count(conn: sqlite3.Connection, prospect_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM sources WHERE prospect_id = ?", (prospect_id,)
    ).fetchone()
    return int(row["n"]) if row else 0


def mark_seen(conn: sqlite3.Connection, url: str) -> bool:
    """Record a URL as processed. Returns False if it was already seen."""
    try:
        conn.execute("INSERT INTO seen_urls (url, first_seen) VALUES (?, ?)", (url, now_iso()))
        return True
    except sqlite3.IntegrityError:
        return False


def start_run(
    conn: sqlite3.Connection,
    trigger: str,
    *,
    depth: str | None = None,
    markets: list[str] | tuple[str, ...] | None = None,
    queries_planned: int = 0,
) -> int:
    cursor = conn.execute(
        """INSERT INTO runs
           (started_at, week, trigger, status, depth, markets, queries_planned)
           VALUES (?, ?, ?, 'running', ?, ?, ?)""",
        (
            now_iso(), iso_week(), trigger, depth,
            json.dumps(list(markets or [])), queries_planned,
        ),
    )
    return int(cursor.lastrowid)


def finish_run(conn: sqlite3.Connection, run_id: int, **stats: Any) -> None:
    warnings = json.dumps(stats.pop("warnings", []))
    log = json.dumps(stats.pop("log", []))
    fields = {**stats, "warnings": warnings, "log": log, "finished_at": now_iso()}
    assignments = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE runs SET {assignments} WHERE id = ?", (*fields.values(), run_id))


def save_report(conn: sqlite3.Connection, week: str, markdown: str, payload: dict[str, Any]) -> None:
    conn.execute(
        """INSERT INTO reports (week, generated_at, markdown, payload)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(week) DO UPDATE SET
             generated_at = excluded.generated_at,
             markdown = excluded.markdown,
             payload = excluded.payload""",
        (week, now_iso(), markdown, json.dumps(payload)),
    )


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def last_run(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM runs WHERE status != 'running' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()


def run_due_this_week(conn: sqlite3.Connection) -> bool:
    """True when no successful run has happened in the current ISO week."""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM runs WHERE week = ? AND status IN ('success', 'partial')",
        (iso_week(),),
    ).fetchone()
    return not (row and row["n"])


def all_prospects(conn: sqlite3.Connection, include_suppressed: bool = False) -> list[sqlite3.Row]:
    clause = "" if include_suppressed else "WHERE suppressed_at IS NULL"
    return conn.execute(
        f"SELECT * FROM prospects {clause} ORDER BY "
        "CASE WHEN investable_mid_gbp IS NULL THEN 1 ELSE 0 END, "
        "investable_mid_gbp DESC, confidence DESC"
    ).fetchall()


def prospect_sources(conn: sqlite3.Connection, prospect_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM sources WHERE prospect_id = ? ORDER BY published_at DESC",
        (prospect_id,),
    ).fetchall()


def prospect_events(conn: sqlite3.Connection, prospect_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM events WHERE prospect_id = ? ORDER BY created_at DESC",
        (prospect_id,),
    ).fetchall()


def prospects_for_week(conn: sqlite3.Connection, week: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM prospects WHERE first_seen_week = ? AND suppressed_at IS NULL "
        "ORDER BY CASE WHEN investable_mid_gbp IS NULL THEN 1 ELSE 0 END, investable_mid_gbp DESC",
        (week,),
    ).fetchall()


def reports(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM reports ORDER BY week DESC").fetchall()


def report_for_week(conn: sqlite3.Connection, week: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM reports WHERE week = ?", (week,)).fetchone()


def runs(conn: sqlite3.Connection, limit: int = 20) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()


def prospect(conn: sqlite3.Connection, prospect_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM prospects WHERE id = ?", (prospect_id,)).fetchone()


#: The only prospect fields an advisor edits by hand. Everything else is derived
#: by the pipeline and would be overwritten by the next sweep.
EDITABLE_FIELDS = ("status", "relationship_stage", "owner", "notes")


def update_prospect(conn: sqlite3.Connection, prospect_id: int, changes: dict[str, Any]) -> None:
    """Apply an advisor's own edits — pipeline output is never editable here."""
    allowed = {k: v for k, v in changes.items() if k in EDITABLE_FIELDS}
    if not allowed:
        return
    allowed["last_updated"] = now_iso()
    assignments = ", ".join(f"{k} = ?" for k in allowed)
    conn.execute(
        f"UPDATE prospects SET {assignments} WHERE id = ?",
        (*allowed.values(), prospect_id),
    )


def suppress_prospect(conn: sqlite3.Connection, prospect_id: int, reason: str) -> None:
    """Honour an objection: stop updating the record and drop it from totals.

    Required by UK GDPR Article 21, and the reason it is a flag rather than a
    delete is that a delete would let the next weekly sweep find the person again
    and recreate them.
    """
    conn.execute(
        "UPDATE prospects SET suppressed_at = ?, suppression_reason = ? WHERE id = ?",
        (now_iso(), reason, prospect_id),
    )
    add_event(conn, prospect_id, "suppressed", "Record suppressed on objection.", reason)


def unsuppress_prospect(conn: sqlite3.Connection, prospect_id: int) -> None:
    conn.execute(
        "UPDATE prospects SET suppressed_at = NULL, suppression_reason = NULL WHERE id = ?",
        (prospect_id,),
    )
