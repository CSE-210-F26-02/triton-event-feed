"""
SQLite implementation of EventStore (stdlib sqlite3, single shared
connection).
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from models import (
    HASHTAG_PREFIX,
    Count,
    EventQuery,
    EventRecord,
    EventUpdate,
    IndexedEvent,
    Listener,
    ListenerRecord,
    Notification,
    Page,
    SortOrder,
)
from store.base import UpsertResult

IN_MEMORY_PATH = ":memory:"
CURSOR_SEPARATOR = "|"
CURSOR_PARTS = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    uri TEXT PRIMARY KEY,
    cid TEXT,
    author_did TEXT NOT NULL,
    author_handle TEXT,
    source TEXT NOT NULL,
    record TEXT NOT NULL,
    search TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lat REAL,
    lng REAL,
    grp TEXT,
    indexed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_order ON events (starts_at, uri);
CREATE INDEX IF NOT EXISTS events_newest ON events (created_at DESC, uri DESC);
CREATE INDEX IF NOT EXISTS events_coords ON events (lat, lng);
CREATE INDEX IF NOT EXISTS events_ends ON events (ends_at);
CREATE INDEX IF NOT EXISTS events_grp ON events (grp);
CREATE INDEX IF NOT EXISTS events_author ON events (author_did);
CREATE TABLE IF NOT EXISTS event_tags (
    uri TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (uri, tag)
);
CREATE INDEX IF NOT EXISTS event_tags_tag ON event_tags (tag);
CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uri TEXT NOT NULL,
    text TEXT NOT NULL,
    source_uri TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_event ON updates (event_uri);
CREATE TABLE IF NOT EXISTS listeners (
    uri TEXT PRIMARY KEY,
    author_did TEXT NOT NULL,
    record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listeners_did ON listeners (author_did);
CREATE TABLE IF NOT EXISTS subscriptions (
    subscriber_id TEXT NOT NULL,
    event_uri TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, event_uri)
);
CREATE INDEX IF NOT EXISTS subscriptions_event ON subscriptions (event_uri);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    event_uri TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_sub
    ON notifications (subscriber_id, id);
CREATE TABLE IF NOT EXISTS cursors (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
"""

# Tables that reference an event, and the column holding its URI; purged
# together so no orphan rows remain.
EVENT_TABLES = (
    ("events", "uri"),
    ("event_tags", "uri"),
    ("updates", "event_uri"),
    ("subscriptions", "event_uri"),
)

# ORDER BY clause and cursor column for each sort mode.
SORT_ORDER_BY = {
    "newest": ("created_at DESC, uri DESC", "created_at"),
    "soonest": ("starts_at ASC, uri ASC", "starts_at"),
}
# Keyset-pagination condition for each sort mode ("after" the cursor).
SORT_AFTER_CURSOR = {
    "newest": "(created_at < ? OR (created_at = ? AND uri < ?))",
    "soonest": "(starts_at > ? OR (starts_at = ? AND uri > ?))",
}

INSERT_EVENT_SQL = (
    "INSERT OR REPLACE INTO events (uri, cid, author_did, author_handle,"
    " source, record, search, starts_at, ends_at, created_at, lat, lng,"
    " grp, indexed_at, updated_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def _coordinates(record: EventRecord) -> tuple[float | None, float | None]:
    """Return the event's (lat, lng) as floats, or (None, None)."""
    if record.location.lat is None or record.location.lng is None:
        return None, None
    lat, lng = float(record.location.lat), float(record.location.lng)
    if not (math.isfinite(lat) and math.isfinite(lng)):
        return None, None
    return lat, lng


def to_iso(moment: datetime) -> str:
    """
    Fixed-width UTC ISO string (lexicographic order == chronological).

    Naive datetimes are treated as UTC.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat(timespec="microseconds")


def from_iso(text: str) -> datetime:
    """Parse a string written by to_iso."""
    return datetime.fromisoformat(text)


def encode_cursor(sort: SortOrder, timestamp: str, uri: str) -> str:
    """Build the opaque paging cursor for the last row of a page."""
    decoded_cursor = CURSOR_SEPARATOR.join((sort, timestamp, uri))
    return base64.urlsafe_b64encode(decoded_cursor.encode()).decode()


def decode_cursor(
    cursor: str, expected_sort: SortOrder = "soonest"
) -> tuple[str, str]:
    """
    Return (timestamp, uri) from a cursor made by encode_cursor.

    Raises:
        ValueError: on a malformed cursor or a sort-mode mismatch.
    """
    try:
        decoded_cursor = base64.urlsafe_b64decode(cursor.encode()).decode()
    except (binascii.Error, UnicodeDecodeError) as error:
        raise ValueError("invalid cursor") from error
    parts = decoded_cursor.split(CURSOR_SEPARATOR, CURSOR_PARTS - 1)
    if len(parts) != CURSOR_PARTS or parts[0] != expected_sort or not parts[2]:
        raise ValueError("invalid cursor")
    return to_iso(from_iso(parts[1])), parts[2]


def _normalize_tag(tag: str) -> str:
    """Lower-case a tag and strip whitespace and a leading "#"."""
    return tag.strip().lstrip(HASHTAG_PREFIX).lower()


def _search_text(record: EventRecord) -> str:
    """The lower-cased text that ?q= searches (name, description, place)."""
    fields = [record.name, record.description, record.location.name]
    return "\n".join(fields).lower()


def _record_json(record: EventRecord) -> str:
    """Serialise a record exactly as the lexicon spells it (camelCase)."""
    return record.model_dump_json(by_alias=True)


def _event_row(
    event: IndexedEvent, record_json: str, indexed_at: str
) -> tuple[Any, ...]:
    """Column values for INSERT_EVENT_SQL, in column order."""
    record = event.record
    lat, lng = _coordinates(record)
    return (
        event.uri,
        event.cid,
        event.author_did,
        event.author_handle,
        event.source,
        record_json,
        _search_text(record),
        to_iso(record.starts_at),
        to_iso(record.ends_at),
        to_iso(record.created_at),
        lat,
        lng,
        record.group,
        indexed_at,
        to_iso(event.updated_at),
    )


def _bbox_clauses(query: EventQuery) -> tuple[list[str], list[Any]]:
    """WHERE clauses and parameters for the ?bbox= filter."""
    bbox = query.bbox
    if bbox is None:
        return [], []
    where = ["lat IS NOT NULL AND lng IS NOT NULL", "lat >= ? AND lat <= ?"]
    params: list[Any] = [bbox.south, bbox.north]
    if bbox.west <= bbox.east:
        where.append("lng >= ? AND lng <= ?")
    else:  # crosses the antimeridian
        where.append("(lng >= ? OR lng <= ?)")
    params += [bbox.west, bbox.east]
    return where, params


def _filter_clauses(
    query: EventQuery, now: datetime
) -> tuple[list[str], list[Any]]:
    """WHERE clauses and parameters for every filter in query."""
    where = ["ends_at >= ?"]
    params: list[Any] = [to_iso(query.ends_after or now)]
    tags = [tag for tag in (_normalize_tag(tag) for tag in query.tags) if tag]
    if tags:
        marks = ",".join("?" * len(tags))
        where.append(
            "EXISTS (SELECT 1 FROM event_tags t"
            f" WHERE t.uri = e.uri AND t.tag IN ({marks}))"
        )
        params += tags
    if query.group:
        where.append("grp = ?")
        params.append(query.group)
    if query.text:
        where.append("instr(search, ?) > 0")
        params.append(query.text.lower())
    if query.starts_before:
        where.append("starts_at < ?")
        params.append(to_iso(query.starts_before))
    bbox_where, bbox_params = _bbox_clauses(query)
    return where + bbox_where, params + bbox_params


def _cursor_clauses(query: EventQuery) -> tuple[list[str], list[Any]]:
    """WHERE clause and parameters that resume after query.cursor."""
    if not query.cursor:
        return [], []
    after_timestamp, after_uri = decode_cursor(query.cursor, query.sort)
    return (
        [SORT_AFTER_CURSOR[query.sort]],
        [after_timestamp, after_timestamp, after_uri],
    )


def _purge(connection: sqlite3.Connection, uris: list[str]) -> None:
    """Delete these events and every row that references them."""
    params = [(uri,) for uri in uris]
    for table, column in EVENT_TABLES:
        connection.executemany(
            f"DELETE FROM {table} WHERE {column} = ?", params
        )


def _row_to_event(row: sqlite3.Row) -> IndexedEvent:
    """
    Build an IndexedEvent from an ``events`` table row.

    The row is copied into a dict first so columns are read by name through a
    mapping (``sqlite3.Row`` is also a sequence, which only takes int indices).

    :param row: a row selected from the ``events`` table.
    :returns: the indexed event, with its record validated against the model.
    """
    columns = dict(row)
    return IndexedEvent(
        uri=columns["uri"],
        cid=columns["cid"],
        author_did=columns["author_did"],
        author_handle=columns["author_handle"],
        source=columns["source"],
        record=EventRecord.model_validate(json.loads(columns["record"])),
        indexed_at=from_iso(columns["indexed_at"]),
        updated_at=from_iso(columns["updated_at"]),
    )


def _row_to_update(row: sqlite3.Row) -> EventUpdate:
    """Build an EventUpdate from an ``updates`` table row."""
    return EventUpdate(
        event_uri=row["event_uri"],
        text=row["text"],
        source_uri=row["source_uri"],
        created_at=from_iso(row["created_at"]),
    )


def _row_to_listener(row: sqlite3.Row) -> Listener:
    """Build a Listener from a ``listeners`` table row."""
    return Listener(
        uri=row["uri"],
        author_did=row["author_did"],
        record=ListenerRecord.model_validate_json(row["record"]),
    )


def _row_to_notification(row: sqlite3.Row) -> Notification:
    """Build a Notification from a ``notifications`` table row."""
    return Notification(
        id=row["id"],
        subscriber_id=row["subscriber_id"],
        event_uri=row["event_uri"],
        kind=row["kind"],
        message=row["message"],
        created_at=from_iso(row["created_at"]),
    )


class SqliteStore:
    """EventStore backed by one SQLite file (or ":memory:")."""

    def __init__(self, path: str) -> None:
        """
        Open (creating if needed) the database and its tables.

        Args:
            path: the SQLite file, or ":memory:" for a throwaway database.
        """
        if path != IN_MEMORY_PATH:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.executescript(SCHEMA)

    def close(self) -> None:
        """Close the database connection."""
        with self._lock:
            self._connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        """Run the block in one transaction, holding the lock."""
        with self._lock, self._connection:
            yield self._connection

    def _fetch_all(
        self, sql: str, params: tuple[Any, ...] | list[Any] = ()
    ) -> list[sqlite3.Row]:
        """Run a query and return every row."""
        with self._lock:
            return self._connection.execute(sql, params).fetchall()

    def _fetch_one(
        self, sql: str, params: tuple[Any, ...] = ()
    ) -> sqlite3.Row | None:
        """Run a query and return the first row, or None."""
        with self._lock:
            return self._connection.execute(sql, params).fetchone()

    # events

    def upsert_event(self, event: IndexedEvent) -> UpsertResult:
        """
        Insert or replace an event, keeping its first indexed_at.

        Returns:
            "unchanged" when cid and record match the stored copy,
            otherwise "created" or "updated".
        """
        record_json = _record_json(event.record)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT cid, record, indexed_at FROM events WHERE uri = ?",
                (event.uri,),
            ).fetchone()
            if (
                row is not None
                and row["cid"] == event.cid
                and row["record"] == record_json
            ):
                return "unchanged"
            indexed_at = (
                row["indexed_at"]
                if row is not None
                else to_iso(event.indexed_at)
            )
            connection.execute(
                INSERT_EVENT_SQL, _event_row(event, record_json, indexed_at)
            )
            connection.execute(
                "DELETE FROM event_tags WHERE uri = ?", (event.uri,)
            )
            connection.executemany(
                "INSERT OR IGNORE INTO event_tags (uri, tag) VALUES (?, ?)",
                [(event.uri, tag) for tag in event.record.tags],
            )
        return "created" if row is None else "updated"

    def get_event(self, uri: str) -> IndexedEvent | None:
        """Return the event with this URI, or None."""
        row = self._fetch_one("SELECT * FROM events WHERE uri = ?", (uri,))
        return _row_to_event(row) if row is not None else None

    def delete_event(self, uri: str) -> bool:
        """
        Also drops tags, updates and subscriptions: publish "deleted"
        before calling.
        """
        with self._transaction() as connection:
            existed = connection.execute(
                "SELECT 1 FROM events WHERE uri = ?", (uri,)
            ).fetchone()
            _purge(connection, [uri])
        return existed is not None

    def query_events(self, query: EventQuery, now: datetime) -> Page:
        """
        Return one page of events matching query (keyset paginated).

        Raises:
            ValueError: when query.cursor is malformed.
        """
        filter_where, filter_params = _filter_clauses(query, now)
        cursor_where, cursor_params = _cursor_clauses(query)
        order_by, cursor_column = SORT_ORDER_BY[query.sort]
        where = " AND ".join(filter_where + cursor_where)
        sql = (
            f"SELECT * FROM events e WHERE {where} ORDER BY {order_by} LIMIT ?"
        )
        # Fetch one extra row to learn whether another page exists.
        params = [*filter_params, *cursor_params, query.limit + 1]
        rows = self._fetch_all(sql, params)
        has_more = len(rows) > query.limit
        rows = rows[: query.limit]
        next_cursor = None
        if has_more:
            last_row = rows[-1]
            next_cursor = encode_cursor(
                query.sort, last_row[cursor_column], last_row["uri"]
            )
        events = [_row_to_event(row) for row in rows]
        return Page(events=events, cursor=next_cursor)

    def delete_expired(self, cutoff: datetime) -> list[str]:
        """Delete events whose endsAt < cutoff; return their URIs."""
        with self._transaction() as connection:
            rows = connection.execute(
                "SELECT uri FROM events WHERE ends_at < ?", (to_iso(cutoff),)
            )
            uris = [row["uri"] for row in rows]
            _purge(connection, uris)
        return uris

    def list_tags(self, now: datetime) -> list[Count]:
        """Count visible events per tag, most used first."""
        return self._counts(
            "SELECT t.tag AS value, COUNT(*) AS n FROM event_tags t"
            " JOIN events e ON e.uri = t.uri WHERE e.ends_at >= ?"
            " GROUP BY t.tag ORDER BY n DESC, value",
            now,
        )

    def list_groups(self, now: datetime) -> list[Count]:
        """Count visible events per group, most used first."""
        return self._counts(
            "SELECT grp AS value, COUNT(*) AS n FROM events"
            " WHERE ends_at >= ? AND grp IS NOT NULL AND grp != ''"
            " GROUP BY grp ORDER BY n DESC, value",
            now,
        )

    def _counts(self, sql: str, now: datetime) -> list[Count]:
        """Run a (value, n) counting query for events visible at now."""
        rows = self._fetch_all(sql, (to_iso(now),))
        return [Count(value=row["value"], count=row["n"]) for row in rows]

    # updates

    def add_update(self, update: EventUpdate) -> None:
        """Store an announcement for an event."""
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO updates (event_uri, text, source_uri,"
                " created_at) VALUES (?, ?, ?, ?)",
                (
                    update.event_uri,
                    update.text,
                    update.source_uri,
                    to_iso(update.created_at),
                ),
            )

    def list_updates(self, event_uri: str) -> list[EventUpdate]:
        """Return an event's announcements, oldest first."""
        rows = self._fetch_all(
            "SELECT * FROM updates WHERE event_uri = ?"
            " ORDER BY created_at, id",
            (event_uri,),
        )
        return [_row_to_update(row) for row in rows]

    # listeners

    def upsert_listener(self, listener: Listener) -> None:
        """Insert or replace a listener record."""
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO listeners (uri, author_did, record)"
                " VALUES (?, ?, ?)",
                (
                    listener.uri,
                    listener.author_did,
                    listener.record.model_dump_json(by_alias=True),
                ),
            )

    def delete_listener(self, uri: str) -> bool:
        """Delete a listener; return whether it existed."""
        with self._transaction() as connection:
            cursor = connection.execute(
                "DELETE FROM listeners WHERE uri = ?", (uri,)
            )
            return cursor.rowcount > 0

    def listeners_for_did(self, did: str) -> list[Listener]:
        """Return every listener created by this DID."""
        rows = self._fetch_all(
            "SELECT * FROM listeners WHERE author_did = ? ORDER BY uri",
            (did,),
        )
        return [_row_to_listener(row) for row in rows]

    def listener_dids(self) -> list[str]:
        """Return every DID that has at least one listener."""
        rows = self._fetch_all(
            "SELECT DISTINCT author_did FROM listeners ORDER BY author_did"
        )
        return [row["author_did"] for row in rows]

    # subscriptions

    def subscribe(self, subscriber_id: str, event_uri: str) -> None:
        """Subscribe a client to an event (idempotent)."""
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO subscriptions (subscriber_id,"
                " event_uri) VALUES (?, ?)",
                (subscriber_id, event_uri),
            )

    def unsubscribe(self, subscriber_id: str, event_uri: str) -> None:
        """Unsubscribe a client from an event (idempotent)."""
        with self._transaction() as connection:
            connection.execute(
                "DELETE FROM subscriptions"
                " WHERE subscriber_id = ? AND event_uri = ?",
                (subscriber_id, event_uri),
            )

    def subscribers_of(self, event_uri: str) -> list[str]:
        """Return every client subscribed to an event."""
        rows = self._fetch_all(
            "SELECT subscriber_id FROM subscriptions WHERE event_uri = ?"
            " ORDER BY subscriber_id",
            (event_uri,),
        )
        return [row["subscriber_id"] for row in rows]

    def subscriptions_of(self, subscriber_id: str) -> list[str]:
        """Return every event a client is subscribed to."""
        rows = self._fetch_all(
            "SELECT event_uri FROM subscriptions WHERE subscriber_id = ?"
            " ORDER BY event_uri",
            (subscriber_id,),
        )
        return [row["event_uri"] for row in rows]

    # notifications

    def add_notification(self, notification: Notification) -> Notification:
        """Persist a notification and return it with its new id."""
        with self._transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO notifications (subscriber_id, event_uri, kind,"
                " message, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    notification.subscriber_id,
                    notification.event_uri,
                    notification.kind,
                    notification.message,
                    to_iso(notification.created_at),
                ),
            )
        return notification.model_copy(update={"id": cursor.lastrowid})

    def list_notifications(
        self, subscriber_id: str, since_id: int = 0
    ) -> list[Notification]:
        """Return a client's notifications with id > since_id."""
        rows = self._fetch_all(
            "SELECT * FROM notifications WHERE subscriber_id = ? AND id > ?"
            " ORDER BY id",
            (subscriber_id, since_id),
        )
        return [_row_to_notification(row) for row in rows]

    # ingest cursors

    def get_cursor(self, name: str) -> int | None:
        """Return a saved ingest cursor, or None."""
        row = self._fetch_one(
            "SELECT value FROM cursors WHERE name = ?", (name,)
        )
        return row["value"] if row is not None else None

    def set_cursor(self, name: str, value: int) -> None:
        """Save an ingest cursor."""
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO cursors (name, value) VALUES (?, ?)",
                (name, value),
            )
