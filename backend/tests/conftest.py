"""
Shared pytest fixtures: an in-memory SQLite store, the real notifier, an
event factory and an API test client.
"""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import events, meta, subscriptions
from config import Settings
from models import EVENT_NSID, EventRecord, IndexedEvent, Location
from notify.service import SubscriptionNotifier
from store.sqlite import SqliteStore
from tests.settings_factory import make_test_settings

MakeEvent = Callable[..., IndexedEvent]


@pytest.fixture
def now() -> datetime:
    """
    The current time, without microseconds (so it survives a round trip).

    :returns: an aware UTC datetime.
    """
    return datetime.now(UTC).replace(microsecond=0)


@pytest.fixture
def store() -> Iterator[SqliteStore]:
    """
    A fresh in-memory SQLite event index for one test.

    :yields: the store; it is closed after the test.
    """
    sqlite_store = SqliteStore(":memory:")
    yield sqlite_store
    sqlite_store.close()


@pytest.fixture
def notifier(store: SqliteStore) -> SubscriptionNotifier:
    """
    The real notifier, writing to the test's store.

    :param store: the test's event index.
    :returns: the notifier.
    """
    return SubscriptionNotifier(store)


@pytest.fixture
def make_event(now: datetime) -> MakeEvent:
    """
    A factory that builds IndexedEvents; times are hour offsets from `now`.

    :param now: the test's current time.
    :returns: the factory function.
    """

    def _make_event(
        rkey: str = "e1",
        *,
        name: str = "Test Event",
        start_in_hours: float = 1,
        end_in_hours: float = 2,
        tags: list[str] | None = None,
        group: str | None = None,
        description: str = "",
        location: str = "Price Center",
        cid: str | None = "bafy1",
        did: str = "did:plc:test",
        **extra: Any,
    ) -> IndexedEvent:
        """
        Build one network event for a test.

        :param rkey: the record key, the last part of the event's AT URI.
        :param name: the event's name.
        :param start_in_hours: hours from now until it starts.
        :param end_in_hours: hours from now until it ends.
        :param tags: its tags.
        :param group: its group.
        :param description: its description.
        :param location: its place name.
        :param cid: its version fingerprint.
        :param did: the author's permanent account id.
        :param extra: other IndexedEvent fields to set, e.g. author_handle.
        :returns: the event.
        """
        record = EventRecord(
            name=name,
            description=description,
            starts_at=now + timedelta(hours=start_in_hours),
            ends_at=now + timedelta(hours=end_in_hours),
            location=Location(name=location, lat="32.8797", lng="-117.2362"),
            tags=tags or [],
            group=group,
            created_at=now,
        )
        fields: dict[str, Any] = {
            "indexed_at": now,
            "updated_at": now,
            **extra,
        }
        return IndexedEvent(
            uri=f"at://{did}/{EVENT_NSID}/{rkey}",
            cid=cid,
            author_did=did,
            record=record,
            **fields,
        )

    return _make_event


@pytest.fixture
def settings() -> Settings:
    """
    Valid backend settings for the API tests, with dev mode on.

    :returns: the settings.
    """
    return make_test_settings(dev_mode=True)


@pytest.fixture
def app(
    store: SqliteStore, notifier: SubscriptionNotifier, settings: Settings
) -> FastAPI:
    """
    A FastAPI app with the event, meta and subscription routes.

    :param store: the test's event index.
    :param notifier: the test's notifier.
    :param settings: the test's settings.
    :returns: the app, without background loops.
    """
    app = FastAPI()
    for module in (meta, events, subscriptions):
        app.include_router(module.router)
    app.state.store = store
    app.state.notifier = notifier
    app.state.settings = settings
    return app


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """
    An HTTP test client for the app.

    :param app: the app under test.
    :yields: the client, open for the length of the test.
    """
    with TestClient(app) as test_client:
        yield test_client
