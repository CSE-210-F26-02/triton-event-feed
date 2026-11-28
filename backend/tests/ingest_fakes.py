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
    """
    In-memory EventStore for the ingest tests.
    """

    def __init__(self) -> None:
        """
        Start with no events, listeners, subscriptions or cursors.
        """
        self.events: dict[str, IndexedEvent] = {}
        self.updates: list[EventUpdate] = []
        self.listeners: dict[str, Listener] = {}
        self.cursors: dict[str, int] = {}
        self.subscriptions: set[tuple[str, str]] = set()
        self.notifications: list[Notification] = []

    # events
    def upsert_event(self, event: IndexedEvent) -> UpsertResult:
        """
        Insert or replace an event; report whether anything changed.

        :param event: the event to store.
        :returns: "created" for a new event, "updated" for a changed one, or
            "unchanged" when the stored copy is identical.
        """
        previous_event = self.events.get(event.uri)
        if previous_event is not None and _same_content(previous_event, event):
            return "unchanged"
        self.events[event.uri] = event
        return "created" if previous_event is None else "updated"

    def get_event(self, uri: str) -> IndexedEvent | None:
        """
        Look up one event.

        :param uri: the event's id (its AT URI).
        :returns: the event, or None when it is not in the index.
        """
        return self.events.get(uri)

    def delete_event(self, uri: str) -> bool:
        """
        Delete an event.

        :param uri: the event's id (its AT URI).
        :returns: True when the event existed.
        """
        return self.events.pop(uri, None) is not None

    # updates
    def add_update(self, update: EventUpdate) -> None:
        """
        Store an announcement for an event.

        :param update: the announcement, e.g. from a host's Bluesky post.
        """
        self.updates.append(update)

    def list_updates(self, event_uri: str) -> list[EventUpdate]:
        """
        Return an event's announcements, oldest first.

        :param event_uri: the event's id (its AT URI).
        :returns: the announcements.
        """
        return [
            update for update in self.updates if update.event_uri == event_uri
        ]

    # listeners
    def upsert_listener(self, listener: Listener) -> None:
        """
        Insert or replace a listener record.

        :param listener: the listener to store.
        """
        self.listeners[listener.uri] = listener

    def delete_listener(self, uri: str) -> bool:
        """
        Delete a listener.

        :param uri: the listener record's AT URI.
        :returns: True when the listener existed.
        """
        return self.listeners.pop(uri, None) is not None

    def listeners_for_did(self, did: str) -> list[Listener]:
        """
        Return every listener created by one host.

        :param did: the host's permanent account id.
        :returns: their listeners, ordered by AT URI.
        """
        return [
            listener
            for listener in self.listeners.values()
            if listener.author_did == did
        ]

    def listener_dids(self) -> list[str]:
        """
        Return the account id (DID) of every host with a listener.

        The Jetstream client follows the Bluesky posts of exactly these
        accounts.

        :returns: the DIDs, sorted.
        """
        return sorted(
            {listener.author_did for listener in self.listeners.values()}
        )

    # queries (not used by the ingest code)
    def query_events(self, query: EventQuery, now: datetime) -> Page:
        """
        Return one page of the events that match a query. (not faked)

        Events that ended before query.ends_after (default: now) are hidden.

        :param query: the filters, sort order, page size and paging cursor.
        :param now: the current time, used when query.ends_after is not set.
        :raises NotImplementedError: always; the ingest code never calls it.
        """
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def delete_expired(self, cutoff: datetime) -> list[str]:
        """
        Delete every event that ended before a cutoff. (not faked)

        :param cutoff: events whose endsAt is earlier than this are deleted.
        :raises NotImplementedError: always; the ingest code never calls it.
        """
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def list_tags(self, now: datetime) -> list[Count]:
        """
        Count the events that are still visible, per tag. (not faked)

        :param now: the current time; events that have ended are not counted.
        :raises NotImplementedError: always; the ingest code never calls it.
        """
        raise NotImplementedError(NOT_USED_BY_INGEST)

    def list_groups(self, now: datetime) -> list[Count]:
        """
        Count the events that are still visible, per group. (not faked)

        :param now: the current time; events that have ended are not counted.
        :raises NotImplementedError: always; the ingest code never calls it.
        """
        raise NotImplementedError(NOT_USED_BY_INGEST)

    # subscriptions
    def subscribe(self, subscriber_id: str, event_uri: str) -> None:
        """
        Subscribe a client to an event (idempotent).

        :param subscriber_id: the client's opaque id.
        :param event_uri: the event's id (its AT URI).
        """
        self.subscriptions.add((subscriber_id, event_uri))

    def unsubscribe(self, subscriber_id: str, event_uri: str) -> None:
        """
        Unsubscribe a client from an event (idempotent).

        :param subscriber_id: the client's opaque id.
        :param event_uri: the event's id (its AT URI).
        """
        self.subscriptions.discard((subscriber_id, event_uri))

    def subscribers_of(self, event_uri: str) -> list[str]:
        """
        Return every client subscribed to an event.

        :param event_uri: the event's id (its AT URI).
        :returns: the subscriber ids, sorted.
        """
        return sorted(
            subscriber
            for subscriber, subscribed_uri in self.subscriptions
            if subscribed_uri == event_uri
        )

    def subscriptions_of(self, subscriber_id: str) -> list[str]:
        """
        Return every event a client is subscribed to.

        :param subscriber_id: the client's opaque id.
        :returns: the events' ids (AT URIs), sorted.
        """
        return sorted(
            subscribed_uri
            for subscriber, subscribed_uri in self.subscriptions
            if subscriber == subscriber_id
        )

    # notifications
    def add_notification(self, notification: Notification) -> Notification:
        """
        Save a notification.

        :param notification: the notification to save (its id is ignored).
        :returns: the saved notification, with its new id set.
        """
        stored = notification.model_copy(
            update={"id": len(self.notifications) + 1}
        )
        self.notifications.append(stored)
        return stored

    def list_notifications(
        self, subscriber_id: str, since_id: int = 0
    ) -> list[Notification]:
        """
        Return a client's notifications newer than since_id, oldest first.

        :param subscriber_id: the client's opaque id.
        :param since_id: the id of the last notification the client has seen.
        :returns: the notifications with an id greater than since_id.
        """
        return [
            notification
            for notification in self.notifications
            if notification.subscriber_id == subscriber_id
            and (notification.id or 0) > since_id
        ]

    # cursors
    def get_cursor(self, name: str) -> int | None:
        """
        Return a saved ingest cursor.

        :param name: the cursor's name, e.g. "jetstream".
        :returns: the saved position, or None when nothing was saved yet.
        """
        return self.cursors.get(name)

    def set_cursor(self, name: str, value: int) -> None:
        """
        Save an ingest cursor: how far through a live feed we have read.

        :param name: the cursor's name, e.g. "jetstream".
        :param value: the position, e.g. a Jetstream time_us.
        """
        self.cursors[name] = value


def _same_content(
    first_event: IndexedEvent, second_event: IndexedEvent
) -> bool:
    """
    Check whether two versions of an event hold the same content.

    Mirrors SqliteStore.upsert_event, which reports "unchanged" for these.

    :param first_event: one version.
    :param second_event: the other version.
    :returns: True when the record, cid and author handle all match.
    """
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
        """
        Start with no recorded calls.

        :param store: when given, each publish also records whether the event
            was still in this store at that moment.
        """
        self.store = store
        self.published: list[tuple[str, NotificationKind, str]] = []
        self.event_present: list[bool] = []

    async def publish(
        self, event_uri: str, kind: NotificationKind, message: str
    ) -> int:
        """
        Record one publish call instead of notifying anyone.

        :param event_uri: the event's id (its AT URI).
        :param kind: what happened, e.g. "updated".
        :param message: the readable text.
        :returns: 1, as if one subscriber was notified.
        """
        self.published.append((event_uri, kind, message))
        if self.store is not None:
            self.event_present.append(
                self.store.get_event(event_uri) is not None
            )
        return 1


class FakeResolver:
    """
    HandleLookup fake: answers from a fixed table and records every call.
    """

    def __init__(self, handles: dict[str, str]) -> None:
        """
        Answer lookups from a fixed table.

        :param handles: handle by DID, e.g. {"did:plc:a": "alice.test"}.
        """
        self.handles = handles
        self.calls: list[str] = []

    async def resolve(self, did: str) -> str | None:
        """
        Look up a handle in the table and record the call.

        :param did: the account's permanent id.
        :returns: the handle, or None when the table has none.
        """
        self.calls.append(did)
        return self.handles.get(did)


def utc_datetime(*args: int) -> datetime:
    """
    Build an aware UTC datetime.

    :param args: year, month, day and optionally hour, minute, ...
    :returns: e.g. utc_datetime(2026, 12, 1, 18) is 18:00 UTC on Dec 1.
    """
    return datetime(*args, tzinfo=UTC)
