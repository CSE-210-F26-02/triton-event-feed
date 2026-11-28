"""
Tests for the event listing routes (api/events.py): filters, sorting,
paging, ETags and tag/group counts.
"""

from datetime import timedelta

from models import EventUpdate, Location


def test_health_and_config(client):
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get("/api/config").json() == {
        "devMode": True,
        "jetstreamEnabled": False,
        "eventNsid": "app.communitymap.event",
        "listenerNsid": "app.communitymap.listener",
    }


def test_list_events(client, store, make_event):
    store.upsert_event(
        make_event("a", tags=["food"], group="ACM", name="Pizza")
    )
    store.upsert_event(
        make_event("b", tags=["music"], start_in_hours=3, end_in_hours=4)
    )
    store.upsert_event(make_event("old", start_in_hours=-3, end_in_hours=-2))
    body = client.get("/api/events").json()
    assert [event["uri"].rsplit("/", 1)[1] for event in body["events"]] == [
        "a",
        "b",
    ]
    assert body["cursor"] is None
    assert body["events"][0]["status"] == "upcoming"
    assert body["events"][0]["authorDid"] == "did:plc:test"


def test_list_events_filters(client, store, make_event, now):
    store.upsert_event(
        make_event("a", tags=["food"], group="ACM", name="Pizza")
    )
    store.upsert_event(
        make_event("b", tags=["music"], start_in_hours=3, end_in_hours=4)
    )
    store.upsert_event(
        make_event("c", tags=["tech"], start_in_hours=5, end_in_hours=6)
    )

    def names(**params):
        """
        List events with some query parameters.

        :param params: the query parameters, e.g. tag="food".
        :returns: the record keys of the events returned, in order.
        """
        events = client.get("/api/events", params=params).json()["events"]
        return [event["uri"].rsplit("/", 1)[1] for event in events]

    assert names(tag=["food", "music"]) == ["a", "b"]
    assert names(group="ACM") == ["a"]
    assert names(q="PIZ") == ["a"]
    before = (now + timedelta(hours=2)).isoformat()
    assert names(before=before) == ["a"]
    after = (now + timedelta(hours=4.5)).isoformat()
    assert names(after=after) == ["c"]


def test_list_events_pagination(client, store, make_event):
    for index in range(3):
        store.upsert_event(
            make_event(f"e{index}", start_in_hours=1 + index, end_in_hours=10)
        )
    first = client.get("/api/events", params={"limit": 2}).json()
    assert len(first["events"]) == 2 and first["cursor"]
    second = client.get(
        "/api/events", params={"limit": 2, "cursor": first["cursor"]}
    ).json()
    assert [event["uri"][-2:] for event in second["events"]] == ["e2"]
    assert second["cursor"] is None


def test_list_events_validation(client):
    assert client.get("/api/events", params={"limit": 0}).status_code == 422
    assert client.get("/api/events", params={"limit": 101}).status_code == 422
    assert (
        client.get("/api/events", params={"before": "nope"}).status_code == 422
    )
    assert (
        client.get("/api/events", params={"cursor": "garbage!"}).status_code
        == 400
    )


def test_get_event(client, store, make_event, now):
    event = make_event()
    store.upsert_event(event)
    store.add_update(
        EventUpdate(
            event_uri=event.uri,
            text="Moved",
            source_uri="at://p",
            created_at=now,
        )
    )
    body = client.get("/api/event", params={"uri": event.uri}).json()
    assert body["name"] == "Test Event"
    assert body["updates"] == [
        {
            "text": "Moved",
            "sourceUri": "at://p",
            "createdAt": now.isoformat().replace("+00:00", "Z"),
        }
    ]
    assert (
        client.get("/api/event", params={"uri": "at://missing"}).status_code
        == 404
    )
    assert client.get("/api/event").status_code == 422


def test_tags_and_groups(client, store, make_event):
    store.upsert_event(make_event("a", tags=["food", "free"], group="ACM"))
    store.upsert_event(make_event("b", tags=["free"], group="ACM"))
    assert client.get("/api/tags").json() == [
        {"value": "free", "count": 2},
        {"value": "food", "count": 1},
    ]
    assert client.get("/api/groups").json() == [{"value": "ACM", "count": 2}]


def _store_campus_and_downtown_events(store, make_event, now):
    """
    Store "a" (on campus, created first) and "b" (downtown, newer).

    :param store: the test's event index.
    :param make_event: the event factory fixture.
    :param now: the test's current time.
    """
    older = make_event("a", tags=["food"], start_in_hours=1, end_in_hours=4)
    newer_event = make_event(
        "b", tags=["music"], start_in_hours=5, end_in_hours=8
    )
    newer_record = newer_event.record.model_copy(
        update={
            "created_at": now + timedelta(minutes=10),
            "location": Location(name="Downtown", lat="32.71", lng="-117.16"),
        }
    )
    store.upsert_event(older)
    store.upsert_event(newer_event.model_copy(update={"record": newer_record}))


def _rkeys(events):
    """
    The record keys (last URI segment) of a list of event views.

    :param events: event views from the API.
    :returns: their record keys, in order.
    """
    return [event["uri"].rsplit("/", 1)[1] for event in events]


def test_events_sort_newest(client, store, make_event, now):
    _store_campus_and_downtown_events(store, make_event, now)
    response = client.get("/api/events", params={"sort": "newest"})
    assert _rkeys(response.json()["events"]) == ["b", "a"]


def test_events_comma_separated_tags_alias(client, store, make_event, now):
    _store_campus_and_downtown_events(store, make_event, now)
    response = client.get("/api/events", params={"tags": "food,music"})
    assert len(response.json()["events"]) == 2


def test_events_bbox_filter(client, store, make_event, now):
    _store_campus_and_downtown_events(store, make_event, now)
    campus_bbox = "-117.26,32.86,-117.22,32.90"
    response = client.get("/api/events", params={"bbox": campus_bbox})
    assert _rkeys(response.json()["events"]) == ["a"]


def test_events_invalid_bbox_rejected(client):
    for bbox in ("1,2,3", "0,50,10,40"):
        response = client.get("/api/events", params={"bbox": bbox})
        assert response.status_code == 422


def test_events_etag_not_modified_and_invalidation(
    client, store, make_event, now
):
    _store_campus_and_downtown_events(store, make_event, now)
    first = client.get("/api/events")
    etag = first.headers["etag"]
    assert first.headers["cache-control"] == "no-cache"
    cached = client.get("/api/events", headers={"If-None-Match": etag})
    assert cached.status_code == 304

    store.upsert_event(make_event("c", start_in_hours=2, end_in_hours=3))
    changed = client.get("/api/events", headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag
