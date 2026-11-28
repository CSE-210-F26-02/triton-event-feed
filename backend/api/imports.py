"""POST /api/import/ical: import events from an iCalendar feed on demand."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from api.deps import get_notifier, get_store
from ingest.ical import import_feed
from notify.base import Notifier
from store.base import EventStore
from utils.netguard import is_public_url

router = APIRouter(prefix="/api")

ALLOWED_URL_SCHEMES = ("http", "https")
HTTP_UNPROCESSABLE = 422
HTTP_BAD_GATEWAY = 502


class IcalImportRequest(BaseModel):
    """Body of POST /api/import/ical."""

    url: str

    @field_validator("url")
    @classmethod
    def _http_only(cls, url: str) -> str:
        """Accept only http(s) URLs that name a host."""
        parts = urlsplit(url.strip())
        if parts.scheme not in ALLOWED_URL_SCHEMES or not parts.hostname:
            raise ValueError("url must be an http(s) URL")
        return url.strip()


class IcalImportResponse(BaseModel):
    """Response of POST /api/import/ical."""

    imported: int


async def get_http_client() -> AsyncIterator[httpx.AsyncClient]:
    """Yield an HTTP client for one request, closing it afterwards."""
    async with httpx.AsyncClient() as client:
        yield client


def get_url_guard() -> Callable[[str], bool]:
    """Return the check that refuses URLs pointing at private hosts."""
    return is_public_url


@router.post("/import/ical")
async def import_ical(
    body: IcalImportRequest,
    url_guard: Annotated[Callable[[str], bool], Depends(get_url_guard)],
    store: Annotated[EventStore, Depends(get_store)],
    notifier: Annotated[Notifier, Depends(get_notifier)],
    client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> IcalImportResponse:
    """
    Fetch an iCal feed and index its current events.

    Raises:
        HTTPException: 422 for a private host, 502 when the feed cannot be
            fetched or is not an iCalendar file.
    """
    if not url_guard(body.url):
        raise HTTPException(
            HTTP_UNPROCESSABLE, "url must point to a public host"
        )
    try:
        imported_count = await import_feed(body.url, store, notifier, client)
    except httpx.HTTPError as error:
        raise HTTPException(
            HTTP_BAD_GATEWAY, f"could not fetch feed: {error}"
        ) from error
    except ValueError as error:
        raise HTTPException(
            HTTP_BAD_GATEWAY, "feed is not a valid iCalendar file"
        ) from error
    return IcalImportResponse(imported=imported_count)
