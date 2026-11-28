"""
Tests for the Jetstream client (ingest/jetstream.py): filtered URLs,
cursors, reconnects and the listener-driven posts stream. The WebSocket is
faked.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from ingest.jetstream import (
    Backoff,
    CursorSaver,
    JetstreamClient,
    parse_message,
    resume_cursor,
)
from ingest.processor import CommitProcessor
from models import EVENT_NSID, LISTENER_NSID, POST_NSID
from tests.ingest_fakes import FakeNotifier, FakeStore

JETSTREAM_BASE_URL = "wss://js.example/subscribe"
AUTHOR_DID = "did:plc:alice"


class FakeConnect:
    """
    Each call pops a script: a list of raw messages, or an Exception to
    raise on connect.
    """

    def __init__(self, scripts: list[list[str] | Exception]) -> None:
        """
        Queue the scripts, one per connection attempt.

        :param scripts: per connection, the raw messages it delivers or the
            Exception it raises.
        """
        self.scripts = scripts
        self.urls: list[str] = []

    def __call__(self, url: str) -> Any:
        """
        Open a fake connection, like websockets.connect(url).

        :param url: the URL the client asked for; recorded in self.urls.
        :returns: an async context manager yielding the scripted messages (an
            empty connection once the scripts run out).
        """
        self.urls.append(url)
        script = self.scripts.pop(0) if self.scripts else []
        connect_error = script if isinstance(script, Exception) else None
        messages = [] if isinstance(script, Exception) else script

        @asynccontextmanager
        async def connection_context() -> AsyncIterator[AsyncIterator[str]]:
            """
            The fake connection's lifetime.

            :yields: the scripted messages, once connected.
            :raises Exception: the scripted connection error, if there is one.
            """
            if connect_error is not None:
                raise connect_error

            async def message_stream() -> AsyncIterator[str]:
                """
                Deliver the scripted messages, then end like a closed socket.

                :yields: each raw message.
                """
                for message in messages:
                    yield message

            yield message_stream()

        return connection_context()


class StopAfter:
    """
    Fake sleep: records delays, cancels the loop after sleep_limit
    sleeps.
    """

    def __init__(self, sleep_limit: int) -> None:
        """
        Allow sleep_limit sleeps before stopping the loop.

        :param sleep_limit: how many sleeps to allow.
        """
        self.sleep_limit = sleep_limit
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        """
        Record a delay instead of waiting it out.

        :param delay: the requested delay, in seconds.
        :raises asyncio.CancelledError: once sleep_limit sleeps were requested,
            which ends the client's reconnect loop.
        """
        self.delays.append(delay)
        await asyncio.sleep(0)  # yield like a real sleep
        if len(self.delays) >= self.sleep_limit:
            raise asyncio.CancelledError


def make_client(
    connect: FakeConnect, sleep: StopAfter | None = None
) -> tuple[JetstreamClient, FakeStore]:
    """
    Build a JetstreamClient wired to fakes.

    :param connect: the fake WebSocket connector.
    :param sleep: the fake sleep (default: stop after one sleep).
    :returns: (the client, the fake store it reads and writes).
    """
    store = FakeStore()
    processor = CommitProcessor(store, FakeNotifier(store))
    client = JetstreamClient(
        JETSTREAM_BASE_URL,
        processor,
        store,
        connect=connect,
        sleep=sleep or StopAfter(1),
    )
    return client, store


def event_message(rkey: str, time_us: int) -> str:
    """
    Build one raw Jetstream message that creates an event record.

    :param rkey: the record key of the new event.
    :param time_us: the message's timestamp (becomes the cursor).
    :returns: the message as JSON text.
    """
    record = {
        "name": "Taco Night",
        "startsAt": "2026-11-12T18:00:00Z",
        "endsAt": "2026-11-12T20:00:00Z",
        "location": {"name": "Price Center"},
        "createdAt": "2026-11-11T00:00:00Z",
    }
    commit = {
        "operation": "create",
        "collection": EVENT_NSID,
        "rkey": rkey,
        "record": record,
    }
    return json.dumps(
        {
            "did": AUTHOR_DID,
            "time_us": time_us,
            "kind": "commit",
            "commit": commit,
        }
    )


def query(url: str) -> dict[str, list[str]]:
    """
    Read the query-string filters of a Jetstream URL.

    :param url: a URL built by JetstreamClient.build_url.
    :returns: every value by parameter name.
    """
    return parse_qs(urlsplit(url).query)


# ---- pure helpers -----------------------------------------------------------


def test_build_url() -> None:
    client, _store = make_client(FakeConnect([]))
    url = client.build_url(
        [EVENT_NSID, LISTENER_NSID], ["did:plc:a", "did:plc:b"], 123
    )
    assert url.startswith(JETSTREAM_BASE_URL + "?")
    params = query(url)
    assert params["wantedCollections"] == [EVENT_NSID, LISTENER_NSID]
    assert params["wantedDids"] == ["did:plc:a", "did:plc:b"]
    assert params["cursor"] == ["123"]
    assert client.build_url([], [], None) == JETSTREAM_BASE_URL


def test_parse_message() -> None:
    assert parse_message('{"kind":"commit"}') == {"kind": "commit"}
    assert parse_message(b'{"a":1}') == {"a": 1}
    assert parse_message("not json") is None
    assert parse_message("[1,2]") is None


def test_resume_cursor_rewinds_five_seconds() -> None:
    assert resume_cursor(None) is None
    assert resume_cursor(10_000_000) == 5_000_000
    assert resume_cursor(1) == 0


def test_backoff_doubles_and_caps() -> None:
    backoff = Backoff()
    delays = [backoff.next_delay() for _attempt in range(8)]
    assert delays == [1, 2, 4, 8, 16, 32, 60, 60]
    backoff.reset()
    assert backoff.next_delay() == 1


def test_cursor_saver_every_count_and_interval() -> None:
    store = FakeStore()
    now = [0.0]
    saver = CursorSaver(
        store, "js", every=3, interval_seconds=5, clock=lambda: now[0]
    )
    saver.seen(10)
    saver.seen(20)
    assert store.get_cursor("js") is None
    saver.seen(30)
    assert store.get_cursor("js") == 30
    saver.seen(40)
    now[0] = 6.0
    saver.seen(35)  # out-of-order time_us never moves the cursor backwards
    assert store.get_cursor("js") == 40
    saver.seen("bogus")
    saver.flush()
    assert store.get_cursor("js") == 40


# ---- connection behaviour ---------------------------------------------------


async def test_consume_processes_and_saves_cursor() -> None:
    connect = FakeConnect(
        [[event_message("a", 100), "garbage", event_message("b", 200)]]
    )
    client, store = make_client(connect)
    message_count = await client.consume_once("js", [EVENT_NSID], [])
    assert message_count == 3
    assert len(store.events) == 2
    assert store.get_cursor("js") == 200
    assert "cursor" not in query(connect.urls[0])


async def test_consume_resumes_from_rewound_cursor() -> None:
    connect = FakeConnect([[]])
    client, store = make_client(connect)
    store.set_cursor("js", 20_000_000)
    await client.consume_once("js", [EVENT_NSID], [])
    assert query(connect.urls[0])["cursor"] == ["15000000"]


async def test_processor_errors_do_not_drop_connection() -> None:
    connect = FakeConnect([[event_message("a", 100), event_message("b", 200)]])
    client, store = make_client(connect)

    async def failing_handle(message: dict[str, Any]) -> None:
        """
        Stand in for a processor whose database is down.

        :param message: the message it was asked to handle.
        :raises RuntimeError: always.
        """
        raise RuntimeError("db down")

    client.processor.handle = failing_handle  # type: ignore[method-assign]
    assert await client.consume_once("js", [EVENT_NSID], []) == 2
    assert store.get_cursor("js") == 200


async def test_run_stream_reconnects_with_backoff() -> None:
    connect = FakeConnect(
        [OSError("refused"), OSError("refused"), [event_message("a", 1)], []]
    )
    sleep = StopAfter(4)
    client, store = make_client(connect, sleep)
    with pytest.raises(asyncio.CancelledError):
        await client.run_stream("js", [EVENT_NSID], [])
    # fail, fail, success (resets), empty connection (no reset)
    assert sleep.delays == [1, 2, 1, 2]
    assert len(store.events) == 1


async def test_posts_stream_only_with_listener_dids() -> None:
    connect = FakeConnect([])
    client, store = make_client(connect, StopAfter(10**9))
    task = asyncio.create_task(client.run_forever())
    await asyncio.sleep(0.01)
    urls = list(connect.urls)
    assert urls and all(POST_NSID not in url for url in urls)

    listener = {
        "subject": f"at://{AUTHOR_DID}/{EVENT_NSID}/ev1",
        "hashtag": "tacos",
        "createdAt": "2026-11-11T00:00:00Z",
    }
    commit = {
        "operation": "create",
        "collection": LISTENER_NSID,
        "rkey": "l1",
        "record": listener,
    }
    await client.processor.handle(
        {"did": AUTHOR_DID, "kind": "commit", "commit": commit}
    )
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    post_urls = [url for url in connect.urls if POST_NSID in url]
    assert post_urls
    assert all(query(url)["wantedDids"] == [AUTHOR_DID] for url in post_urls)
    assert all(
        query(url)["wantedCollections"] == [POST_NSID] for url in post_urls
    )
