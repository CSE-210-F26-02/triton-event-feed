"""
Tests for importing external calendar (.ics) feeds (ingest/ical.py).
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import httpx
import pytest

from ingest.ical import event_uri, import_feed, parse_ics, run_ical_loop
from tests.ingest_fakes import FakeNotifier, FakeStore, utc_datetime
from tests.settings_factory import make_test_settings

FEED_URL = "https://calendar.example.edu/events.ics"
FIXED_NOW = utc_datetime(2026, 11, 11, 12)


def fixed_clock():
    """
    The clock import_feed sees, so results do not depend on today.

    :returns: FIXED_NOW.
    """
    return FIXED_NOW


def vevent(*lines: str) -> str:
    """
    Wrap iCal property lines in one VEVENT block.

    :param lines: e.g. "UID:1", "SUMMARY:Taco Night".
    :returns: the block's text.
    """
    return "BEGIN:VEVENT\n" + "\n".join(lines) + "\nEND:VEVENT\n"


def calendar(*events: str) -> str:
    """
    Wrap VEVENT blocks in a VCALENDAR.

    :param events: blocks made by vevent.
    :returns: the calendar's text.
    """
    return (
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n"
        + "".join(events)
        + "END:VCALENDAR\n"
    )


TACO_NIGHT_VEVENT = vevent(
    "UID:taco@example.edu",
    "SUMMARY:Taco Night",
    "DESCRIPTION:Free tacos",
    "DTSTART:20261112T180000Z",
    "DTEND:20261112T200000Z",
    "LOCATION:Price Center",
    "GEO:32.88;-117.24",
    "CATEGORIES:Food,Free",
    "URL:https://example.edu/taco",
)


def test_parse_full_event() -> None:
    (event,) = parse_ics(calendar(TACO_NIGHT_VEVENT), FEED_URL, FIXED_NOW)
    assert event.uri == event_uri(FEED_URL, "taco@example.edu")
    assert (
        event.uri.startswith("ical://") and len(event.uri.split("/")[-1]) == 16
    )
    assert event.author_did == "ical:calendar.example.edu"
    assert event.source == "ical"
    record = event.record
    assert record.name == "Taco Night"
    assert record.description == "Free tacos"
    assert record.starts_at == utc_datetime(2026, 11, 12, 18)
    assert record.ends_at == utc_datetime(2026, 11, 12, 20)
    assert record.location.name == "Price Center"
    assert (record.location.lat, record.location.lng) == ("32.88", "-117.24")
    assert record.tags == ["food", "free"]
    assert record.source_url == "https://example.edu/taco"
    assert record.created_at == FIXED_NOW


def test_missing_dtend_and_all_day_and_tz() -> None:
    text = calendar(
        vevent("UID:a", "SUMMARY:No end", "DTSTART:20261112T180000Z"),
        vevent("UID:b", "SUMMARY:All day", "DTSTART;VALUE=DATE:20261113"),
        vevent(
            "UID:c",
            "SUMMARY:Pacific",
            "DTSTART;TZID=America/Los_Angeles:20261112T100000",
            "DURATION:PT30M",
        ),
    )
    no_end, all_day, pacific = parse_ics(text, FEED_URL, FIXED_NOW)
    assert no_end.record.ends_at - no_end.record.starts_at == timedelta(
        hours=1
    )
    assert no_end.record.location.name == "TBA"
    assert all_day.record.starts_at == utc_datetime(2026, 11, 13)
    assert all_day.record.ends_at == utc_datetime(2026, 11, 14)
    assert pacific.record.starts_at == utc_datetime(2026, 11, 12, 18)
    assert pacific.record.ends_at == utc_datetime(2026, 11, 12, 18, 30)


def test_skips_ended_and_malformed() -> None:
    text = calendar(
        vevent(
            "UID:old",
            "SUMMARY:Past",
            "DTSTART:20261101T180000Z",
            "DTEND:20261101T190000Z",
        ),
        vevent("UID:bad", "SUMMARY:Broken", "DTSTART:garbage"),
        vevent("SUMMARY:No uid", "DTSTART:20261112T180000Z"),
        vevent("UID:noname", "DTSTART:20261112T180000Z"),
        vevent("UID:nostart", "SUMMARY:x"),
        TACO_NIGHT_VEVENT,
    )
    assert [
        event.record.name for event in parse_ics(text, FEED_URL, FIXED_NOW)
    ] == ["Taco Night"]


def test_not_a_calendar_raises() -> None:
    with pytest.raises(ValueError):
        parse_ics("<html>nope</html>", FEED_URL, FIXED_NOW)


def mock_client(bodies: list[str], status: int = 200) -> httpx.AsyncClient:
    """
    Build an HTTP client that serves scripted feed bodies.

    :param bodies: the bodies to serve, one per request; the last one
        repeats.
    :param status: the HTTP status of every response.
    :returns: the client.
    """

    def handle(request: httpx.Request) -> httpx.Response:
        """
        Serve the next scripted body.

        :param request: the request the client under test sent.
        :returns: the response.
        """
        body = bodies.pop(0) if len(bodies) > 1 else bodies[0]
        return httpx.Response(status, text=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


async def test_import_feed_upserts_and_notifies_changes() -> None:
    store = FakeStore()
    notifier = FakeNotifier(store)
    moved = TACO_NIGHT_VEVENT.replace(
        "LOCATION:Price Center", "LOCATION:Sun God Lawn"
    )
    client = mock_client(
        [
            calendar(TACO_NIGHT_VEVENT),
            calendar(TACO_NIGHT_VEVENT),
            calendar(moved),
        ]
    )

    assert (
        await import_feed(FEED_URL, store, notifier, client, fixed_clock) == 1
    )
    (uri,) = store.events
    first = store.events[uri]
    assert (
        await import_feed(FEED_URL, store, notifier, client, fixed_clock) == 1
    )
    assert (
        store.events[uri] is first
    )  # re-import of identical feed is "unchanged"
    assert notifier.published == []
    await import_feed(FEED_URL, store, notifier, client, fixed_clock)
    assert notifier.published == [
        (uri, "updated", "Location changed: Price Center → Sun God Lawn")
    ]
    assert store.events[uri].indexed_at == first.indexed_at


async def test_import_feed_http_error() -> None:
    with pytest.raises(httpx.HTTPStatusError):
        await import_feed(
            FEED_URL,
            FakeStore(),
            FakeNotifier(),
            mock_client(["x"], status=404),
        )


async def test_run_ical_loop_survives_errors() -> None:
    calls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        """
        Record the request; fail for feeds named "bad".

        :param request: the request the client under test sent.
        :returns: a one-event feed.
        :raises httpx.ConnectError: for URLs containing "bad".
        """
        calls.append(str(request.url))
        if "bad" in str(request.url):
            raise httpx.ConnectError("down")
        return httpx.Response(200, text=calendar(TACO_NIGHT_VEVENT))

    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        """
        Record the wait instead of waiting; stop the loop on the second one.

        :param seconds: the requested wait.
        :raises asyncio.CancelledError: on the second call.
        """
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    store = FakeStore()
    settings = make_test_settings(
        ical_feed_urls=["https://bad.example/x.ics", FEED_URL],
        ical_interval_seconds=7,
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    with pytest.raises(asyncio.CancelledError):
        await run_ical_loop(
            store,
            FakeNotifier(),
            settings,
            client=client,
            sleep=sleep,
            clock=fixed_clock,
        )
    assert len(calls) == 4 and sleeps == [7, 7]
    assert len(store.events) == 1


async def test_run_ical_loop_no_feeds_returns() -> None:
    await run_ical_loop(
        FakeStore(), FakeNotifier(), make_test_settings(ical_feed_urls=[])
    )


def test_event_uri_is_stable_across_releases():
    """
    ical:// URIs are stored in the index and in subscriptions, so the id
    scheme (SHA-1 of feed URL and UID, truncated) must never change.
    """
    assert (
        event_uri("https://example.edu/feed.ics", "taco@example.edu")
        == "ical://3a82db44c199/64bc2861bbf3dc7d"
    )


def test_event_uri_differs_per_feed_and_uid():
    """
    The same UID in two feeds, or two UIDs in one feed, differ.
    """
    uris = {
        event_uri("https://a.example/x.ics", "1@a"),
        event_uri("https://b.example/x.ics", "1@a"),
        event_uri("https://a.example/x.ics", "2@a"),
    }
    assert len(uris) == 3
