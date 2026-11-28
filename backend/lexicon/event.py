"""
Validator for app.communitymap.event records.

An event "record" is the JSON a host saves in their own AT Protocol account
when they create an event; "app.communitymap.event" is the name of that
record type (its NSID). The record's schema, its "lexicon", lives in
lexicons/app/communitymap/event.json at the repo root. The server that
stores the host's account does not know our schema, so a record can arrive
with any content at all; this module is what rejects bad ones. (Terms:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md)

This module reads its size limits from the lexicon file, so the numbers here
can never go out of date. The reasoning is in
docs/projects/triton-event-feed/ADR/Event-Lexicon.md.

The frontend has its own validator (frontend/src/lexicon/validateEvent.js).
Both are tested against the same example records in fixtures/event/, which
keeps them in agreement.

"Start can't be in the past" is intentionally NOT checked here. It is a
create-event form rule (issue #6); otherwise every event that has already
happened would be rejected.

Example:
    >>> from lexicon import validate_event
    >>> validate_event({"$type": "app.communitymap.event"})
    ['name is required', ...]
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import regex

EVENT_NSID = "app.communitymap.event"

# backend/lexicon/event.py -> parents[2] is the repo root. Resolving from this
# file (not the current folder) means it works no matter where Python runs.
LEXICON_PATH = (
    Path(__file__).resolve().parents[2]
    / "lexicons"
    / "app"
    / "communitymap"
    / "event.json"
)

with LEXICON_PATH.open(encoding="utf-8") as _lexicon_file:
    LEXICON = json.load(_lexicon_file)

_RECORD = LEXICON["defs"]["main"]["record"]
_LOCATION = LEXICON["defs"]["location"]

# Each field's rules straight from the JSON, e.g. {"type": "string",
# "maxLength": 1000, "maxGraphemes": 100} for "name".
EVENT_PROPS: dict[str, dict] = _RECORD["properties"]
LOCATION_PROPS: dict[str, dict] = _LOCATION["properties"]
EVENT_REQUIRED: list[str] = _RECORD["required"]
LOCATION_REQUIRED: list[str] = _LOCATION["required"]

# The datetime format every AT Protocol record uses:
# "2026-12-01T18:00:00.000Z" or "...-08:00".
# Uppercase T, seconds required, fractional seconds optional, and a timezone
# (Z or +HH:MM / -HH:MM) required.
_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)

# A plain decimal number such as "32.8801" or "-117.2375". Stricter than
# float(), which would also accept " 1", "1e2", "nan" or "inf".
_DECIMAL_RE = re.compile(r"^-?\d+(\.\d+)?$")

# lat/lng ranges, in decimal degrees.
_COORD_RANGES = {"lat": (-90, 90), "lng": (-180, 180)}


def count_graphemes(text: str) -> int:
    """
    Count characters the way a person sees them.

    One emoji or one accented letter counts as 1, even when it is made of
    several Unicode code points. The \\X pattern matches one such character.

    :param text: the text to measure.
    :returns: the number of visible characters.
    """
    return len(regex.findall(r"\X", text))


def _check_string(value: Any, field: str, rules: dict) -> list[str]:
    """
    Check a string against its lexicon rules.

    maxLength and minLength are measured in UTF-8 bytes, and maxGraphemes
    in visible characters, as the AT Protocol lexicon spec defines them.

    :param value: the field's value (untrusted).
    :param field: the field's name, used in the error messages.
    :param rules: the field's rules from the lexicon file.
    :returns: one message per broken rule (empty when it is fine).
    """
    if not isinstance(value, str):
        return [f"{field} must be a string"]

    min_bytes = rules.get("minLength")
    max_bytes = rules.get("maxLength")
    max_chars = rules.get("maxGraphemes")
    byte_length = len(value.encode("utf-8"))

    errors = []
    if min_bytes is not None and byte_length < min_bytes:
        if min_bytes == 1:
            errors.append(f"{field} must not be empty")
        else:
            errors.append(f"{field} must be at least {min_bytes} bytes")
    if max_bytes is not None and byte_length > max_bytes:
        errors.append(f"{field} must be at most {max_bytes} bytes")
    if max_chars is not None and count_graphemes(value) > max_chars:
        errors.append(f"{field} must be at most {max_chars} characters")
    return errors


def parse_datetime(value: Any) -> datetime | None:
    """
    Parse an AT Protocol datetime string.

    The format is ISO 8601 with seconds and a timezone, e.g.
    "2026-12-01T18:00:00.000Z".

    :param value: the string to parse (untrusted).
    :returns: the datetime, or None if value is not valid (wrong type, wrong
        format, timezone "-00:00", or an impossible date such as February
        30).
    """
    if not isinstance(value, str):
        return None
    match = _DATETIME_RE.match(value)
    if not match or value.endswith("-00:00"):
        return None

    # Python only keeps 6 digits of fractional seconds, so trim or pad them.
    fraction = match.group(1)
    if fraction:
        digits = fraction[1:7].ljust(6, "0")
        value = value.replace(fraction, "." + digits, 1)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _check_datetime(value: Any, field: str) -> list[str]:
    """
    Check that a field holds a valid AT Protocol datetime string.

    :param value: the field's value (untrusted).
    :param field: the field's name, used in the error messages.
    :returns: one message when it is invalid (empty when it is fine).
    """
    if parse_datetime(value) is None:
        return [
            f"{field} must be a datetime with a timezone, "
            'e.g. "2026-12-01T18:00:00.000Z"'
        ]
    return []


def _check_coordinate(value: Any, field: str) -> list[str]:
    """
    Check a lat or lng: a decimal-number string within range.

    :param value: the coordinate (untrusted).
    :param field: "lat" or "lng".
    :returns: one message per problem (empty when it is fine).
    """
    name = f"location.{field}"
    errors = _check_string(value, name, LOCATION_PROPS[field])
    if errors:
        return errors
    if not _DECIMAL_RE.match(value):
        return [f'{name} must be a decimal number, e.g. "32.8801"']
    minimum, maximum = _COORD_RANGES[field]
    if not minimum <= float(value) <= maximum:
        return [f"{name} must be between {minimum} and {maximum}"]
    return []


def _check_location(location: Any) -> list[str]:
    """
    Check the location object: required lat/lng plus optional text.

    :param location: the record's "location" value (untrusted).
    :returns: one message per problem (empty when it is fine).
    """
    if not isinstance(location, dict):
        return ["location must be an object"]

    errors = []
    for field in LOCATION_REQUIRED:
        if field not in location:
            errors.append(f"location.{field} is required")
    for field in ("lat", "lng"):
        if field in location:
            errors += _check_coordinate(location[field], field)
    for field in ("name", "address"):
        if field in location:
            errors += _check_string(
                location[field], f"location.{field}", LOCATION_PROPS[field]
            )
    return errors


def _check_tags(tags: Any) -> list[str]:
    """
    Check the tags list: how many there are, and each tag's length.

    :param tags: the record's "tags" value (untrusted).
    :returns: one message per problem (empty when it is fine).
    """
    if not isinstance(tags, list):
        return ["tags must be a list"]

    max_count = EVENT_PROPS["tags"]["maxLength"]
    tag_rules = EVENT_PROPS["tags"]["items"]

    errors = []
    if len(tags) > max_count:
        errors.append(f"tags must have at most {max_count} items")
    for index, tag in enumerate(tags):
        errors += _check_string(tag, f"tags[{index}]", tag_rules)
    return errors


def _check_group(group: Any) -> list[str]:
    """
    Check the group field: a pointer to the group the event belongs to.

    It is a "strongRef", {"uri": "at://...", "cid": "..."}: the group
    record's address on the network (AT URI) plus a fingerprint (CID) of the
    exact version that was linked.

    :param group: the field's value (untrusted).
    :returns: one message per problem (empty when it is fine).
    """
    if not isinstance(group, dict):
        return ["group must be an object with uri and cid"]

    errors = []
    group_uri = group.get("uri")
    if not isinstance(group_uri, str) or not group_uri.startswith("at://"):
        errors.append('group.uri must be a string starting with "at://"')
    group_cid = group.get("cid")
    if not isinstance(group_cid, str) or not group_cid:
        errors.append("group.cid must be a non-empty string")
    return errors


def validate_event(record: Any) -> list[str]:
    """
    Check an app.communitymap.event record.

    :param record: the event as a dict (e.g. parsed JSON read from the
        host's account server, their PDS).
    :returns: A list of error messages. An empty list means the record is
        valid. Each message starts with the field it is about, for example
        "name must be at most 100 characters".

    Fields that aren't in the lexicon are ignored, because the lexicon
    evolution rules let future versions add new optional fields.
    """
    if not isinstance(record, dict):
        return ["record must be an object"]

    errors = []

    if record.get("$type") != EVENT_NSID:
        errors.append(f'$type must be "{EVENT_NSID}"')

    for field in EVENT_REQUIRED:
        if field not in record:
            errors.append(f"{field} is required")

    # Each optional or required field is only checked if it is present;
    # missing required fields were already reported above.
    for field in ("name", "description"):
        if field in record:
            errors += _check_string(record[field], field, EVENT_PROPS[field])
    for field in ("startsAt", "endsAt", "createdAt"):
        if field in record:
            errors += _check_datetime(record[field], field)
    if "location" in record:
        errors += _check_location(record["location"])
    if "tags" in record:
        errors += _check_tags(record["tags"])
    if "group" in record:
        errors += _check_group(record["group"])

    # A rule the lexicon language can't express: the event must end after
    # it starts. Only checked when both datetimes are themselves valid.
    starts_at = parse_datetime(record.get("startsAt"))
    ends_at = parse_datetime(record.get("endsAt"))
    if starts_at and ends_at and ends_at <= starts_at:
        errors.append("endsAt must be after startsAt")

    return errors
