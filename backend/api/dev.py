"""
POST /api/dev/records: feed a Jetstream-shaped commit straight to the
processor (dev mode only).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from api.deps import get_app_settings
from config import Settings
from ingest.processor import CommitProcessor

router = APIRouter(prefix="/api")

HTTP_NOT_FOUND = 404


def get_processor(request: Request) -> CommitProcessor:
    """Return the commit processor that main.py placed on app.state."""
    return request.app.state.processor


def require_dev_mode(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """
    Hide the route (404) unless dev mode is on.

    :raises HTTPException: 404 when settings.dev_mode is False.
    """
    if not settings.dev_mode:
        raise HTTPException(HTTP_NOT_FOUND, "Not Found")


@router.post("/dev/records", dependencies=[Depends(require_dev_mode)])
async def post_dev_record(
    message: Annotated[dict[str, Any], Body()],
    processor: Annotated[CommitProcessor, Depends(get_processor)],
) -> dict[str, bool]:
    """
    Process one Jetstream-shaped message as if it came from the network.

    :param message: a Jetstream commit message.
    :param processor: the commit processor.
    :returns: {"ok": True} once the message has been handled.
    """
    await processor.handle(message)
    return {"ok": True}
