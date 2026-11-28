"""
Jetstream (JSON firehose) client: feeds commit messages to a
CommitProcessor.

Two connections:
  * "events": wantedCollections = event + listener NSIDs, all DIDs.
  * "posts":  wantedCollections = app.bsky.feed.post,
    wantedDids = store.listener_dids(). Only runs while there are listeners
    and is restarted when that set changes; we never subscribe to the full
    Bluesky post stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any
from urllib.parse import urlencode

import websockets

from ingest.processor import CommitProcessor
from models import EVENT_NSID, LISTENER_NSID, POST_NSID
from store.base import EventStore

logger = logging.getLogger(__name__)

# Replay the last 5s on resume; processing is idempotent.
REWIND_MICROSECONDS = 5_000_000
# Jetstream's limit on wantedDids.
MAX_WANTED_DIDS = 10_000
DEFAULT_CURSOR_NAME = "jetstream"
POSTS_CURSOR_SUFFIX = ":posts"
BACKOFF_INITIAL_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 60.0
CURSOR_SAVE_EVERY_MESSAGES = 100
CURSOR_SAVE_INTERVAL_SECONDS = 5.0

MessageStream = AbstractAsyncContextManager[AsyncIterator[str | bytes]]
Connect = Callable[[str], MessageStream]
Sleep = Callable[[float], Awaitable[None]]


def parse_message(raw_frame: str | bytes) -> dict[str, Any] | None:
    """Decode one Jetstream frame, or None if it is not a JSON object."""
    try:
        message = json.loads(raw_frame)
    except (ValueError, UnicodeDecodeError):
        return None
    return message if isinstance(message, dict) else None


def resume_cursor(stored: int | None) -> int | None:
    """
    Where to resume: a little before the saved cursor (or the live
    tip when nothing is saved).
    """
    return None if stored is None else max(stored - REWIND_MICROSECONDS, 0)


class Backoff:
    """Exponential backoff: 1s, 2s, 4s ... capped at 60s."""

    def __init__(
        self,
        initial_delay_seconds: float = BACKOFF_INITIAL_SECONDS,
        max_delay_seconds: float = BACKOFF_CAP_SECONDS,
    ) -> None:
        """Start at initial seconds, doubling up to cap."""
        self.initial_delay_seconds, self.max_delay_seconds = (
            initial_delay_seconds,
            max_delay_seconds,
        )
        self.current = initial_delay_seconds

    def next_delay(self) -> float:
        """Return the next delay and double the one after it."""
        delay = self.current
        self.current = min(self.current * 2, self.max_delay_seconds)
        return delay

    def reset(self) -> None:
        """Go back to the initial delay (after a healthy connection)."""
        self.current = self.initial_delay_seconds


class CursorSaver:
    """
    Tracks the latest time_us and persists it every `every` messages or
    every `interval_seconds`.
    """

    def __init__(
        self,
        store: EventStore,
        name: str,
        every: int = CURSOR_SAVE_EVERY_MESSAGES,
        interval_seconds: float = CURSOR_SAVE_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Create a saver for the cursor called name in store."""
        self.store, self.name = store, name
        self.every, self.interval_seconds = every, interval_seconds
        self.clock = clock
        self.latest: int | None = None
        self._pending = 0
        self._last_save = clock()

    def seen(self, time_us: Any) -> None:
        """Record a processed message's time_us; save if it is time to."""
        if not isinstance(time_us, int):
            return
        self.latest = max(time_us, self.latest or 0)
        self._pending += 1
        seconds_since_save = self.clock() - self._last_save
        if (
            self._pending >= self.every
            or seconds_since_save >= self.interval_seconds
        ):
            self.flush()

    def flush(self) -> None:
        """Save the latest cursor now, if anything new was seen."""
        if self.latest is not None and self._pending:
            self.store.set_cursor(self.name, self.latest)
        self._pending = 0
        self._last_save = self.clock()


class JetstreamClient:
    """
    Consumes Jetstream and feeds a CommitProcessor.

    Note: installs itself as processor.on_listeners_changed to restart the
    posts stream.
    """

    def __init__(
        self,
        url: str,
        processor: CommitProcessor,
        store: EventStore,
        cursor_name: str = DEFAULT_CURSOR_NAME,
        connect: Connect = websockets.connect,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        """
        Create a client (it connects only when run_forever is awaited).

        Args:
            url: the Jetstream subscribe endpoint.
            processor: handles every received message.
            store: holds the saved cursors and listener DIDs.
            cursor_name: name of the saved cursor for the events stream.
            connect: opens a WebSocket (injected for tests).
            sleep: waits between reconnects (injected for tests).
        """
        self.url = url
        self.processor = processor
        self.store = store
        self.cursor_name = cursor_name
        self.connect = connect
        self.sleep = sleep
        self._dids_changed = asyncio.Event()
        processor.on_listeners_changed = self.listeners_changed

    def build_url(
        self, collections: list[str], dids: list[str], cursor: int | None
    ) -> str:
        """Build the subscribe URL with its query-string filters."""
        params: list[tuple[str, str]] = [
            ("wantedCollections", collection) for collection in collections
        ]
        params += [("wantedDids", did) for did in dids]
        if cursor is not None:
            params.append(("cursor", str(cursor)))
        if not params:
            return self.url
        separator = "&" if "?" in self.url else "?"
        return f"{self.url}{separator}{urlencode(params)}"

    def listeners_changed(self, dids: list[str]) -> None:
        """Ask the posts stream to reconnect with the new DID list."""
        self._dids_changed.set()

    async def run_forever(self) -> None:
        """Run the events stream and the posts stream until cancelled."""
        await asyncio.gather(
            self.run_stream(self.cursor_name, [EVENT_NSID, LISTENER_NSID], []),
            self._run_posts(),
        )

    async def run_stream(
        self, name: str, collections: list[str], dids: list[str]
    ) -> None:
        """Consume one subscription forever, reconnecting with backoff."""
        backoff = Backoff()
        while True:
            try:
                if await self.consume_once(name, collections, dids):
                    backoff.reset()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # network errors, bad handshakes...
                logger.warning("jetstream %s disconnected: %r", name, error)
            await self.sleep(backoff.next_delay())

    async def consume_once(
        self, name: str, collections: list[str], dids: list[str]
    ) -> int:
        """
        One connection: resume from the stored cursor and process until
        closed. Returns the number of messages received.
        """
        saver = CursorSaver(self.store, name)
        cursor = resume_cursor(self.store.get_cursor(name))
        url = self.build_url(collections, dids, cursor)
        count = 0
        try:
            async with self.connect(url) as websocket:
                logger.info("jetstream %s connected", name)
                async for raw_frame in websocket:
                    count += 1
                    await self._process(raw_frame, saver)
        finally:
            saver.flush()
        return count

    async def _process(
        self, raw_frame: str | bytes, saver: CursorSaver
    ) -> None:
        """Handle one frame; a failure is logged, not fatal."""
        message = parse_message(raw_frame)
        if message is None:
            return
        try:
            await self.processor.handle(message)
        except Exception:
            logger.exception("failed to process jetstream message")
        saver.seen(message.get("time_us"))

    async def _run_posts(self) -> None:
        """
        Run the posts stream for the current listener DIDs, restarting
        it whenever that set changes.
        """
        name = f"{self.cursor_name}{POSTS_CURSOR_SUFFIX}"
        while True:
            self._dids_changed.clear()
            dids = self.store.listener_dids()[:MAX_WANTED_DIDS]
            task = None
            if dids:
                task = asyncio.create_task(
                    self.run_stream(name, [POST_NSID], dids)
                )
            try:
                await self._dids_changed.wait()
            finally:
                if task is not None:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
