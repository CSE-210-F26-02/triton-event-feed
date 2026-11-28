"""
Notifier that persists one Notification per subscriber and pushes it to
live SSE queues.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from models import Notification, NotificationKind
from store.base import EventStore

logger = logging.getLogger(__name__)

QUEUE_MAXSIZE = 100


class SubscriptionNotifier:
    """
    Stores notifications and pushes them to connected SSE clients.
    """

    def __init__(self, store: EventStore) -> None:
        """
        Create a notifier that persists into store.

        :param store: where notifications and subscriptions live.
        """
        self._store = store
        self._queues: dict[str, set[asyncio.Queue[Notification]]] = {}

    async def publish(
        self, event_uri: str, kind: NotificationKind, message: str
    ) -> int:
        """
        Save and push one notification per subscriber of an event.

        :param event_uri: the event's id (its AT URI).
        :param kind: what happened, e.g. "updated" or "deleted".
        :param message: the readable text shown to the subscriber.
        :returns: how many subscribers were notified.
        """
        now = datetime.now(UTC)
        subscribers = self._store.subscribers_of(event_uri)
        for subscriber in subscribers:
            notification = self._store.add_notification(
                Notification(
                    subscriber_id=subscriber,
                    event_uri=event_uri,
                    kind=kind,
                    message=message,
                    created_at=now,
                )
            )
            self._push(subscriber, notification)
        return len(subscribers)

    def _push(self, subscriber_id: str, notification: Notification) -> None:
        """
        Queue a notification on every live connection of a subscriber.

        A full queue (a slow client) drops the live copy; the stored
        notification is still delivered when the client catches up.

        :param subscriber_id: the subscriber's opaque id.
        :param notification: the saved notification.
        """
        for queue in self._queues.get(subscriber_id, ()):
            try:
                queue.put_nowait(notification)
            except asyncio.QueueFull:
                logger.warning(
                    "dropping live notification for slow client %s",
                    subscriber_id,
                )

    def connect(self, subscriber_id: str) -> asyncio.Queue[Notification]:
        """
        Register a live connection.

        :param subscriber_id: the subscriber's opaque id.
        :returns: the queue that the connection's notifications arrive on.
        """
        queue: asyncio.Queue[Notification] = asyncio.Queue(
            maxsize=QUEUE_MAXSIZE
        )
        self._queues.setdefault(subscriber_id, set()).add(queue)
        return queue

    def disconnect(
        self, subscriber_id: str, queue: asyncio.Queue[Notification]
    ) -> None:
        """
        Forget a live connection (safe to call more than once).

        :param subscriber_id: the subscriber's opaque id.
        :param queue: the queue that connect returned.
        """
        queues = self._queues.get(subscriber_id)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            del self._queues[subscriber_id]
