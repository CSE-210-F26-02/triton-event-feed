"""
Shared domain models: the contract between ingest, store and API.

Lexicon record JSON is camelCase; Python attributes are snake_case. Use
`model_validate(record_json)` to parse and `model_dump(by_alias=True)` to emit.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

EVENT_NSID = "app.communitymap.event"
LISTENER_NSID = "app.communitymap.listener"
POST_NSID = "app.bsky.feed.post"

# Field limits shared with the lexicon (lexicons/*.json).
MAX_NAME_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 3000
MAX_ADDRESS_LENGTH = 300
MAX_TAGS = 10
MAX_TAG_LENGTH = 32
MAX_GROUP_LENGTH = 100
MAX_HASHTAG_LENGTH = 64
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
BBOX_PARTS = 4

# Valid coordinate ranges, in degrees.
MIN_LATITUDE, MAX_LATITUDE = -90.0, 90.0
MIN_LONGITUDE, MAX_LONGITUDE = -180.0, 180.0

HASHTAG_PREFIX = "#"


class _Camel(BaseModel):
    """Base model: camelCase JSON aliases, snake_case Python names."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Location(_Camel):
    """Where an event happens; lat/lng are decimal strings."""

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    address: str | None = Field(default=None, max_length=MAX_ADDRESS_LENGTH)
    lat: str | None = None
    lng: str | None = None

    @field_validator("lat", "lng")
    @classmethod
    def _require_numeric(cls, coordinate: str | None) -> str | None:
        """Reject coordinates that are not numbers."""
        if coordinate is not None:
            float(coordinate)  # raises ValueError -> validation error
        return coordinate


class EventRecord(_Camel):
    """Exactly the app.communitymap.event lexicon record."""

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    description: str = Field(default="", max_length=MAX_DESCRIPTION_LENGTH)
    starts_at: datetime
    ends_at: datetime
    location: Location
    tags: list[str] = Field(default_factory=list, max_length=MAX_TAGS)
    group: str | None = Field(default=None, max_length=MAX_GROUP_LENGTH)
    source_url: str | None = None
    created_at: datetime

    @field_validator("tags")
    @classmethod
    def _normalize_tags(cls, tags: list[str]) -> list[str]:
        """Lower-case, strip "#", truncate and de-duplicate tags."""
        normalized: list[str] = []
        for tag in tags:
            cleaned = tag.strip().lstrip(HASHTAG_PREFIX).lower()
            cleaned = cleaned[:MAX_TAG_LENGTH]
            if cleaned and cleaned not in normalized:
                normalized.append(cleaned)
        return normalized

    @model_validator(mode="after")
    def _ends_after_start(self) -> EventRecord:
        """Reject events that end before they start."""
        if self.ends_at < self.starts_at:
            raise ValueError("endsAt must be >= startsAt")
        return self


Source = Literal["atproto", "ical"]


class IndexedEvent(_Camel):
    """An event as stored in our index (AppView)."""

    # at://did/app.communitymap.event/rkey, or ical://<feed>/<uid>
    uri: str
    cid: str | None = None
    author_did: str
    author_handle: str | None = None
    source: Source = "atproto"
    record: EventRecord
    indexed_at: datetime
    updated_at: datetime


class ListenerRecord(_Camel):
    """Exactly the app.communitymap.listener lexicon record."""

    subject: str
    hashtag: str = Field(min_length=1, max_length=MAX_HASHTAG_LENGTH)
    created_at: datetime

    @field_validator("hashtag")
    @classmethod
    def _normalize_hashtag(cls, hashtag: str) -> str:
        """Lower-case the hashtag and strip a leading "#"."""
        return hashtag.strip().lstrip(HASHTAG_PREFIX).lower()


class Listener(_Camel):
    """A listener record as stored in our index."""

    uri: str
    author_did: str
    record: ListenerRecord


class EventUpdate(_Camel):
    """
    An announcement attached to an event (e.g. from a Bluesky post
    picked up by a listener).
    """

    event_uri: str
    text: str
    # at:// URI of the originating post.
    source_uri: str | None = None
    created_at: datetime


NotificationKind = Literal["updated", "deleted", "announcement", "expired"]


class Notification(_Camel):
    """One message for one subscriber about one event."""

    id: int | None = None
    subscriber_id: str
    event_uri: str
    kind: NotificationKind
    message: str
    created_at: datetime


class Page(_Camel):
    """One page of query results plus the cursor for the next page."""

    events: list[IndexedEvent]
    cursor: str | None = None


class Count(_Camel):
    """How many visible events share one tag or group value."""

    value: str
    count: int


SortOrder = Literal["soonest", "newest"]


class BoundingBox(_Camel):
    """
    Geographic bounds in west,south,east,north order
    (minLng,minLat,maxLng,maxLat).
    """

    west: float
    south: float
    east: float
    north: float

    @model_validator(mode="after")
    def _check_bounds(self) -> BoundingBox:
        """Reject non-finite or out-of-range coordinates."""
        coordinates = (self.west, self.south, self.east, self.north)
        if not all(math.isfinite(value) for value in coordinates):
            raise ValueError("bbox coordinates must be finite numbers")
        if not MIN_LATITUDE <= self.south <= self.north <= MAX_LATITUDE:
            raise ValueError(
                "bbox latitudes must satisfy -90 <= south <= north <= 90"
            )
        if not all(
            MIN_LONGITUDE <= longitude <= MAX_LONGITUDE
            for longitude in (self.west, self.east)
        ):
            raise ValueError("bbox longitudes must be between -180 and 180")
        return self

    @classmethod
    def from_param(cls, bbox_param: str) -> BoundingBox:
        """
        Parse a "west,south,east,north" query-string value.

        :raises ValueError: when there are not four numbers, or they are out of
            range.
        """
        parts = [part.strip() for part in bbox_param.split(",")]
        if len(parts) != BBOX_PARTS:
            raise ValueError("bbox must be 'west,south,east,north'")
        try:
            west, south, east, north = (float(part) for part in parts)
        except ValueError as error:
            raise ValueError("bbox values must be numbers") from error
        return cls(west=west, south=south, east=east, north=north)


class EventQuery(_Camel):
    """Filters, sort order and paging for EventStore.query_events."""

    # Match ANY of these tags.
    tags: list[str] = Field(default_factory=list)
    group: str | None = None
    # Case-insensitive substring over name, description and location.
    text: str | None = None
    starts_before: datetime | None = None
    # Default: now (hide expired events).
    ends_after: datetime | None = None
    bbox: BoundingBox | None = None
    sort: SortOrder = "soonest"
    limit: int = Field(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)
    # Opaque, from Page.cursor.
    cursor: str | None = None
