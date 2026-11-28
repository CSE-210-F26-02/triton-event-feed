"""
Storage interface. The SQLite implementation lives in store/sqlite.py.

Everything above this layer depends only on this Protocol, so the index can be
swapped (Postgres, in-memory for tests) without touching ingest or API code.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Protocol

from models import (
    Count,
    EventQuery,
    EventUpdate,
    IndexedEvent,
    Listener,
    Notification,
    Page,
)

UpsertResult = Literal["created", "updated", "unchanged"]


class EventStore(Protocol):
    """The index of events, listeners, subscriptions and notifications."""

    # events
    def upsert_event(self, event: IndexedEvent) -> UpsertResult:
        """Insert or replace an event; report whether anything changed."""
        ...

    def get_event(self, uri: str) -> IndexedEvent | None:
        """Return the event with this URI, or None."""
        ...

    def delete_event(self, uri: str) -> bool:
        """Delete an event; return whether it existed."""
        ...

    def query_events(self, query: EventQuery, now: datetime) -> Page:
        """
        Sorted by startsAt asc then uri. Hides events with
        endsAt < (query.ends_after or now).
        """
        ...

    def delete_expired(self, cutoff: datetime) -> list[str]:
        """Delete events whose endsAt < cutoff; return their URIs."""
        ...

    def list_tags(self, now: datetime) -> list[Count]:
        """Count visible events per tag."""
        ...

    def list_groups(self, now: datetime) -> list[Count]:
        """Count visible events per group."""
        ...

    # updates (announcements)
    def add_update(self, update: EventUpdate) -> None:
        """Store an announcement for an event."""
        ...

    def list_updates(self, event_uri: str) -> list[EventUpdate]:
        """Return an event's announcements, oldest first."""
        ...

    # listeners
    def upsert_listener(self, listener: Listener) -> None:
        """Insert or replace a listener record."""
        ...

    def delete_listener(self, uri: str) -> bool:
        """Delete a listener; return whether it existed."""
        ...

    def listeners_for_did(self, did: str) -> list[Listener]:
        """Return every listener created by this DID."""
        ...

    def listener_dids(self) -> list[str]:
        """Return every DID that has at least one listener."""
        ...

    # subscriptions (subscriber_id is an opaque client id, never a location)
    def subscribe(self, subscriber_id: str, event_uri: str) -> None:
        """Subscribe a client to an event (idempotent)."""
        ...

    def unsubscribe(self, subscriber_id: str, event_uri: str) -> None:
        """Unsubscribe a client from an event (idempotent)."""
        ...

    def subscribers_of(self, event_uri: str) -> list[str]:
        """Return every client subscribed to an event."""
        ...

    def subscriptions_of(self, subscriber_id: str) -> list[str]:
        """Return every event a client is subscribed to."""
        ...

    # notifications
    def add_notification(self, notification: Notification) -> Notification:
        """Persist and return with id set."""
        ...

    def list_notifications(
        self, subscriber_id: str, since_id: int = 0
    ) -> list[Notification]:
        """Return a client's notifications with id > since_id."""
        ...

    # ingest cursors (e.g. Jetstream time_us)
    def get_cursor(self, name: str) -> int | None:
        """Return a saved ingest cursor, or None."""
        ...

    def set_cursor(self, name: str, value: int) -> None:
        """Save an ingest cursor."""
        ...
