"""
Tests for POST /api/import/ical and POST /api/dev/records.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import dev, imports
from ingest.processor import CommitProcessor
from models import EVENT_NSID
from tests.ingest_fakes import FakeNotifier, FakeStore
from tests.settings_factory import make_test_settings

ICAL_FEED_TEXT = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:x@example.edu
SUMMARY:Far Future Fair
DTSTART:20991112T180000Z
DTEND:20991112T200000Z
END:VEVENT
END:VCALENDAR
"""


def feed_handler(request: httpx.Request) -> httpx.Response:
    """
    Answer the fake feed requests made by the import route.

    :param request: the outgoing request.
    :returns: an iCal feed, or an HTML page for /html.
    :raises httpx.ConnectError: for the host down.example.
    """
    if request.url.host == "down.example":
        raise httpx.ConnectError("down")
    if request.url.path == "/html":
        return httpx.Response(200, text="<html>hi</html>")
    return httpx.Response(200, text=ICAL_FEED_TEXT)


def make_app(dev_mode: bool = True) -> tuple[TestClient, FakeStore]:
    """
    Build an app with the import and dev routes, wired to fakes.

    :param dev_mode: whether POST /api/dev/records is enabled.
    :returns: (a test client, the fake store behind it).
    """
    app = FastAPI()
    app.include_router(imports.router)
    app.include_router(dev.router)
    store = FakeStore()
    notifier = FakeNotifier(store)
    app.state.store = store
    app.state.notifier = notifier
    app.state.settings = make_test_settings(dev_mode=dev_mode)
    app.state.processor = CommitProcessor(store, notifier)

    async def mock_http() -> AsyncIterator[httpx.AsyncClient]:
        """
        Replace the real HTTP client with one answered by feed_handler.

        :yields: the mocked client.
        """
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(feed_handler)
        ) as http_client:
            yield http_client

    app.dependency_overrides[imports.get_http_client] = mock_http
    app.dependency_overrides[imports.get_url_guard] = lambda: (
        lambda url: "internal" not in url
    )
    return TestClient(app), store


def test_import_ical_ok() -> None:
    client, store = make_app()
    response = client.post(
        "/api/import/ical", json={"url": "https://cal.example.edu/feed.ics"}
    )
    assert response.status_code == 200
    assert response.json() == {"imported": 1}
    assert len(store.events) == 1


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "ftp://x/y.ics", "not a url", "http://"]
)
def test_import_ical_rejects_non_http(url: str) -> None:
    client, _store = make_app()
    assert (
        client.post("/api/import/ical", json={"url": url}).status_code == 422
    )


@pytest.mark.parametrize(
    "url", ["https://down.example/x.ics", "https://ok.example/html"]
)
def test_import_ical_fetch_failure_502(url: str) -> None:
    client, _store = make_app()
    assert (
        client.post("/api/import/ical", json={"url": url}).status_code == 502
    )


COMMIT = {
    "did": "did:plc:alice",
    "time_us": 1,
    "kind": "commit",
    "commit": {
        "operation": "create",
        "collection": EVENT_NSID,
        "rkey": "ev1",
        "cid": "bafy",
        "record": {
            "name": "Taco Night",
            "startsAt": "2099-11-12T18:00:00Z",
            "endsAt": "2099-11-12T20:00:00Z",
            "location": {"name": "Price Center"},
            "createdAt": "2026-11-11T00:00:00Z",
        },
    },
}


def test_dev_records_feeds_processor() -> None:
    client, store = make_app()
    response = client.post("/api/dev/records", json=COMMIT)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert f"at://did:plc:alice/{EVENT_NSID}/ev1" in store.events


def test_dev_records_404_when_not_dev_mode() -> None:
    client, store = make_app(dev_mode=False)
    assert client.post("/api/dev/records", json=COMMIT).status_code == 404
    assert store.events == {}


def test_import_ical_rejects_private_host() -> None:
    client, _store = make_app()
    response = client.post(
        "/api/import/ical", json={"url": "http://internal.local/feed.ics"}
    )
    assert response.status_code == 422
