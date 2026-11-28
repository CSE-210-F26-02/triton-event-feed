"""
Event storage: the EventStore interface and its SQLite implementation.
"""

from store.base import EventStore, UpsertResult

__all__ = ["EventStore", "UpsertResult"]
