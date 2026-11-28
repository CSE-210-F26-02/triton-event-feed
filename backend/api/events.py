"""
GET /api/events, /api/event, /api/tags and /api/groups (cached JSON).
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse

from api.deps import get_app_settings, get_store
from config import Settings
from models import BoundingBox, EventQuery, SortOrder
from store.base import EventStore
from utils.views import event_view, update_view

router = APIRouter(prefix="/api")

Store = Annotated[EventStore, Depends(get_store)]
SettingsDep = Annotated[Settings, Depends(get_app_settings)]

CACHE_CONTROL = "no-cache"
ETAG_WEAK_PREFIX = "W/"
ETAG_ANY = "*"
ETAG_HASH_LENGTH = 24
TAG_SEPARATOR = ","

HTTP_NOT_MODIFIED = 304
HTTP_BAD_REQUEST = 400
HTTP_NOT_FOUND = 404
HTTP_UNPROCESSABLE = 422

# Query-string limits, so a single request cannot ask for unbounded work.
MAX_TAG_PARAMS = 32
MAX_TAGS_PARAMS = 400
MAX_GROUP_LENGTH = 100
MAX_SEARCH_TEXT_LENGTH = 200
MAX_BBOX_LENGTH = 100
MAX_CURSOR_LENGTH = 1000
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def _visible_cutoff(now: datetime, settings: Settings) -> datetime:
    """
    The moment before which ended events are hidden from listings.

    :param now: the current time.
    :param settings: supplies expiry_grace_seconds, how long an event stays
        visible after it ends.
    :returns: now minus the grace period.
    """
    return now - timedelta(seconds=settings.expiry_grace_seconds)


def _merge_tags(tag: list[str], tags: list[str]) -> list[str]:
    """
    Combine repeated ?tag= values with comma-separated ?tags= values.

    :param tag: every ?tag= value, e.g. ["food", "free"].
    :param tags: every ?tags= value, e.g. ["music,art"].
    :returns: all the tags in one list.
    """
    merged = list(tag)
    for tags_value in tags:
        merged.extend(
            part.strip()
            for part in tags_value.split(TAG_SEPARATOR)
            if part.strip()
        )
    return merged


def _etag_for(payload: Any) -> str:
    """
    Compute a weak ETag: a hash of the payload's canonical JSON.

    :param payload: the JSON-serialisable response body.
    :returns: the ETag header value, e.g. 'W/"3f2a..."'.
    """
    canonical_json = json.dumps(
        payload, sort_keys=True, separators=(",", ":")
    ).encode()
    digest = hashlib.sha256(canonical_json).hexdigest()[:ETAG_HASH_LENGTH]
    return f'{ETAG_WEAK_PREFIX}"{digest}"'


def _matches_etag(if_none_match: str | None, etag: str) -> bool:
    """
    Check whether the client already has this version of the response.

    :param if_none_match: the request's If-None-Match header, or None.
    :param etag: the current ETag.
    :returns: True when the header names etag (or "*").
    """
    if not if_none_match:
        return False
    target = etag.removeprefix(ETAG_WEAK_PREFIX)
    for token in if_none_match.split(","):
        candidate = token.strip()
        if candidate == ETAG_ANY:
            return True
        if candidate.removeprefix(ETAG_WEAK_PREFIX) == target:
            return True
    return False


def _cached_json(request: Request, payload: Any) -> Response:
    """
    Send payload with an ETag, or 304 if the client already has it.

    :param request: the incoming HTTP request (for its If-None-Match
        header).
    :param payload: the JSON-serialisable response body.
    :returns: a 200 JSON response, or an empty 304 response.
    """
    etag = _etag_for(payload)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _matches_etag(request.headers.get("if-none-match"), etag):
        return Response(status_code=HTTP_NOT_MODIFIED, headers=headers)
    return JSONResponse(content=payload, headers=headers)


def _parse_bbox(bbox: str | None) -> BoundingBox | None:
    """
    Parse the ?bbox= (map area) parameter.

    :param bbox: "west,south,east,north" in degrees, or None.
    :returns: the bounding box, or None when the parameter is absent.
    :raises HTTPException: 422 when bbox is malformed.
    """
    if bbox is None:
        return None
    try:
        return BoundingBox.from_param(bbox)
    except ValueError as error:
        raise HTTPException(
            status_code=HTTP_UNPROCESSABLE, detail=str(error)
        ) from error


@router.get("/events")
def list_events(
    request: Request,
    store: Store,
    settings: SettingsDep,
    tag: Annotated[
        list[str], Query(default_factory=list, max_length=MAX_TAG_PARAMS)
    ],
    tags: Annotated[
        list[str], Query(default_factory=list, max_length=MAX_TAGS_PARAMS)
    ],
    group: Annotated[str | None, Query(max_length=MAX_GROUP_LENGTH)] = None,
    search_text: Annotated[
        str | None, Query(alias="q", max_length=MAX_SEARCH_TEXT_LENGTH)
    ] = None,
    before: datetime | None = None,
    after: datetime | None = None,
    bbox: Annotated[str | None, Query(max_length=MAX_BBOX_LENGTH)] = None,
    sort: SortOrder = "soonest",
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
    cursor: Annotated[str | None, Query(max_length=MAX_CURSOR_LENGTH)] = None,
) -> Response:
    """
    List current events matching the filters, one page at a time.

    :param request: the incoming HTTP request (for its If-None-Match
        header).
    :param store: the event index.
    :param settings: the validated backend settings.
    :param tag: ?tag=, repeatable; an event matching any tag is listed.
    :param tags: ?tags=, comma-separated tags (same meaning as tag).
    :param group: ?group=, only events of this group.
    :param search_text: ?q=, text to find in the name, description or place.
    :param before: ?before=, only events that start before this time.
    :param after: ?after=, only events that end after this time (default:
        now, minus the grace period).
    :param bbox: ?bbox=, only events inside this map area.
    :param sort: ?sort=, "soonest" (by start time) or "newest" (by index
        time).
    :param limit: ?limit=, the page size.
    :param cursor: ?cursor=, the cursor of the previous page.
    :returns: {"events": [...], "cursor": ...} with an ETag.
    :raises HTTPException: 422 for a bad bbox, 400 for a bad cursor.
    """
    now = datetime.now(UTC)
    query = EventQuery(
        tags=_merge_tags(tag, tags),
        group=group or None,
        text=search_text or None,
        starts_before=before,
        ends_after=after or _visible_cutoff(now, settings),
        bbox=_parse_bbox(bbox),
        sort=sort,
        limit=limit,
        cursor=cursor or None,
    )
    try:
        page = store.query_events(query, now)
    except ValueError as error:
        raise HTTPException(
            status_code=HTTP_BAD_REQUEST, detail="invalid cursor"
        ) from error
    payload = {
        "events": [event_view(event, now) for event in page.events],
        "cursor": page.cursor,
    }
    return _cached_json(request, payload)


@router.get("/event")
def get_event(uri: str, request: Request, store: Store) -> Response:
    """
    Return one event with its announcements.

    :param uri: ?uri=, the event's id (its AT URI).
    :param request: the incoming HTTP request (for its If-None-Match
        header).
    :param store: the event index.
    :returns: the event's JSON view, with an ETag.
    :raises HTTPException: 404 when no event has this URI.
    """
    event = store.get_event(uri)
    if event is None:
        raise HTTPException(
            status_code=HTTP_NOT_FOUND, detail="event not found"
        )
    view = event_view(event, datetime.now(UTC))
    view["updates"] = [
        update_view(update) for update in store.list_updates(uri)
    ]
    return _cached_json(request, view)


@router.get("/tags")
def list_tags(
    request: Request, store: Store, settings: SettingsDep
) -> Response:
    """
    Return every tag on a visible event, with how many events use it.

    :param request: the incoming HTTP request (for its If-None-Match
        header).
    :param store: the event index.
    :param settings: the validated backend settings.
    :returns: [{"value": tag, "count": n}, ...], with an ETag.
    """
    cutoff = _visible_cutoff(datetime.now(UTC), settings)
    counts = store.list_tags(cutoff)
    return _cached_json(request, [count.model_dump() for count in counts])


@router.get("/groups")
def list_groups(
    request: Request, store: Store, settings: SettingsDep
) -> Response:
    """
    Return every group hosting a visible event, with event counts.

    :param request: the incoming HTTP request (for its If-None-Match
        header).
    :param store: the event index.
    :param settings: the validated backend settings.
    :returns: [{"value": group, "count": n}, ...], with an ETag.
    """
    cutoff = _visible_cutoff(datetime.now(UTC), settings)
    counts = store.list_groups(cutoff)
    return _cached_json(request, [count.model_dump() for count in counts])
