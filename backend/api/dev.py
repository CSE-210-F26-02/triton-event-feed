"""
POST /api/dev/records: pretend a record change arrived from the network.

Normally events reach us when a host saves a record in their own AT Protocol
account and Jetstream (the live network feed) tells us about the change, a
"commit". In dev mode this route accepts a message shaped exactly like a
Jetstream commit and feeds it straight to the CommitProcessor, so the app
can be demoed and tested without a real account or network access. See
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md.
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
    """
    Return the commit processor that main.py placed on app.state.

    :param request: the current HTTP request, whose app.state holds it.
    :returns: the processor that applies record changes to the index.
    """
    return request.app.state.processor


def require_dev_mode(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """
    Hide the route (404) unless dev mode is on.

    :param settings: the validated backend settings.
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

    :param message: a message shaped like Jetstream's, e.g. {"did": ...,
        "kind": "commit", "commit": {"operation": "create", ...}}.
    :param processor: the commit processor.
    :returns: {"ok": True} once the message has been handled.
    """
    await processor.handle(message)
    return {"ok": True}
