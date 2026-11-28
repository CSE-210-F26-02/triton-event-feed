"""
In-memory fakes of the EventStore / Notifier Protocols used by the
ingest tests.
"""

from __future__ import annotations

from datetime import UTC, datetime

from models import EventUpdate, IndexedEvent, Listener, NotificationKind
from store.base import UpsertResult


class FakeStore:
    def __init__(self) -> None:
        self.events: dict[str, IndexedEvent] = {}
        self.updates: list[EventUpdate] = []
        self.listeners: dict[str, Listener] = {}
        self.cursors: dict[str, int] = {}

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
