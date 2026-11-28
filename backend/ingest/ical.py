"""Import events from iCalendar (.ics) feeds into the index."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from icalendar import Calendar, Component
from pydantic import ValidationError

from config import Settings
from ingest.processor import index_event, utcnow
from models import (
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_TAGS,
    EventRecord,
    IndexedEvent,
    Location,
)
from notify.base import Notifier
from store.base import EventStore

logger = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 10.0
DEFAULT_DURATION = timedelta(hours=1)
ALL_DAY_DURATION = timedelta(days=1)
NO_LOCATION = "TBA"
UNKNOWN_HOST = "unknown"
ICAL_AUTHOR_PREFIX = "ical:"
FEED_HASH_LENGTH = 12
UID_HASH_LENGTH = 16

# Longest UID and URL we keep from a feed.
MAX_UID_LENGTH = 1000
MAX_URL_LENGTH = 2000

# Problems in one VEVENT that skip that VEVENT instead of the whole feed.
MALFORMED_VEVENT_ERRORS = (
    ValueError,
    KeyError,
    TypeError,
    AttributeError,
    ValidationError,
)

Clock = Callable[[], datetime]


def _sha1_hex(text: str) -> str:
    """
    Return the SHA-1 hex digest of ``text``, used only to build stable ids.

    The digest is not a security control: it only turns a feed URL / UID into a
    short, deterministic URI segment. SHA-1 is kept (rather than switching to
    SHA-256) because existing ``ical://`` URIs are stored in the index and in
    subscriptions, and a different digest would orphan them.

    :param text: the feed URL or iCalendar UID to fingerprint.
    :returns: the 40-character lowercase hex digest.
    """
    return hashlib.sha1(text.encode(), usedforsecurity=False).hexdigest()


def event_uri(feed_url: str, uid: str) -> str:
    """Stable ical:// URI for one VEVENT of one feed."""
    feed_hash = _sha1_hex(feed_url)[:FEED_HASH_LENGTH]
    uid_hash = _sha1_hex(uid)[:UID_HASH_LENGTH]
    return f"ical://{feed_hash}/{uid_hash}"


def _to_utc(value: date | datetime) -> datetime:
    """
    Convert an iCal date or datetime to an aware UTC datetime.

    A naive datetime is treated as UTC; a date (all-day) becomes midnight.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    return datetime(value.year, value.month, value.day, tzinfo=UTC)


def _start_and_end(vevent: Component) -> tuple[datetime, datetime]:
    """Return (start, end), inventing an end when the feed omits it."""
    raw_start = vevent["DTSTART"].dt
    starts_at = _to_utc(raw_start)
    if "DTEND" in vevent:
        ends_at = _to_utc(vevent["DTEND"].dt)
    elif "DURATION" in vevent:
        ends_at = starts_at + vevent["DURATION"].dt
    elif isinstance(raw_start, datetime):
        ends_at = starts_at + DEFAULT_DURATION
    else:
        ends_at = starts_at + ALL_DAY_DURATION  # all-day event without DTEND
    return starts_at, ends_at


def _text_property(
    vevent: Component, property_name: str, max_length: int
) -> str | None:
    """Return a trimmed, truncated text property, or None if blank."""
    value = vevent.get(property_name)
    if value is None:
        return None
    return str(value).strip()[:max_length] or None


def _location(vevent: Component) -> Location:
    """Build the event's Location from LOCATION and GEO."""
    name = _text_property(vevent, "LOCATION", MAX_NAME_LENGTH) or NO_LOCATION
    geo_coordinates = vevent.get("GEO")
    if geo_coordinates is None:
        return Location(name=name)
    return Location(
        name=name,
        lat=str(geo_coordinates.latitude),
        lng=str(geo_coordinates.longitude),
    )


def _event_record(vevent: Component, now: datetime) -> EventRecord:
    """
    Build the lexicon record for one VEVENT.

    Raises:
        ValidationError: when the VEVENT does not make a valid record.
    """
    starts_at, ends_at = _start_and_end(vevent)
    created = vevent.get("CREATED")
    description = _text_property(vevent, "DESCRIPTION", MAX_DESCRIPTION_LENGTH)
    categories = [str(category) for category in vevent.categories]
    return EventRecord(
        name=_text_property(vevent, "SUMMARY", MAX_NAME_LENGTH) or "",
        description=description or "",
        starts_at=starts_at,
        ends_at=ends_at,
        location=_location(vevent),
        tags=categories[:MAX_TAGS],
        source_url=_text_property(vevent, "URL", MAX_URL_LENGTH),
        created_at=_to_utc(created.dt) if created is not None else now,
    )


def _indexed_event(
    vevent: Component, feed_url: str, author: str, now: datetime
) -> IndexedEvent | None:
    """
    Build the indexed event for one VEVENT, or None if it has ended.

    Raises:
        ValueError: when the VEVENT has no UID.
    """
    uid = _text_property(vevent, "UID", MAX_UID_LENGTH)
    if uid is None:
        raise ValueError("VEVENT without UID")
    record = _event_record(vevent, now)
    if record.ends_at < now:
        return None
    return IndexedEvent(
        uri=event_uri(feed_url, uid),
        author_did=author,
        source="ical",
        record=record,
        indexed_at=now,
        updated_at=now,
    )


def parse_ics(text: str, feed_url: str, now: datetime) -> list[IndexedEvent]:
    """
    Parse a feed into IndexedEvents; malformed VEVENTs are skipped.

    Args:
        text: the feed body.
        feed_url: where the feed came from (part of each event's URI).
        now: the current time; events that have ended are dropped.

    Returns:
        The feed's current events.

    Raises:
        ValueError: if text is not a calendar at all.
    """
    calendar = Calendar.from_ical(text)
    host = urlsplit(feed_url).hostname or UNKNOWN_HOST
    author = ICAL_AUTHOR_PREFIX + host
    events: list[IndexedEvent] = []
    for vevent in calendar.walk("VEVENT"):
        try:
            event = _indexed_event(vevent, feed_url, author, now)
        except MALFORMED_VEVENT_ERRORS as error:
            logger.info("skipping malformed VEVENT in %s: %s", feed_url, error)
            continue
        if event is not None:
            events.append(event)
    return events


def _keep_created_at(
    event: IndexedEvent, existing: IndexedEvent | None
) -> IndexedEvent:
    """Feeds rarely carry CREATED, so keep the first-seen createdAt."""
    if existing is None:
        return event
    record = event.record.model_copy(
        update={"created_at": existing.record.created_at}
    )
    return event.model_copy(update={"record": record})


async def import_feed(
    url: str,
    store: EventStore,
    notifier: Notifier,
    client: httpx.AsyncClient,
    clock: Clock = utcnow,
) -> int:
    """
    Fetch and index one feed.

    Args:
        url: the feed URL.
        store: the event store.
        notifier: tells subscribers about changed events.
        client: the HTTP client used to fetch the feed.
        clock: returns the current time (injected for tests).

    Returns:
        The number of current events imported.

    Raises:
        httpx.HTTPError: when the feed cannot be fetched.
        ValueError: when the body is not iCalendar.
    """
    response = await client.get(
        url, timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True
    )
    response.raise_for_status()
    events = parse_ics(response.text, url, clock())
    for event in events:
        existing = store.get_event(event.uri)
        event = _keep_created_at(event, existing)
        await index_event(store, notifier, event, existing)
    return len(events)


async def run_ical_loop(
    store: EventStore,
    notifier: Notifier,
    settings: Settings,
    client: httpx.AsyncClient | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Clock = utcnow,
) -> None:
    """
    Poll every configured feed forever; a failing feed is logged and
    skipped.

    Args:
        store: the event store.
        notifier: tells subscribers about changed events.
        settings: supplies the feed URLs and polling interval.
        client: HTTP client to use; None creates (and closes) one.
        sleep: waits between rounds (injected for tests).
        clock: returns the current time (injected for tests).
    """
    if not settings.ical_feed_urls:
        return
    http_client = client or httpx.AsyncClient()
    try:
        while True:
            for url in settings.ical_feed_urls:
                await _import_logged(url, store, notifier, http_client, clock)
            await sleep(settings.ical_interval_seconds)
    finally:
        if client is None:
            await http_client.aclose()


async def _import_logged(
    url: str,
    store: EventStore,
    notifier: Notifier,
    client: httpx.AsyncClient,
    clock: Clock,
) -> None:
    """Import one feed, logging (not raising) any failure."""
    try:
        imported_count = await import_feed(url, store, notifier, client, clock)
        logger.info("imported %d events from %s", imported_count, url)
    except Exception as error:  # keep polling other feeds / next round
        logger.warning("ical import failed for %s: %r", url, error)
