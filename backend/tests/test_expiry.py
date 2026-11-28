import asyncio
from datetime import datetime, timedelta

from expiry import run_expiry_loop, sweep_once
from models import EventQuery, Page
from tests.ingest_fakes import FakeStore
from tests.settings_factory import make_test_settings


async def test_sweep_notifies_then_deletes(store, notifier, make_event, now):
    ended_event = make_event(
        "old", name="Taco Tuesday", start_in_hours=-3, end_in_hours=-1
    )
    live_event = make_event("live", start_in_hours=-1, end_in_hours=1)
    store.upsert_event(ended_event)
    store.upsert_event(live_event)
    store.subscribe("subscriber1", ended_event.uri)
    store.subscribe("subscriber1", live_event.uri)
    queue = notifier.connect("subscriber1")

    assert await sweep_once(store, notifier, now, grace_seconds=0) == [
        ended_event.uri
    ]

    [notification] = store.list_notifications("subscriber1")
    assert (
        notification.kind,
        notification.event_uri,
        notification.message,
    ) == ("expired", ended_event.uri, "Taco Tuesday has ended")
    assert queue.get_nowait() == notification
    assert store.get_event(ended_event.uri) is None
    assert store.get_event(live_event.uri) is not None


async def test_sweep_respects_grace(store, notifier, make_event, now):
    event = make_event(start_in_hours=-2, end_in_hours=-0.5)
    store.upsert_event(event)
    assert await sweep_once(store, notifier, now, grace_seconds=3600) == []
    assert await sweep_once(
        store, notifier, now + timedelta(hours=1), grace_seconds=3600
    ) == [event.uri]


async def test_sweep_many_pages(store, notifier, make_event, now):
    for index in range(130):
        store.upsert_event(
            make_event(f"e{index:03d}", start_in_hours=-3, end_in_hours=-1)
        )
    assert len(await sweep_once(store, notifier, now, grace_seconds=0)) == 130


class BoomStore(FakeStore):
    """A store whose every query fails, to prove the loop keeps going."""

    def __init__(self) -> None:
        """Start counting query attempts."""
        super().__init__()
        self.calls = 0

    def query_events(self, query: EventQuery, now: datetime) -> Page:
        """Count the attempt, then fail."""
        self.calls += 1
        raise RuntimeError("boom")


async def test_loop_survives_exceptions(notifier):
    store = BoomStore()
    settings = make_test_settings(expiry_interval_seconds=0)
    task = asyncio.create_task(run_expiry_loop(store, notifier, settings))
    for _attempt in range(20):
        await asyncio.sleep(0)
    task.cancel()
    assert store.calls >= 2
