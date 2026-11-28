"""
JSON views returned by the HTTP API.

See EventView in docs/projects/triton-event-feed/CONTRACTS.md.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from models import EventUpdate, IndexedEvent

ENDING_SOON = timedelta(hours=1)

Status = Literal["upcoming", "live", "ending_soon", "ended"]

UPDATE_VIEW_FIELDS = {"text", "source_uri", "created_at"}


def _as_utc(moment: datetime) -> datetime:
    """Treat a naive datetime as UTC; leave aware ones unchanged."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment


def event_status(event: IndexedEvent, now: datetime) -> Status:
    """
    Classify an event as upcoming, live, ending soon or ended.

    Args:
        event: the event to classify.
        now: the current time.

    Returns:
        The event's status at `now`.
    """
    now = _as_utc(now)
    ends_at = _as_utc(event.record.ends_at)
    if now >= ends_at:
        return "ended"
    if now < _as_utc(event.record.starts_at):
        return "upcoming"
    if ends_at - now <= ENDING_SOON:
        return "ending_soon"
    return "live"


def event_view(event: IndexedEvent, now: datetime) -> dict[str, Any]:
    """
    Flatten an event into the camelCase JSON the frontend reads.

    Args:
        event: the event to serialise.
        now: the current time, used for the "status" field.

    Returns:
        The index metadata and record fields merged, plus "status".
    """
    record = event.record.model_dump(mode="json", by_alias=True)
    metadata = event.model_dump(mode="json", by_alias=True, exclude={"record"})
    return {**metadata, **record, "status": event_status(event, now)}


def update_view(update: EventUpdate) -> dict[str, Any]:
    """Serialise an announcement (text, source and time only)."""
    return update.model_dump(
        mode="json", by_alias=True, include=UPDATE_VIEW_FIELDS
    )
