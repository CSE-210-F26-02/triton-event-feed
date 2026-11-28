"""GET /api/health and GET /api/config: liveness and public app config."""

from typing import Annotated

from fastapi import APIRouter, Depends

from api.deps import get_app_settings
from config import Settings
from models import EVENT_NSID, LISTENER_NSID

router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, bool]:
    """Report that the API is up (used by e2e tests and load balancers)."""
    return {"ok": True}


@router.get("/config")
def config(
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> dict[str, object]:
    """
    Return the settings the frontend needs to pick its behaviour.

    Args:
        settings: the validated backend settings.

    Returns:
        Whether demo mode and Jetstream are on, and the record NSIDs.
    """
    return {
        "devMode": settings.dev_mode,
        "jetstreamEnabled": settings.jetstream_enabled,
        "eventNsid": EVENT_NSID,
        "listenerNsid": LISTENER_NSID,
    }
