"""
In-memory fakes of the EventStore / Notifier Protocols used by the
ingest tests.

FakeStore implements every EventStore method, so the type checker accepts it
wherever an EventStore is expected. Queries the ingest code never makes
(paging, tag counts, ...) raise NotImplementedError: tests that need them use
the real SqliteStore(":memory:") from conftest.py instead.
"""

from __future__ import annotations

from datetime import UTC, datetime

from models import (
    Count,
    EventQuery,
    EventUpdate,
    IndexedEvent,
    Listener,
    Notification,
    NotificationKind,
    Page,
)
from store.base import UpsertResult

NOT_USED_BY_INGEST = "not used by the ingest code; use SqliteStore"


class FakeStore:
    """In-memory EventStore for the ingest tests."""

    def __init__(self) -> None:
        """Start with no events, listeners, subscriptions or cursors."""
        self.events: dict[str, IndexedEvent] = {}
        self.updates: list[EventUpdate] = []
        self.listeners: dict[str, Listener] = {}
        self.cursors: dict[str, int] = {}
        self.subscriptions: set[tuple[str, str]] = set()
        self.notifications: list[Notification] = []

    # events
    def upsert_event(self, event: IndexedEvent) -> UpsertResult:
        previous_event = self.events.get(event.uri)
        if previous_event is not None and _same_content(previous_event, event):
            return "unchanged"
        self.events[event.uri] = event
        return "created" if previous_event is None else "updated"

    def get_event(self, uri: str) -> IndexedEvent | None:
        return self.events.get(uri)

    def delete_event(self, uri: str) -> bool:
        return self.events.pop(uri, None) is not None

    # updates
    def add_update(self, update: EventUpdate) -> None:
        self.updates.append(update)

    def list_updates(self, event_uri: str) -> list[EventUpdate]:
        return [
            update for update in self.updates if update.event_uri == event_uri
        ]

    # listeners
    def upsert_listener(self, listener: Listener) -> None:
        self.listeners[listener.uri] = listener

    def delete_listener(self, uri: str) -> bool:
        return self.listeners.pop(uri, None) is not None

    def listeners_for_did(self, did: str) -> list[Listener]:
        return [
            listener
            for listener in self.listeners.values()
            if listener.author_did == did
        ]

    def listener_dids(self) -> list[str]:
        return sorted(
            {listener.author_did for listener in self.listeners.values()}
        )

    # queries (not used by the ingest code)
    def query_events(self, query: EventQuery, now: datetime) -> Page:
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def delete_expired(self, cutoff: datetime) -> list[str]:
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def list_tags(self, now: datetime) -> list[Count]:
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def list_groups(self, now: datetime) -> list[Count]:
        raise NotImplementedError(NOT_USED_BY_INGEST)

    # subscriptions
    def subscribe(self, subscriber_id: str, event_uri: str) -> None:
        self.subscriptions.add((subscriber_id, event_uri))

    def unsubscribe(self, subscriber_id: str, event_uri: str) -> None:
        self.subscriptions.discard((subscriber_id, event_uri))

    def subscribers_of(self, event_uri: str) -> list[str]:
        return sorted(
            subscriber
            for subscriber, subscribed_uri in self.subscriptions
            if subscribed_uri == event_uri
        )

    def subscriptions_of(self, subscriber_id: str) -> list[str]:
        return sorted(
            subscribed_uri
            for subscriber, subscribed_uri in self.subscriptions
            if subscriber == subscriber_id
        )

    # notifications
    def add_notification(self, notification: Notification) -> Notification:
        stored = notification.model_copy(
            update={"id": len(self.notifications) + 1}
        )
        self.notifications.append(stored)
        return stored

    def list_notifications(
        self, subscriber_id: str, since_id: int = 0
    ) -> list[Notification]:
        return [
            notification
            for notification in self.notifications
            if notification.subscriber_id == subscriber_id
            and (notification.id or 0) > since_id
        ]

    # cursors
    def get_cursor(self, name: str) -> int | None:
        return self.cursors.get(name)

    def set_cursor(self, name: str, value: int) -> None:
        self.cursors[name] = value


def _same_content(
    first_event: IndexedEvent, second_event: IndexedEvent
) -> bool:
    return (
        first_event.record,
        first_event.cid,
        first_event.author_handle,
    ) == (
        second_event.record,
        second_event.cid,
        second_event.author_handle,
    )


class FakeNotifier:
    """
    Records publish calls; with a store, also records whether the event
    still existed.
    """

    def __init__(self, store: FakeStore | None = None) -> None:
        self.store = store
        self.published: list[tuple[str, NotificationKind, str]] = []
        self.event_present: list[bool] = []

    async def publish(
        self, event_uri: str, kind: NotificationKind, message: str
    ) -> int:
        self.published.append((event_uri, kind, message))
        if self.store is not None:
            self.event_present.append(
                self.store.get_event(event_uri) is not None
            )
        return 1


class FakeResolver:
    def __init__(self, handles: dict[str, str]) -> None:
        self.handles = handles
        self.calls: list[str] = []

    async def resolve(self, did: str) -> str | None:
        self.calls.append(did)
        return self.handles.get(did)


def utc_datetime(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)
