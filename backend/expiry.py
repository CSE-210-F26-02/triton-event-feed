"""Periodic removal of ended events, notifying subscribers first."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from config import Settings
from models import MAX_PAGE_SIZE, EventQuery, IndexedEvent
from notify.base import Notifier
from store.base import EventStore

logger = logging.getLogger(__name__)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _as_utc(moment: datetime) -> datetime:
    """Treat a naive datetime as UTC; leave aware ones unchanged."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment


def _expired_events(store: EventStore, cutoff: datetime) -> list[IndexedEvent]:
    """
    Return every event with endsAt < cutoff, page by page.

    Args:
        store: the event store to search.
        cutoff: events that ended before this moment are expired.

    Returns:
        The expired events.
    """
    expired: list[IndexedEvent] = []
    query = EventQuery(
        starts_before=cutoff, ends_after=_EPOCH, limit=MAX_PAGE_SIZE
    )
    while True:
        page = store.query_events(query, cutoff)
        expired += [
            event
            for event in page.events
            if _as_utc(event.record.ends_at) < cutoff
        ]
        if page.cursor is None:
            return expired
        query = query.model_copy(update={"cursor": page.cursor})


async def _notify_and_unsubscribe(
    store: EventStore, notifier: Notifier, event: IndexedEvent
) -> None:
    """Tell an expired event's subscribers it has ended, then drop them."""
    subscribers = store.subscribers_of(event.uri)
    if not subscribers:
        return
    await notifier.publish(
        event.uri, "expired", f"{event.record.name} has ended"
    )
    for subscriber in subscribers:
        store.unsubscribe(subscriber, event.uri)


async def sweep_once(
    store: EventStore,
    notifier: Notifier,
    now: datetime,
    grace_seconds: int,
    purge_days: float = 0.0,
) -> list[str]:
    """
    Notify subscribers of newly ended events and purge old ones.

    Args:
        store: the event store.
        notifier: tells subscribers their event has ended.
        now: the current time.
        grace_seconds: how long after endsAt an event counts as ended.
        purge_days: how long after that an event is deleted.

    Returns:
        The URIs of the deleted events.
    """
    expiry_cutoff = _as_utc(now) - timedelta(seconds=grace_seconds)
    for event in _expired_events(store, expiry_cutoff):
        await _notify_and_unsubscribe(store, notifier, event)

    purge_cutoff = expiry_cutoff - timedelta(days=purge_days)
    removed = store.delete_expired(purge_cutoff)
    if removed:
        logger.info("purged %d expired event(s)", len(removed))
    return removed


async def run_expiry_loop(
    store: EventStore, notifier: Notifier, settings: Settings
) -> None:
    """
    Run sweep_once forever; a failed sweep is logged, not fatal.

    Args:
        store: the event store.
        notifier: tells subscribers their event has ended.
        settings: supplies the grace period, purge age and interval.
    """
    while True:
        try:
            await sweep_once(
                store,
                notifier,
                datetime.now(UTC),
                settings.expiry_grace_seconds,
                settings.expiry_purge_days,
            )
        except Exception:
            logger.exception("expiry sweep failed")
        await asyncio.sleep(settings.expiry_interval_seconds)
