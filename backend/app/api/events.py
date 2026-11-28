import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from app.config import Settings
from app.deps import get_app_settings, get_store
from app.models import BoundingBox, EventQuery, SortOrder
from app.store.base import EventStore
from app.views import event_view, update_view

router = APIRouter(prefix="/api")

Store = Annotated[EventStore, Depends(get_store)]
CACHE_CONTROL = "no-cache"


SettingsDep = Annotated[Settings, Depends(get_app_settings)]


def _visible_cutoff(now: datetime, settings: Settings) -> datetime:
    return now - timedelta(seconds=settings.expiry_grace_s)


def _merge_tags(tag: list[str], tags: list[str]) -> list[str]:
    merged = list(tag)
    for item in tags:
        merged.extend(part.strip() for part in item.split(",") if part.strip())
    return merged


def _etag_for(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return f'W/"{hashlib.sha256(raw).hexdigest()[:24]}"'


def _matches_etag(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    target = etag.removeprefix("W/")
    for token in if_none_match.split(","):
        candidate = token.strip()
        if candidate == "*" or candidate.removeprefix("W/") == target:
            return True
    return False


def _cached_json(request: Request, payload: Any) -> Response:
    etag = _etag_for(payload)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL}
    if _matches_etag(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=payload, headers=headers)


@router.get("/events")
def list_events(
    request: Request,
    store: Store,
    settings: SettingsDep,
    tag: Annotated[list[str], Query(max_length=32)] = [],  # noqa: B006
    tags: Annotated[list[str], Query(max_length=400)] = [],  # noqa: B006
    group: Annotated[str | None, Query(max_length=100)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    before: datetime | None = None,
    after: datetime | None = None,
    bbox: Annotated[str | None, Query(max_length=100)] = None,
    sort: SortOrder = "soonest",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query(max_length=1000)] = None,
) -> Response:
    now = datetime.now(UTC)
    parsed_bbox = None
    if bbox is not None:
        try:
            parsed_bbox = BoundingBox.from_param(bbox)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    query = EventQuery(
        tags=_merge_tags(tag, tags),
        group=group or None,
        text=q or None,
        starts_before=before,
        ends_after=after or _visible_cutoff(now, settings),
        bbox=parsed_bbox,
        sort=sort,
        limit=limit,
        cursor=cursor or None,
    )
    try:
        page = store.query_events(query, now)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="invalid cursor") from e

    payload = {"events": [event_view(ev, now) for ev in page.events], "cursor": page.cursor}
    return _cached_json(request, payload)


@router.get("/event")
def get_event(uri: str, request: Request, store: Store) -> Response:
    ev = store.get_event(uri)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    view = event_view(ev, datetime.now(UTC))
    view["updates"] = [update_view(u) for u in store.list_updates(uri)]
    return _cached_json(request, view)


@router.get("/tags")
def list_tags(request: Request, store: Store, settings: SettingsDep) -> Response:
    cutoff = _visible_cutoff(datetime.now(UTC), settings)
    return _cached_json(request, [c.model_dump() for c in store.list_tags(cutoff)])


@router.get("/groups")
def list_groups(request: Request, store: Store, settings: SettingsDep) -> Response:
    cutoff = _visible_cutoff(datetime.now(UTC), settings)
    groups = store.list_groups(cutoff)
    return _cached_json(request, [c.model_dump() for c in groups])
