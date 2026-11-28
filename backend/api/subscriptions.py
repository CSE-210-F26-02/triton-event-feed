"""Subscribe/unsubscribe to events and read notifications (JSON and SSE)."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from api.deps import get_notifier, get_store
from models import Notification
from notify.base import Notifier
from notify.service import SubscriptionNotifier
from store.base import EventStore

router = APIRouter(prefix="/api")

SUBSCRIBER_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"
PING_INTERVAL_SECONDS = 15.0
MAX_EVENT_URI_LENGTH = 500

HTTP_NO_CONTENT = 204
HTTP_NOT_FOUND = 404
HTTP_SERVICE_UNAVAILABLE = 503

SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
SSE_CONNECTED_FRAME = ": connected\n\n"
SSE_PING_FRAME = ": ping\n\n"

Store = Annotated[EventStore, Depends(get_store)]
SubscriberIdQuery = Annotated[
    str, Query(alias="subscriberId", pattern=SUBSCRIBER_ID_PATTERN)
]


class SubscriptionBody(BaseModel):
    """Body of POST and DELETE /api/subscriptions."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    subscriber_id: str = Field(pattern=SUBSCRIBER_ID_PATTERN)
    event_uri: str = Field(min_length=1, max_length=MAX_EVENT_URI_LENGTH)


def _notification_json(notification: Notification) -> dict[str, Any]:
    """Serialise a notification with camelCase keys."""
    return notification.model_dump(mode="json", by_alias=True)


@router.post("/subscriptions", status_code=HTTP_NO_CONTENT)
def subscribe(body: SubscriptionBody, store: Store) -> Response:
    """
    Subscribe a client to an event.

    :raises HTTPException: 404 when the event does not exist.
    """
    if store.get_event(body.event_uri) is None:
        raise HTTPException(
            status_code=HTTP_NOT_FOUND, detail="event not found"
        )
    store.subscribe(body.subscriber_id, body.event_uri)
    return Response(status_code=HTTP_NO_CONTENT)


@router.delete("/subscriptions", status_code=HTTP_NO_CONTENT)
def unsubscribe(body: SubscriptionBody, store: Store) -> Response:
    """Unsubscribe a client from an event (no error if not subscribed)."""
    store.unsubscribe(body.subscriber_id, body.event_uri)
    return Response(status_code=HTTP_NO_CONTENT)


@router.get("/subscriptions")
def list_subscriptions(
    subscriber_id: SubscriberIdQuery, store: Store
) -> list[str]:
    """Return the URIs of every event the client is subscribed to."""
    return store.subscriptions_of(subscriber_id)


@router.get("/notifications")
def list_notifications(
    subscriber_id: SubscriberIdQuery,
    store: Store,
    since: Annotated[int, Query(ge=0)] = 0,
) -> list[dict[str, Any]]:
    """Return the client's notifications newer than the id `since`."""
    notifications = store.list_notifications(subscriber_id, since)
    return [_notification_json(notification) for notification in notifications]


async def sse_messages(
    notifier: SubscriptionNotifier,
    subscriber_id: str,
    is_disconnected: Callable[[], Awaitable[bool]],
    ping_interval_seconds: float = PING_INTERVAL_SECONDS,
) -> AsyncIterator[str]:
    """
    Yield SSE frames for one client until it disconnects.

    The client's queue is always released, even if the stream errors.

    :param notifier: the live notifier the client listens to.
    :param subscriber_id: the client's opaque id.
    :param is_disconnected: returns True once the client has gone away.
    :param ping_interval_seconds: idle time before a keep-alive ping.
    :yields: SSE frames: a connected comment, pings and notification events.
    """
    queue = notifier.connect(subscriber_id)
    try:
        yield SSE_CONNECTED_FRAME
        while not await is_disconnected():
            try:
                notification = await asyncio.wait_for(
                    queue.get(), timeout=ping_interval_seconds
                )
            except TimeoutError:
                yield SSE_PING_FRAME
                continue
            notification_json = notification.model_dump_json(by_alias=True)
            yield f"id: {notification.id}\ndata: {notification_json}\n\n"
    finally:
        notifier.disconnect(subscriber_id, queue)


@router.get("/notifications/stream")
async def stream_notifications(
    request: Request,
    subscriber_id: SubscriberIdQuery,
    notifier: Annotated[Notifier, Depends(get_notifier)],
) -> StreamingResponse:
    """
    Stream the client's notifications live over Server-Sent Events.

    :raises HTTPException: 503 when the notifier cannot push live updates.
    """
    if not isinstance(notifier, SubscriptionNotifier):
        raise HTTPException(
            status_code=HTTP_SERVICE_UNAVAILABLE,
            detail="live notifications unavailable",
        )
    return StreamingResponse(
        sse_messages(notifier, subscriber_id, request.is_disconnected),
        media_type=SSE_MEDIA_TYPE,
        headers=SSE_HEADERS,
    )
