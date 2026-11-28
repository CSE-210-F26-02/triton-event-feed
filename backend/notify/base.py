"""
Notifier interface: ingest calls publish(); the API streams results to
clients.
"""

from __future__ import annotations

from typing import Protocol

from models import NotificationKind


class Notifier(Protocol):
    """Anything that can tell an event's subscribers about a change."""

    async def publish(
        self, event_uri: str, kind: NotificationKind, message: str
    ) -> int:
        """
        Fan out to every subscriber of event_uri (persist + live push).

        Args:
            event_uri: the event the message is about.
            kind: what happened (updated, deleted, announcement, expired).
            message: human-readable text shown to subscribers.

        Returns:
            How many subscribers were notified.
        """
        ...
