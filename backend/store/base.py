"""
Storage interface. The SQLite implementation lives in store/sqlite.py.

Everything above this layer depends only on this Protocol, so the index can be
swapped (Postgres, in-memory for tests) without touching ingest or API code.
"""

from __future__ import annotations

from abc import abstractmethod
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
    """
    The index of events, listeners, subscriptions and notifications.
    """

    # events
    @abstractmethod
    def upsert_event(self, event: IndexedEvent) -> UpsertResult:
        """
        Insert or replace an event; report whether anything changed.

        :param event: the event to store.
        :returns: "created" for a new event, "updated" for a changed one, or
            "unchanged" when the stored copy is identical.
        """
        pass

    @abstractmethod
    def get_event(self, uri: str) -> IndexedEvent | None:
        """
        Look up one event.

        :param uri: the event's id (its AT URI).
        :returns: the event, or None when it is not in the index.
        """
        pass

    @abstractmethod
    def delete_event(self, uri: str) -> bool:
        """
        Delete an event and everything attached to it (tags, announcements,
        subscriptions). Publish the "deleted" notification before calling,
        while the subscribers can still be looked up.

        :param uri: the event's id (its AT URI).
        :returns: True when the event existed.
        """
        pass

    @abstractmethod
    def query_events(self, query: EventQuery, now: datetime) -> Page:
        """
        Return one page of the events that match a query.

        Events that ended before query.ends_after (default: now) are hidden.

        :param query: the filters, sort order, page size and paging cursor.
        :param now: the current time, used when query.ends_after is not set.
        :returns: the page of events and the cursor for the next page.
        :raises ValueError: when query.cursor is malformed.
        """
        pass

    @abstractmethod
    def delete_expired(self, cutoff: datetime) -> list[str]:
        """
        Delete every event that ended before a cutoff.

        :param cutoff: events whose endsAt is earlier than this are deleted.
        :returns: the ids (AT URIs) of the deleted events.
        """
        pass

    @abstractmethod
    def list_tags(self, now: datetime) -> list[Count]:
        """
        Count the events that are still visible, per tag.

        :param now: the current time; events that have ended are not counted.
        :returns: one Count per tag, most used first.
        """
        pass

    @abstractmethod
    def list_groups(self, now: datetime) -> list[Count]:
        """
        Count the events that are still visible, per group.

        :param now: the current time; events that have ended are not counted.
        :returns: one Count per group, most used first.
        """
        pass

    # updates (announcements)
    @abstractmethod
    def add_update(self, update: EventUpdate) -> None:
        """
        Store an announcement for an event.

        :param update: the announcement, e.g. from a host's Bluesky post.
        """
        pass

    @abstractmethod
    def list_updates(self, event_uri: str) -> list[EventUpdate]:
        """
        Return an event's announcements, oldest first.

        :param event_uri: the event's id (its AT URI).
        :returns: the announcements.
        """
        pass

    # listeners
    @abstractmethod
    def upsert_listener(self, listener: Listener) -> None:
        """
        Insert or replace a listener record.

        :param listener: the listener to store.
        """
        pass

    @abstractmethod
    def delete_listener(self, uri: str) -> bool:
        """
        Delete a listener.

        :param uri: the listener record's AT URI.
        :returns: True when the listener existed.
        """
        pass

    @abstractmethod
    def listeners_for_did(self, did: str) -> list[Listener]:
        """
        Return every listener created by one host.

        :param did: the host's permanent account id.
        :returns: their listeners, ordered by AT URI.
        """
        pass

    @abstractmethod
    def listener_dids(self) -> list[str]:
        """
        Return the account id (DID) of every host with a listener.

        The Jetstream client follows the Bluesky posts of exactly these
        accounts.

        :returns: the DIDs, sorted.
        """
        pass

    # subscriptions (subscriber_id is an opaque client id, never a location)
    @abstractmethod
    def subscribe(self, subscriber_id: str, event_uri: str) -> None:
        """
        Subscribe a client to an event (idempotent).

        :param subscriber_id: the client's opaque id.
        :param event_uri: the event's id (its AT URI).
        """
        pass

    @abstractmethod
    def unsubscribe(self, subscriber_id: str, event_uri: str) -> None:
        """
        Unsubscribe a client from an event (idempotent).

        :param subscriber_id: the client's opaque id.
        :param event_uri: the event's id (its AT URI).
        """
        pass

    @abstractmethod
    def subscribers_of(self, event_uri: str) -> list[str]:
        """
        Return every client subscribed to an event.

        :param event_uri: the event's id (its AT URI).
        :returns: the subscriber ids, sorted.
        """
        pass

    @abstractmethod
    def subscriptions_of(self, subscriber_id: str) -> list[str]:
        """
        Return every event a client is subscribed to.

        :param subscriber_id: the client's opaque id.
        :returns: the events' ids (AT URIs), sorted.
        """
        pass

    # notifications
    @abstractmethod
    def add_notification(self, notification: Notification) -> Notification:
        """
        Save a notification.

        :param notification: the notification to save (its id is ignored).
        :returns: the saved notification, with its new id set.
        """
        pass

    @abstractmethod
    def list_notifications(
        self, subscriber_id: str, since_id: int = 0
    ) -> list[Notification]:
        """
        Return a client's notifications newer than since_id, oldest first.

        :param subscriber_id: the client's opaque id.
        :param since_id: the id of the last notification the client has seen.
        :returns: the notifications with an id greater than since_id.
        """
        pass

    # ingest cursors: how far through a live feed we have read, so a restart
    # resumes there (e.g. the Jetstream time_us of the last message)
    @abstractmethod
    def get_cursor(self, name: str) -> int | None:
        """
        Return a saved ingest cursor.

        :param name: the cursor's name, e.g. "jetstream".
        :returns: the saved position, or None when nothing was saved yet.
        """
        pass

    @abstractmethod
    def set_cursor(self, name: str, value: int) -> None:
        """
        Save an ingest cursor: how far through a live feed we have read.

        :param name: the cursor's name, e.g. "jetstream".
        :param value: the position, e.g. a Jetstream time_us.
        """
        pass
