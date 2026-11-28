"""
Turns live changes from the AT Protocol network into event-index updates.

Background for newcomers (full glossary:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md): every user keeps
their own data, as JSON "records", in their own account (a "repository").
Each time someone creates, edits or deletes a record, the network announces
that change, called a "commit". Our Jetstream client (ingest/jetstream.py)
receives those commits and hands each one to the CommitProcessor here, which
decides what it means for Triton Event Feed:

  * an event record (app.communitymap.event): add, update or remove the
    event in our searchable index and tell its subscribers what changed;
  * a listener record (app.communitymap.listener): remember that a host wants
    their Bluesky posts with a hashtag shown on their event;
  * a Bluesky post (app.bsky.feed.post) from such a host: attach it to the
    event as an announcement.

Network-free: everything external (store, notifier, handle lookup, clock) is
injected, so tests can drive it with plain dictionaries.
"""

from __future__ import annotations

import inspect
import logging
import re
from abc import abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import ValidationError

from models import (
    EVENT_NSID,
    HASHTAG_PREFIX,
    LISTENER_NSID,
    POST_NSID,
    EventRecord,
    EventUpdate,
    IndexedEvent,
    Listener,
    ListenerRecord,
)
from notify.base import Notifier
from store.base import EventStore, UpsertResult

logger = logging.getLogger(__name__)

TAG_FACET = "app.bsky.richtext.facet#tag"
_HASHTAG = re.compile(r"(?<![\w#])#([^\s#]+)")
_TRAILING_PUNCTUATION = ".,;:!?)]}\"'"
_TIME_FORMAT = "%a %b %d %H:%M UTC"
_NO_VALUE = "none"
_MAX_LOGGED_ERRORS = 3
_DIFF_SEPARATOR = "; "

ListenersChanged = Callable[[list[str]], None | Awaitable[None]]


class HandleLookup(Protocol):
    """
    Anything that can turn an account id (DID) into a username (handle).

    A DID such as "did:plc:ab12cd" is an account's permanent id; a handle such
    as "tritonfood.bsky.social" is the readable name we show next to an event.
    """

    @abstractmethod
    async def resolve(self, did: str) -> str | None:
        """
        Look up the current username of one account.

        :param did: the account's permanent id, e.g. "did:plc:ab12cd".
        :returns: the handle, e.g. "tritonfood.bsky.social", or None if it
            cannot be found.
        """
        pass


def utcnow() -> datetime:
    """
    Return the current time in UTC (the default injectable clock).

    :returns: an aware datetime in UTC.
    """
    return datetime.now(UTC)


@dataclass(frozen=True)
class Commit:
    """
    One change to one record in one user's account.

    :ivar did: the permanent id of the account that made the change (the
        record's author), e.g. "did:plc:ab12cd".
    :ivar operation: "create", "update" or "delete".
    :ivar collection: the record type (its NSID), e.g.
        "app.communitymap.event" for an event.
    :ivar rkey: the record key: the record's name within its collection,
        like a file name within a folder.
    :ivar cid: a fingerprint of this version of the record; it changes every
        time the record is edited. None for deletes.
    :ivar record: the record's JSON content, or None for deletes.
    """

    did: str
    operation: str
    collection: str
    rkey: str
    cid: str | None
    record: dict[str, Any] | None

    @property
    def uri(self) -> str:
        """
        The record's AT URI: its unique address on the network.

        It has the form at://<author DID>/<record type>/<record key>, and is
        the id an event has everywhere in our index, API and notifications.

        :returns: the AT URI.
        """
        return f"at://{self.did}/{self.collection}/{self.rkey}"


def parse_commit(message: dict[str, Any]) -> Commit | None:
    """
    Pull the record change out of one Jetstream message.

    Jetstream also sends messages that are not record changes (for example
    "an account changed its handle"); those have a "kind" other than "commit"
    and are ignored here.

    :param message: one decoded Jetstream message (untrusted JSON).
    :returns: The commit, or None if message is not a usable commit.
    """
    body = message.get("commit")
    if message.get("kind") != "commit" or not isinstance(body, dict):
        return None
    did = _non_empty_text(message.get("did"))
    operation = _non_empty_text(body.get("operation"))
    collection = _non_empty_text(body.get("collection"))
    rkey = _non_empty_text(body.get("rkey"))
    if did is None or operation is None or collection is None or rkey is None:
        return None
    record = body.get("record")
    return Commit(
        did,
        operation,
        collection,
        rkey,
        _non_empty_text(body.get("cid")),
        record if isinstance(record, dict) else None,
    )


def _non_empty_text(value: object) -> str | None:
    """
    Return value when it is a non-empty string, else None.

    :param value: one field of an untrusted Jetstream message.
    :returns: the string, or None for anything else (missing, "", 42, ...).
    """
    return value if isinstance(value, str) and value else None


# ---- diffs ------------------------------------------------------------------


def _format_time(moment: datetime) -> str:
    """
    Format a time for a change message.

    :param moment: the time to format.
    :returns: e.g. "Thu Nov 12 18:00 UTC".
    """
    return moment.astimezone(UTC).strftime(_TIME_FORMAT)


def _format_list(items: list[str]) -> str:
    """
    Join items with commas, for a change message.

    :param items: e.g. ["food", "free"].
    :returns: e.g. "food, free", or "none" for an empty list.
    """
    return ", ".join(items) or _NO_VALUE


def _changed(label: str, old_record: str, new_record: str) -> str:
    """
    Format one "Label changed: old → new" line.

    :param label: what changed, e.g. "Time".
    :param old_record: the old value, already formatted.
    :param new_record: the new value, already formatted.
    :returns: the line.
    """
    return f"{label} changed: {old_record} → {new_record}"


def _time_changes(
    old_record: EventRecord, new_record: EventRecord
) -> list[str]:
    """
    Describe a change of start time (or, failing that, end time).

    :param old_record: the event as it was stored.
    :param new_record: the event as it is now.
    :returns: one change line, or [] when the times are the same.
    """
    if old_record.starts_at != new_record.starts_at:
        return [
            _changed(
                "Time",
                _format_time(old_record.starts_at),
                _format_time(new_record.starts_at),
            )
        ]
    if old_record.ends_at != new_record.ends_at:
        return [
            _changed(
                "End time",
                _format_time(old_record.ends_at),
                _format_time(new_record.ends_at),
            )
        ]
    return []


def _location_changes(
    old_record: EventRecord, new_record: EventRecord
) -> list[str]:
    """
    Describe a change of place name (or, failing that, any details).

    :param old_record: the event as it was stored.
    :param new_record: the event as it is now.
    :returns: one change line, or [] when the location is the same.
    """
    if old_record.location.name != new_record.location.name:
        return [
            _changed(
                "Location", old_record.location.name, new_record.location.name
            )
        ]
    if old_record.location != new_record.location:
        return ["Location details updated"]
    return []


def diff_events(old_record: EventRecord, new_record: EventRecord) -> list[str]:
    """
    List, in readable words, what changed between two versions of an event.

    :param old_record: the event as it was stored.
    :param new_record: the event as it is now.
    :returns: one line per change, e.g. "Name changed: A → B"; empty when
        nothing people can see has changed.
    """
    changes: list[str] = []
    if old_record.name != new_record.name:
        changes.append(_changed("Name", old_record.name, new_record.name))
    changes += _time_changes(old_record, new_record)
    changes += _location_changes(old_record, new_record)
    if old_record.description != new_record.description:
        changes.append("Description updated")
    if old_record.tags != new_record.tags:
        changes.append(
            _changed(
                "Tags",
                _format_list(old_record.tags),
                _format_list(new_record.tags),
            )
        )
    if old_record.group != new_record.group:
        changes.append(
            _changed(
                "Group",
                old_record.group or _NO_VALUE,
                new_record.group or _NO_VALUE,
            )
        )
    return changes


async def index_event(
    store: EventStore,
    notifier: Notifier,
    event: IndexedEvent,
    existing: IndexedEvent | None,
) -> UpsertResult:
    """
    Upsert event and notify subscribers of meaningful changes.

    :param store: the event store.
    :param notifier: tells subscribers what changed.
    :param event: the new version of the event.
    :param existing: the stored version, whose indexed_at is kept, or None.
    :returns: Whether the event was created, updated or unchanged.
    """
    if existing is not None:
        event = event.model_copy(update={"indexed_at": existing.indexed_at})
    result = store.upsert_event(event)
    if result == "updated" and existing is not None:
        diffs = diff_events(existing.record, event.record)
        if diffs:
            await notifier.publish(
                event.uri, "updated", _DIFF_SEPARATOR.join(diffs)
            )
    return result


# ---- hashtags ---------------------------------------------------------------


def extract_hashtags(post: dict[str, Any]) -> set[str]:
    """
    Every hashtag in a Bluesky post, lower-cased and without the "#".

    Bluesky can mark a hashtag in two ways: as "#word" in the plain text, and
    as a "facet" (a note saying "characters 10-15 of the text are the tag
    'word'"). Both are read, so a tag is found either way.

    :param post: the post record's JSON content.
    :returns: the hashtags found.
    """
    text = post.get("text")
    tags = set()
    if isinstance(text, str):
        tags = {
            match.rstrip(_TRAILING_PUNCTUATION).lower()
            for match in _HASHTAG.findall(text)
        }
    tags |= _facet_tags(post.get("facets") or [])
    tags.discard("")
    return tags


def _facet_tags(facets: Any) -> set[str]:
    """
    Lower-cased tags from a post's tag facets.

    A facet marks a span of a post's text as a link, a mention or a tag; only
    the tag features (TAG_FACET) are read.

    :param facets: the post's "facets" value (untrusted; may be malformed).
    :returns: The tags found, without a leading "#".
    """
    tags: set[str] = set()
    if not isinstance(facets, list):
        return tags
    for facet in facets:
        features = facet.get("features", []) if isinstance(facet, dict) else []
        for feature in features if isinstance(features, list) else []:
            if isinstance(feature, dict) and feature.get("$type") == TAG_FACET:
                tag = feature.get("tag")
                if isinstance(tag, str):
                    tags.add(tag.lstrip(HASHTAG_PREFIX).lower())
    return tags


# ---- processor --------------------------------------------------------------


class CommitProcessor:
    """
    Applies record changes from the network to our event index.

    Handles three record types: events, listeners (a host's "show my posts
    with this hashtag on my event") and Bluesky posts from those hosts.
    Every other record type is ignored.
    """

    def __init__(
        self,
        store: EventStore,
        notifier: Notifier,
        handle_resolver: HandleLookup | None = None,
        on_listeners_changed: ListenersChanged | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        """
        Create a processor.

        :param store: the event store.
        :param notifier: tells subscribers about changes.
        :param handle_resolver: looks up each author's username (handle)
            from their account id (DID), or None to skip.
        :param on_listeners_changed: called with the account ids of every
            host that now has a listener, whenever that list changes.
        :param clock: returns the current time (injected for tests).
        """
        self.store = store
        self.notifier = notifier
        self.handle_resolver = handle_resolver
        self.on_listeners_changed = on_listeners_changed
        self.clock = clock

    async def handle(self, message: dict[str, Any]) -> None:
        """
        Apply one Jetstream message; unusable messages are ignored.

        :param message: one decoded Jetstream message (untrusted JSON).
        """
        commit = parse_commit(message)
        if commit is None:
            return
        if commit.collection == EVENT_NSID:
            await self._handle_event_commit(commit)
        elif commit.collection == LISTENER_NSID:
            await self._handle_listener_commit(commit)
        elif commit.collection == POST_NSID and commit.operation == "create":
            await self._handle_post_commit(commit)

    # events

    async def _handle_event_commit(self, commit: Commit) -> None:
        """
        Add, update or delete one event in the index.

        :param commit: a change to an app.communitymap.event record.
        """
        if commit.operation == "delete":
            await self._delete_event(commit.uri)
            return
        try:
            record = EventRecord.model_validate(commit.record or {})
        except ValidationError as error:
            logger.info(
                "skipping invalid event %s: %s",
                commit.uri,
                error.errors()[:_MAX_LOGGED_ERRORS],
            )
            return
        existing = self.store.get_event(commit.uri)
        now = self.clock()
        event = IndexedEvent(
            uri=commit.uri,
            cid=commit.cid,
            author_did=commit.did,
            author_handle=await self._author_handle(commit.did, existing),
            source="atproto",
            record=record,
            indexed_at=now,
            updated_at=now,
        )
        await index_event(self.store, self.notifier, event, existing)

    async def _delete_event(self, uri: str) -> None:
        """
        Tell subscribers an event was cancelled, then delete it.

        :param uri: the AT URI of the deleted event record.
        """
        existing = self.store.get_event(uri)
        if existing is None:
            return
        # Publish first: the notifier looks up subscribers of this event.
        await self.notifier.publish(
            uri, "deleted", f"{existing.record.name} was cancelled"
        )
        self.store.delete_event(uri)

    async def _author_handle(
        self, did: str, existing: IndexedEvent | None
    ) -> str | None:
        """
        Return the author's username, reusing the stored one if known.

        :param did: the author's permanent account id.
        :param existing: the stored version of the event, or None.
        :returns: the handle, or None when it cannot be looked up.
        """
        if existing is not None and existing.author_handle:
            return existing.author_handle
        if self.handle_resolver is None:
            return None
        return await self.handle_resolver.resolve(did)

    # listeners

    async def _handle_listener_commit(self, commit: Commit) -> None:
        """
        Store or delete a listener record.

        When the set of hosts with a listener changes, on_listeners_changed
        is told, so the Jetstream client can start following the posts of
        exactly those accounts.

        :param commit: a change to an app.communitymap.listener record.
        """
        before = self.store.listener_dids()
        if commit.operation == "delete":
            self.store.delete_listener(commit.uri)
        else:
            listener = self._parse_listener(commit)
            if listener is None:
                return
            self.store.upsert_listener(listener)
        after = self.store.listener_dids()
        if after != before and self.on_listeners_changed is not None:
            callback_result = self.on_listeners_changed(after)
            if inspect.isawaitable(callback_result):
                await callback_result

    def _parse_listener(self, commit: Commit) -> Listener | None:
        """
        Validate a listener record; it must point at the author's own event.

        The check compares account ids: the event's AT URI must start with
        at://<the listener author's DID>/app.communitymap.event/, so nobody
        can attach their posts to someone else's event.

        :param commit: a create or update of a listener record.
        :returns: the listener, or None (and a log line) when it is invalid.
        """
        try:
            record = ListenerRecord.model_validate(commit.record or {})
        except ValidationError as error:
            logger.info(
                "skipping invalid listener %s: %s",
                commit.uri,
                error.errors()[:_MAX_LOGGED_ERRORS],
            )
            return None
        owned_prefix = f"at://{commit.did}/{EVENT_NSID}/"
        if not record.subject.startswith(owned_prefix):
            logger.info(
                "rejecting listener %s: subject %s not owned by author",
                commit.uri,
                record.subject,
            )
            return None
        return Listener(uri=commit.uri, author_did=commit.did, record=record)

    # posts

    async def _handle_post_commit(self, commit: Commit) -> None:
        """
        Attach a host's hashtagged Bluesky post to their events.

        The post becomes an announcement on every event that has a listener
        for one of the post's hashtags.

        :param commit: the creation of an app.bsky.feed.post record.
        """
        listeners = self.store.listeners_for_did(commit.did)
        if not listeners or commit.record is None:
            return
        tags = extract_hashtags(commit.record)
        subjects = {
            listener.record.subject
            for listener in listeners
            if listener.record.hashtag in tags
        }
        text = commit.record.get("text") or ""
        for subject in sorted(subjects):
            update = EventUpdate(
                event_uri=subject,
                text=text,
                source_uri=commit.uri,
                created_at=self.clock(),
            )
            self.store.add_update(update)
            await self.notifier.publish(subject, "announcement", text)
