from datetime import timedelta

from app.models import EventUpdate


def test_health_and_config(client):
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get("/api/config").json() == {
        "devMode": True,
        "jetstreamEnabled": False,
        "eventNsid": "app.communitymap.event",
        "listenerNsid": "app.communitymap.listener",
    }


def test_list_events(client, store, make_event):
    store.upsert_event(make_event("a", tags=["food"], group="ACM", name="Pizza"))
    store.upsert_event(make_event("b", tags=["music"], start_h=3, end_h=4))
    store.upsert_event(make_event("old", start_h=-3, end_h=-2))
    body = client.get("/api/events").json()
    assert [e["uri"].rsplit("/", 1)[1] for e in body["events"]] == ["a", "b"]
    assert body["cursor"] is None
    assert body["events"][0]["status"] == "upcoming"
    assert body["events"][0]["authorDid"] == "did:plc:test"


def test_list_events_filters(client, store, make_event, now):
    store.upsert_event(make_event("a", tags=["food"], group="ACM", name="Pizza"))
    store.upsert_event(make_event("b", tags=["music"], start_h=3, end_h=4))
    store.upsert_event(make_event("c", tags=["tech"], start_h=5, end_h=6))

    def names(**params):
        events = client.get("/api/events", params=params).json()["events"]
        return [e["uri"].rsplit("/", 1)[1] for e in events]

    assert names(tag=["food", "music"]) == ["a", "b"]
    assert names(group="ACM") == ["a"]
    assert names(q="PIZ") == ["a"]
    before = (now + timedelta(hours=2)).isoformat()
    assert names(before=before) == ["a"]
    after = (now + timedelta(hours=4.5)).isoformat()
    assert names(after=after) == ["c"]


def test_list_events_pagination(client, store, make_event):
    for i in range(3):
        store.upsert_event(make_event(f"e{i}", start_h=1 + i, end_h=10))
    first = client.get("/api/events", params={"limit": 2}).json()
    assert len(first["events"]) == 2 and first["cursor"]
    second = client.get("/api/events", params={"limit": 2, "cursor": first["cursor"]}).json()
    assert [e["uri"][-2:] for e in second["events"]] == ["e2"]
    assert second["cursor"] is None


def test_list_events_validation(client):
    assert client.get("/api/events", params={"limit": 0}).status_code == 422
    assert client.get("/api/events", params={"limit": 101}).status_code == 422
    assert client.get("/api/events", params={"before": "nope"}).status_code == 422
    assert client.get("/api/events", params={"cursor": "garbage!"}).status_code == 400


def test_get_event(client, store, make_event, now):
    ev = make_event()
    store.upsert_event(ev)
    store.add_update(
        EventUpdate(event_uri=ev.uri, text="Moved", source_uri="at://p", created_at=now)
    )
    body = client.get("/api/event", params={"uri": ev.uri}).json()
    assert body["name"] == "Test Event"
    assert body["updates"] == [
        {
            "text": "Moved",
            "sourceUri": "at://p",
            "createdAt": now.isoformat().replace("+00:00", "Z"),
        }
    ]
    assert client.get("/api/event", params={"uri": "at://missing"}).status_code == 404
    assert client.get("/api/event").status_code == 422


def test_tags_and_groups(client, store, make_event):
    store.upsert_event(make_event("a", tags=["food", "free"], group="ACM"))
    store.upsert_event(make_event("b", tags=["free"], group="ACM"))
    assert client.get("/api/tags").json() == [
        {"value": "free", "count": 2},
        {"value": "food", "count": 1},
    ]
    assert client.get("/api/groups").json() == [{"value": "ACM", "count": 2}]

def test_events_sort_tags_bbox_and_etag(client, store, make_event, now):
    older = make_event("a", tags=["food"], start_h=1, end_h=4)
    newer_rec = make_event("b", tags=["music"], start_h=5, end_h=8).record.model_copy(
        update={
            "created_at": now + timedelta(minutes=10),
            "location": {"name": "Downtown", "lat": "32.71", "lng": "-117.16"},
        }
    )
    newer = make_event("b", tags=["music"], start_h=5, end_h=8).model_copy(
        update={"record": newer_rec}
    )
    store.upsert_event(older)
    store.upsert_event(newer)

    # sort=newest
    newest = client.get("/api/events", params={"sort": "newest"}).json()["events"]
    assert [e["uri"].rsplit("/", 1)[1] for e in newest] == ["b", "a"]

    # comma-separated tags alias
    tagged = client.get("/api/events", params={"tags": "food,music"}).json()["events"]
    assert len(tagged) == 2

    # bbox filter + invalid bbox
    in_box = client.get("/api/events", params={"bbox": "-117.26,32.86,-117.22,32.90"}).json()
    assert [e["uri"].rsplit("/", 1)[1] for e in in_box["events"]] == ["a"]
    assert client.get("/api/events", params={"bbox": "1,2,3"}).status_code == 422
    assert client.get("/api/events", params={"bbox": "0,50,10,40"}).status_code == 422

    # ETag + 304 Not Modified + invalidation on write
    r1 = client.get("/api/events")
    etag = r1.headers["etag"]
    assert r1.headers["cache-control"] == "no-cache"
    r2 = client.get("/api/events", headers={"If-None-Match": etag})
    assert r2.status_code == 304

    store.upsert_event(make_event("c", start_h=2, end_h=3))
    r3 = client.get("/api/events", headers={"If-None-Match": etag})
    assert r3.status_code == 200 and r3.headers["etag"] != etag