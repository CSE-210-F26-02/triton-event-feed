"""
Tests for the subscription and notification routes
(api/subscriptions.py), including the live SSE stream.
"""

import asyncio

from api.subscriptions import sse_messages
from models import Notification

SUBSCRIBER_ID = "subscriber-123"


def subscription_body(
    uri: str, subscriber_id: str = SUBSCRIBER_ID
) -> dict[str, str]:
    """
    Build a POST /api/subscriptions JSON body.

    :param uri: the event's id (its AT URI).
    :param subscriber_id: the client's opaque id.
    :returns: the body.
    """
    return {"subscriberId": subscriber_id, "eventUri": uri}


def test_subscribe_list_unsubscribe(client, store, make_event):
    event = make_event()
    store.upsert_event(event)
    assert (
        client.post(
            "/api/subscriptions", json=subscription_body(event.uri)
        ).status_code
        == 204
    )
    assert client.get(
        "/api/subscriptions", params={"subscriberId": SUBSCRIBER_ID}
    ).json() == [event.uri]
    response = client.request(
        "DELETE", "/api/subscriptions", json=subscription_body(event.uri)
    )
    assert response.status_code == 204
    assert (
        client.get(
            "/api/subscriptions", params={"subscriberId": SUBSCRIBER_ID}
        ).json()
        == []
    )


def test_subscribe_unknown_event_404(client):
    assert (
        client.post(
            "/api/subscriptions", json=subscription_body("at://nope")
        ).status_code
        == 404
    )


def test_subscriber_id_validation(client, store, make_event):
    event = make_event()
    store.upsert_event(event)
    for invalid_subscriber_id in ["short", "x" * 65, "has space!"]:
        assert (
            client.post(
                "/api/subscriptions",
                json=subscription_body(event.uri, invalid_subscriber_id),
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/api/subscriptions",
                params={"subscriberId": invalid_subscriber_id},
            ).status_code
            == 422
        )
    assert client.get("/api/notifications").status_code == 422


async def test_publish_persists_and_lists(client, store, notifier, make_event):
    event = make_event()
    store.upsert_event(event)
    store.subscribe(SUBSCRIBER_ID, event.uri)
    store.subscribe("other-subscriber", event.uri)
    assert await notifier.publish(event.uri, "updated", "Time changed") == 2
    assert await notifier.publish("at://no-subs", "updated", "x") == 0

    body = client.get(
        "/api/notifications", params={"subscriberId": SUBSCRIBER_ID}
    ).json()
    assert len(body) == 1
    notification = body[0]
    assert (
        notification["subscriberId"],
        notification["eventUri"],
        notification["kind"],
        notification["message"],
    ) == (SUBSCRIBER_ID, event.uri, "updated", "Time changed")
    since = client.get(
        "/api/notifications",
        params={"subscriberId": SUBSCRIBER_ID, "since": notification["id"]},
    )
    assert since.json() == []


async def test_publish_pushes_to_all_tabs(store, notifier):
    store.subscribe(SUBSCRIBER_ID, "at://e")
    first_tab_queue, second_tab_queue = (
        notifier.connect(SUBSCRIBER_ID),
        notifier.connect(SUBSCRIBER_ID),
    )
    await notifier.publish("at://e", "announcement", "Doors open")
    assert (
        first_tab_queue.get_nowait().message
        == second_tab_queue.get_nowait().message
        == "Doors open"
    )
    notifier.disconnect(SUBSCRIBER_ID, first_tab_queue)
    await notifier.publish("at://e", "announcement", "Second")
    assert first_tab_queue.empty()
    assert second_tab_queue.get_nowait().message == "Second"
    notifier.disconnect(SUBSCRIBER_ID, second_tab_queue)
    notifier.disconnect(SUBSCRIBER_ID, second_tab_queue)  # idempotent


async def test_sse_messages_stream(store, notifier):
    store.subscribe(SUBSCRIBER_ID, "at://e")
    disconnected = False

    async def is_disconnected() -> bool:
        """
        Report whether the fake client has left.

        :returns: the test's `disconnected` flag.
        """
        return disconnected

    sse_stream = sse_messages(
        notifier, SUBSCRIBER_ID, is_disconnected, ping_interval_seconds=0.01
    )
    assert await anext(sse_stream) == ": connected\n\n"
    assert await anext(sse_stream) == ": ping\n\n"

    await notifier.publish("at://e", "deleted", "Cancelled")
    frame = await anext(sse_stream)
    lines = frame.split("\n")
    assert lines[0].startswith("id: ")
    notification = Notification.model_validate_json(
        lines[1].removeprefix("data: ")
    )
    assert (
        notification.kind,
        notification.message,
        notification.subscriber_id,
    ) == ("deleted", "Cancelled", SUBSCRIBER_ID)

    disconnected = True
    await asyncio.sleep(0.02)
    assert [frame async for frame in sse_stream] in ([], [": ping\n\n"])
    assert notifier._queues == {}


async def test_sse_releases_queue_on_close(notifier):
    async def never() -> bool:
        """
        A client that never disconnects on its own.

        :returns: False.
        """
        return False

    sse_stream = sse_messages(
        notifier, SUBSCRIBER_ID, never, ping_interval_seconds=10
    )
    await anext(sse_stream)
    assert SUBSCRIBER_ID in notifier._queues
    await sse_stream.aclose()
    assert notifier._queues == {}


def test_stream_endpoint_validates(client):
    response = client.get(
        "/api/notifications/stream", params={"subscriberId": "bad"}
    )
    assert response.status_code == 422
