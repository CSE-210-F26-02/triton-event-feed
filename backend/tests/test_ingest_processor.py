from __future__ import annotations

from typing import Any

import pytest

from ingest.processor import CommitProcessor, diff_events, extract_hashtags
from models import EVENT_NSID, LISTENER_NSID, POST_NSID, EventRecord
from tests.ingest_fakes import (
    FakeNotifier,
    FakeResolver,
    FakeStore,
    utc_datetime,
)

AUTHOR_DID = "did:plc:alice"
OTHER = "did:plc:mallory"
FIXED_NOW = utc_datetime(2026, 11, 11, 12)
EVENT_URI = f"at://{AUTHOR_DID}/{EVENT_NSID}/ev1"


def event_record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "name": "Taco Night",
        "description": "Free tacos",
        "startsAt": "2026-11-12T18:00:00Z",
        "endsAt": "2026-11-12T20:00:00Z",
        "location": {"name": "Price Center", "lat": "32.88", "lng": "-117.24"},
        "tags": ["food"],
        "createdAt": "2026-11-11T00:00:00Z",
    }
    record.update(overrides)
    return record


def commit(
    collection: str,
    operation: str,
    rkey: str,
    record: dict[str, Any] | None = None,
    did: str = AUTHOR_DID,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "operation": operation,
        "collection": collection,
        "rkey": rkey,
        "cid": "bafy1",
    }
    if record is not None:
        body["record"] = record
    return {"did": did, "time_us": 1, "kind": "commit", "commit": body}


def listener_record(
    subject: str = EVENT_URI, hashtag: str = "#TacoNight"
) -> dict[str, Any]:
    return {
        "subject": subject,
        "hashtag": hashtag,
        "createdAt": "2026-11-11T00:00:00Z",
    }


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def notifier(store: FakeStore) -> FakeNotifier:
    return FakeNotifier(store)


@pytest.fixture
def processor(store: FakeStore, notifier: FakeNotifier) -> CommitProcessor:
    return CommitProcessor(store, notifier, clock=lambda: FIXED_NOW)


# ---- events ---------------------------------------------------------------


async def test_create_event_indexes_it(
    processor: CommitProcessor, store: FakeStore
) -> None:
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    event = store.get_event(EVENT_URI)
    assert event is not None
    assert event.author_did == AUTHOR_DID
    assert event.source == "atproto"
    assert event.cid == "bafy1"
    assert event.record.name == "Taco Night"
    assert event.indexed_at == FIXED_NOW and event.updated_at == FIXED_NOW


async def test_non_commit_messages_ignored(
    processor: CommitProcessor, store: FakeStore
) -> None:
    await processor.handle(
        {"did": AUTHOR_DID, "time_us": 1, "kind": "identity", "identity": {}}
    )
    await processor.handle(
        {"did": AUTHOR_DID, "kind": "commit"}
    )  # malformed: no commit body
    assert store.events == {}


async def test_invalid_event_skipped(
    processor: CommitProcessor, store: FakeStore
) -> None:
    invalid_record = event_record(
        endsAt="2026-11-12T10:00:00Z"
    )  # ends before start
    await processor.handle(commit(EVENT_NSID, "create", "ev1", invalid_record))
    await processor.handle(commit(EVENT_NSID, "create", "ev2", {"name": ""}))
    assert store.events == {}


async def test_update_preserves_indexed_at_and_notifies_diff(
    store: FakeStore, notifier: FakeNotifier
) -> None:
    times = iter([FIXED_NOW, utc_datetime(2026, 11, 11, 13)])
    processor = CommitProcessor(store, notifier, clock=lambda: next(times))
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    moved = event_record(location={"name": "Sun God Lawn"})
    await processor.handle(commit(EVENT_NSID, "update", "ev1", moved))
    event = store.get_event(EVENT_URI)
    assert event is not None
    assert event.indexed_at == FIXED_NOW
    assert event.updated_at == utc_datetime(2026, 11, 11, 13)
    assert notifier.published == [
        (EVENT_URI, "updated", "Location changed: Price Center → Sun God Lawn")
    ]


async def test_unchanged_update_does_not_notify(
    processor: CommitProcessor, notifier: FakeNotifier
) -> None:
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    await processor.handle(commit(EVENT_NSID, "update", "ev1", event_record()))
    assert notifier.published == []


async def test_delete_publishes_before_deleting(
    processor: CommitProcessor, store: FakeStore, notifier: FakeNotifier
) -> None:
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    await processor.handle(commit(EVENT_NSID, "delete", "ev1"))
    assert store.get_event(EVENT_URI) is None
    assert notifier.published == [
        (EVENT_URI, "deleted", "Taco Night was cancelled")
    ]
    assert notifier.event_present == [True]


async def test_delete_unknown_event_is_noop(
    processor: CommitProcessor, notifier: FakeNotifier
) -> None:
    await processor.handle(commit(EVENT_NSID, "delete", "nope"))
    assert notifier.published == []


async def test_handle_resolved_on_create_and_reused(
    store: FakeStore, notifier: FakeNotifier
) -> None:
    resolver = FakeResolver({AUTHOR_DID: "alice.test"})
    processor = CommitProcessor(
        store, notifier, handle_resolver=resolver, clock=lambda: FIXED_NOW
    )
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    await processor.handle(
        commit(EVENT_NSID, "update", "ev1", event_record(name="Taco Fest"))
    )
    event = store.get_event(EVENT_URI)
    assert event is not None and event.author_handle == "alice.test"
    assert resolver.calls == [AUTHOR_DID]


# ---- diff -----------------------------------------------------------------


def test_diff_events_reports_each_change() -> None:
    old_record = EventRecord.model_validate(event_record())
    new_record = EventRecord.model_validate(
        event_record(
            name="Taco Fest",
            description="Free tacos and salsa",
            startsAt="2026-11-12T19:00:00Z",
            endsAt="2026-11-12T21:00:00Z",
            tags=["food", "music"],
            group="Taco Club",
        )
    )
    diffs = diff_events(old_record, new_record)
    assert diffs[0] == "Name changed: Taco Night → Taco Fest"
    assert diffs[1].startswith("Time changed: ")
    assert "→" in diffs[1]
    assert "Description updated" in diffs
    assert "Tags changed: food → food, music" in diffs
    assert "Group changed: none → Taco Club" in diffs


def test_diff_events_location_details() -> None:
    old_record = EventRecord.model_validate(event_record())
    new_record = EventRecord.model_validate(
        event_record(
            location={"name": "Price Center", "lat": "32.9", "lng": "-117.2"}
        )
    )
    assert diff_events(old_record, new_record) == ["Location details updated"]
    assert diff_events(old_record, old_record) == []


# ---- listeners ------------------------------------------------------------


async def test_listener_upserted_for_own_event(
    processor: CommitProcessor, store: FakeStore
) -> None:
    await processor.handle(
        commit(LISTENER_NSID, "create", "l1", listener_record())
    )
    (listener,) = store.listeners.values()
    assert listener.uri == f"at://{AUTHOR_DID}/{LISTENER_NSID}/l1"
    assert listener.record.hashtag == "taconight"
    assert listener.author_did == AUTHOR_DID


async def test_listener_for_someone_elses_event_rejected(
    processor: CommitProcessor, store: FakeStore
) -> None:
    await processor.handle(
        commit(LISTENER_NSID, "create", "l1", listener_record(), did=OTHER)
    )
    other_collection = f"at://{AUTHOR_DID}/app.bsky.feed.post/x"
    await processor.handle(
        commit(
            LISTENER_NSID, "create", "l2", listener_record(other_collection)
        )
    )
    await processor.handle(
        commit(LISTENER_NSID, "create", "l3", {"subject": EVENT_URI})
    )
    assert store.listeners == {}


async def test_listener_delete_and_change_callback(
    store: FakeStore, notifier: FakeNotifier
) -> None:
    seen: list[list[str]] = []
    processor = CommitProcessor(
        store,
        notifier,
        on_listeners_changed=seen.append,
        clock=lambda: FIXED_NOW,
    )
    await processor.handle(
        commit(LISTENER_NSID, "create", "l1", listener_record())
    )
    await processor.handle(
        commit(LISTENER_NSID, "create", "l2", listener_record(hashtag="tacos"))
    )
    await processor.handle(commit(LISTENER_NSID, "delete", "l1"))
    await processor.handle(commit(LISTENER_NSID, "delete", "l2"))
    assert store.listeners == {}
    assert seen == [[AUTHOR_DID], []]  # only fired when the DID set changed


async def test_async_listener_callback_awaited(
    store: FakeStore, notifier: FakeNotifier
) -> None:
    seen: list[list[str]] = []

    async def record_changed_dids(dids: list[str]) -> None:
        seen.append(dids)

    processor = CommitProcessor(
        store, notifier, on_listeners_changed=record_changed_dids
    )
    await processor.handle(
        commit(LISTENER_NSID, "create", "l1", listener_record())
    )
    assert seen == [[AUTHOR_DID]]


# ---- posts ----------------------------------------------------------------


def post(
    text: str, facets: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "$type": POST_NSID,
        "text": text,
        "createdAt": "2026-11-11T12:00:00Z",
    }
    if facets is not None:
        record["facets"] = facets
    return record


async def _with_listener(processor: CommitProcessor) -> None:
    await processor.handle(commit(EVENT_NSID, "create", "ev1", event_record()))
    await processor.handle(
        commit(LISTENER_NSID, "create", "l1", listener_record())
    )


async def test_post_with_hashtag_becomes_announcement(
    processor: CommitProcessor, store: FakeStore, notifier: FakeNotifier
) -> None:
    await _with_listener(processor)
    text = "Moved inside due to rain! #tacoNIGHT"
    await processor.handle(commit(POST_NSID, "create", "p1", post(text)))
    (update,) = store.list_updates(EVENT_URI)
    assert update.text == text
    assert update.source_uri == f"at://{AUTHOR_DID}/{POST_NSID}/p1"
    assert update.created_at == FIXED_NOW
    assert notifier.published == [(EVENT_URI, "announcement", text)]


async def test_post_hashtag_from_facet(
    processor: CommitProcessor, store: FakeStore
) -> None:
    await _with_listener(processor)
    facet = {
        "features": [
            {"$type": "app.bsky.richtext.facet#tag", "tag": "TacoNight"}
        ]
    }
    await processor.handle(
        commit(POST_NSID, "create", "p1", post("see you there", [facet]))
    )
    assert len(store.list_updates(EVENT_URI)) == 1


async def test_post_partial_or_missing_tag_ignored(
    processor: CommitProcessor, store: FakeStore, notifier: FakeNotifier
) -> None:
    await _with_listener(processor)
    await processor.handle(
        commit(POST_NSID, "create", "p1", post("#TacoNightOut is fun"))
    )
    await processor.handle(
        commit(POST_NSID, "create", "p2", post("taconight without hash"))
    )
    await processor.handle(
        commit(POST_NSID, "create", "p3", post("#taconight"), did=OTHER)
    )
    await processor.handle(commit(POST_NSID, "delete", "p1"))
    assert store.updates == []
    assert [
        published
        for published in notifier.published
        if published[1] == "announcement"
    ] == []


def test_extract_hashtags() -> None:
    record = post("Hi #One, #two! mid#no #thr-ee.")
    assert extract_hashtags(record) == {"one", "two", "thr-ee"}
