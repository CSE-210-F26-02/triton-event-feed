"""
Shared domain models: the contract between ingest, store and API.

Two kinds of model live here (AT Protocol words are explained in
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md):

  * "Record" models (EventRecord, ListenerRecord) mirror, field for field,
    the JSON that users store in their own accounts. The allowed fields of
    each record type are defined by its lexicon (a schema) in lexicons/.
  * Index models (IndexedEvent, Listener, ...) are our own: a record plus
    what we know about it, such as its address and its author.

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

# Record type names (NSIDs). Every record says which type it is, the way a
# file extension does, and Jetstream filters by these names.
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
    """
    Base model: camelCase JSON aliases, snake_case Python names.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Location(_Camel):
    """
    Where an event happens; lat/lng are decimal strings.
    """

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    address: str | None = Field(default=None, max_length=MAX_ADDRESS_LENGTH)
    lat: str | None = None
    lng: str | None = None

    @field_validator("lat", "lng")
    @classmethod
    def _require_numeric(cls, coordinate: str | None) -> str | None:
        """
        Reject coordinates that are not numbers.

        :param coordinate: lat or lng as a string, or None.
        :returns: the coordinate, unchanged.
        :raises ValueError: when it is not a number.
        """
        if coordinate is not None:
            float(coordinate)  # raises ValueError -> validation error
        return coordinate


class EventRecord(_Camel):
    """
    The content of one event, exactly as the host stored it in their
    account (an app.communitymap.event record).
    """

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
        """
        Lower-case, strip "#", truncate and de-duplicate tags.

        :param tags: the tags as written in the record.
        :returns: the cleaned tags, in their first-seen order.
        """
        normalized: list[str] = []
        for tag in tags:
            cleaned = tag.strip().lstrip(HASHTAG_PREFIX).lower()
            cleaned = cleaned[:MAX_TAG_LENGTH]
            if cleaned and cleaned not in normalized:
                normalized.append(cleaned)
        return normalized

    @model_validator(mode="after")
    def _ends_after_start(self) -> EventRecord:
        """
        Reject events that end before they start.

        :returns: the record, unchanged.
        :raises ValueError: when endsAt is earlier than startsAt.
        """
        if self.ends_at < self.starts_at:
            raise ValueError("endsAt must be >= startsAt")
        return self


Source = Literal["atproto", "ical"]


class IndexedEvent(_Camel):
    """
    An event as stored in our searchable index.

    Our backend is the event "AppView": it collects event records from
    everyone's accounts and serves them to the map and list. This model is
    the record plus what we know about where it came from.

    :ivar uri: the event's unique id. For network events, its AT URI
        at://<author DID>/app.communitymap.event/<record key>; for imported
        calendar events, ical://<feed>/<uid>.
    :ivar cid: a fingerprint of this version of the record (it changes on
        every edit), or None for calendar events.
    :ivar author_did: the author's permanent account id.
    :ivar author_handle: the author's username, e.g.
        "tritonfood.bsky.social", if it could be looked up.
    :ivar source: "atproto" (from the network) or "ical" (from a feed).
    :ivar record: the event's content.
    :ivar indexed_at: when we first stored the event.
    :ivar updated_at: when we last stored a change to it.
    """

    uri: str
    cid: str | None = None
    author_did: str
    author_handle: str | None = None
    source: Source = "atproto"
    record: EventRecord
    indexed_at: datetime
    updated_at: datetime


class ListenerRecord(_Camel):
    """
    A host's request to show their hashtagged posts on their event.

    Exactly the app.communitymap.listener record: "when I post on Bluesky
    with #hashtag, attach the post to the event at `subject`" (subject is
    that event's AT URI).
    """

    subject: str
    hashtag: str = Field(min_length=1, max_length=MAX_HASHTAG_LENGTH)
    created_at: datetime

    @field_validator("hashtag")
    @classmethod
    def _normalize_hashtag(cls, hashtag: str) -> str:
        """
        Lower-case the hashtag and strip a leading "#".

        :param hashtag: the hashtag as written in the record.
        :returns: the cleaned hashtag.
        """
        return hashtag.strip().lstrip(HASHTAG_PREFIX).lower()


class Listener(_Camel):
    """
    A listener record as stored in our index.

    :ivar uri: the listener record's own AT URI.
    :ivar author_did: the permanent account id of the host who created it.
    :ivar record: the listener's content.
    """

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
    # AT URI (address on the network) of the Bluesky post it came from.
    source_uri: str | None = None
    created_at: datetime


NotificationKind = Literal["updated", "deleted", "announcement", "expired"]


class Notification(_Camel):
    """
    One message for one subscriber about one event.
    """

    id: int | None = None
    subscriber_id: str
    event_uri: str
    kind: NotificationKind
    message: str
    created_at: datetime


class Page(_Camel):
    """
    One page of query results plus the cursor for the next page.
    """

    events: list[IndexedEvent]
    cursor: str | None = None


class Count(_Camel):
    """
    How many visible events share one tag or group value.
    """

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
        """
        Reject non-finite or out-of-range coordinates.

        :returns: the box, unchanged.
        :raises ValueError: when a coordinate is not finite or out of range.
        """
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

        :param bbox_param: e.g. "-117.25,32.87,-117.22,32.89".
        :returns: the bounding box.
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
    """
    Filters, sort order and paging for EventStore.query_events.
    """

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
