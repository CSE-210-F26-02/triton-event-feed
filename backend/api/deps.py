"""FastAPI dependencies. main.py puts the concrete objects on app.state."""

from fastapi import Request

from config import Settings
from notify.base import Notifier
from store.base import EventStore


def get_store(request: Request) -> EventStore:
    """Return the event store that main.py placed on app.state."""
    return request.app.state.store


def get_notifier(request: Request) -> Notifier:
    """Return the notifier that main.py placed on app.state."""
    return request.app.state.notifier


def get_app_settings(request: Request) -> Settings:
    """Return the validated settings that main.py placed on app.state."""
    return request.app.state.settings
