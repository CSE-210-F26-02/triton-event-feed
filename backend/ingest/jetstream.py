"""
Listens to the live AT Protocol network and feeds record changes to the
CommitProcessor.

Background for newcomers (full glossary:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md): hosts write their
events into their own accounts, not into our database. Every create, edit or
delete of a record anywhere on the network (a "commit") is broadcast on one
huge live stream, the "firehose". Jetstream is a free public service that
re-sends that stream as simple JSON over a WebSocket and lets us filter it:

  * wantedCollections: only records of these types (NSIDs), e.g.
    "app.communitymap.event";
  * wantedDids: only changes made by these accounts (by permanent id).

We open two filtered connections:

  * "events": every account's event and listener records.
  * "posts": Bluesky posts (app.bsky.feed.post), but only from hosts that
    have a listener (store.listener_dids()). It only runs while there are
    listeners and restarts whenever that set of hosts changes, so we never
    download the whole network's posts.

Each message carries a timestamp in microseconds ("time_us"). We save the
latest one as a "cursor", so after a restart Jetstream replays what we
missed instead of starting from now.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterable, Awaitable, Callable
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
# Most accounts Jetstream accepts in one wantedDids filter.
MAX_WANTED_DIDS = 10_000
DEFAULT_CURSOR_NAME = "jetstream"
POSTS_CURSOR_SUFFIX = ":posts"
BACKOFF_INITIAL_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 60.0
CURSOR_SAVE_EVERY_MESSAGES = 100
CURSOR_SAVE_INTERVAL_SECONDS = 5.0

# A connection yields raw frames; websockets.connect() opens one.
MessageStream = AbstractAsyncContextManager[AsyncIterable[str | bytes]]
Connect = Callable[[str], MessageStream]
Sleep = Callable[[float], Awaitable[None]]


def parse_message(raw_frame: str | bytes) -> dict[str, Any] | None:
    """
    Decode one WebSocket frame from Jetstream.

    :param raw_frame: the frame as received (JSON text).
    :returns: the message, or None if it is not a JSON object.
    """
    try:
        message = json.loads(raw_frame)
    except (ValueError, UnicodeDecodeError):
        return None
    return message if isinstance(message, dict) else None


def resume_cursor(stored: int | None) -> int | None:
    """
    Where in the stream to resume after a restart.

    :param stored: the saved cursor (a Jetstream time_us, in microseconds
        since 1970), or None when nothing has been saved yet.
    :returns: a time a few seconds before the saved cursor, so nothing is
        missed (replaying a change twice is harmless), or None to start
        from the live end of the stream.
    """
    return None if stored is None else max(stored - REWIND_MICROSECONDS, 0)


class Backoff:
    """
    Exponential backoff: 1s, 2s, 4s ... capped at 60s.
    """

    def __init__(
        self,
        initial_delay_seconds: float = BACKOFF_INITIAL_SECONDS,
        max_delay_seconds: float = BACKOFF_CAP_SECONDS,
    ) -> None:
        """
        Start at the initial delay, doubling up to the maximum.

        :param initial_delay_seconds: the first delay.
        :param max_delay_seconds: the longest delay.
        """
        self.initial_delay_seconds, self.max_delay_seconds = (
            initial_delay_seconds,
            max_delay_seconds,
        )
        self.current = initial_delay_seconds

    def next_delay(self) -> float:
        """
        Return the next delay and double the one after it.

        :returns: seconds to wait before the next reconnect.
        """
        delay = self.current
        self.current = min(self.current * 2, self.max_delay_seconds)
        return delay

    def reset(self) -> None:
        """
        Go back to the initial delay (after a healthy connection).
        """
        self.current = self.initial_delay_seconds


class CursorSaver:
    """
    Remembers how far through the stream we are, so a restart resumes there.

    Tracks the latest message timestamp (time_us) and saves it to the store
    every `every` messages or every `interval_seconds`, whichever is first.
    """

    def __init__(
        self,
        store: EventStore,
        name: str,
        every: int = CURSOR_SAVE_EVERY_MESSAGES,
        interval_seconds: float = CURSOR_SAVE_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Create a saver for one named cursor.

        :param store: where the cursor is saved.
        :param name: the cursor's name, e.g. "jetstream".
        :param every: save after this many messages.
        :param interval_seconds: or after this many seconds, whichever is
            first.
        :param clock: returns monotonic seconds (injected for tests).
        """
        self.store, self.name = store, name
        self.every, self.interval_seconds = every, interval_seconds
        self.clock = clock
        self.latest: int | None = None
        self._pending = 0
        self._last_save = clock()

    def seen(self, time_us: Any) -> None:
        """
        Note one processed message; save the cursor if it is time to.

        :param time_us: the message's Jetstream timestamp, in microseconds
            (untrusted; anything but an int is ignored).
        """
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
        """
        Save the latest cursor now, if anything new was seen.
        """
        if self.latest is not None and self._pending:
            self.store.set_cursor(self.name, self.latest)
        self._pending = 0
        self._last_save = self.clock()


class JetstreamClient:
    """
    Keeps our Jetstream connections open and feeds every message to a
    CommitProcessor.

    Note: installs itself as processor.on_listeners_changed, so the posts
    connection restarts whenever the set of hosts with a listener changes.
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

        :param url: the Jetstream WebSocket address (its /subscribe URL).
        :param processor: handles every received message.
        :param store: holds the saved cursors and the account ids (DIDs) of
            hosts with a listener.
        :param cursor_name: name of the saved cursor for the events stream.
        :param connect: opens a WebSocket (injected for tests).
        :param sleep: waits between reconnects (injected for tests).
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
        """
        Build the Jetstream URL with its filters.

        :param collections: record types (NSIDs) to receive.
        :param dids: accounts to receive changes from (empty means all).
        :param cursor: where to resume (time_us), or None for "from now".
        :returns: the URL to connect to.
        """
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
        """
        Ask the posts connection to reconnect with the new list of hosts.

        :param dids: the account ids of every host that has a listener.
        """
        self._dids_changed.set()

    async def run_forever(self) -> None:
        """
        Run the events stream and the posts stream until cancelled.
        """
        await asyncio.gather(
            self.run_stream(self.cursor_name, [EVENT_NSID, LISTENER_NSID], []),
            self._run_posts(),
        )

    async def run_stream(
        self, name: str, collections: list[str], dids: list[str]
    ) -> None:
        """
        Keep one filtered connection open forever, reconnecting with backoff.

        :param name: the name its cursor is saved under.
        :param collections: record types (NSIDs) to receive.
        :param dids: accounts to receive changes from (empty means all).
        """
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
        Open one connection, resume from the saved cursor, and process
        messages until it closes.

        :param name: the name its cursor is saved under.
        :param collections: record types (NSIDs) to receive.
        :param dids: accounts to receive changes from (empty means all).
        :returns: the number of messages received.
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
        """
        Handle one frame; a failure is logged, not fatal.

        :param raw_frame: the frame as received.
        :param saver: notes the message's time_us once it is processed.
        """
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
        Follow the Bluesky posts of every host that has a listener.

        Restarts the connection whenever that set of hosts changes, because
        Jetstream's account filter is fixed for the life of a connection.
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
