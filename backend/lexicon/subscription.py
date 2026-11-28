"""
Validator for app.communitymap.subscription records.

A subscription record means "notify me when this event changes". Like
every AT Protocol record it is saved in its creator's own account (on their
"PDS", the server that stores their account), not in our database, and it is
public. Its schema ("lexicon") lives in
lexicons/app/communitymap/subscription.json at the repo root.

The record points at the event it follows with a "strongRef",
{"uri": "at://...", "cid": "..."}: the event record's address on the
network (AT URI) and a fingerprint (CID) of the version that was followed.
The indexer (#5) will run this validator on every subscription record it
ingests, so the backend knows who to notify when an event changes. (Terms:
docs/projects/triton-event-feed/AT_PROTOCOL_GLOSSARY.md)

The frontend has its own validator
(frontend/src/lexicon/validateSubscription.js). Both are tested against the
same example records in fixtures/subscription/, which keeps them in agreement.

Example:
    >>> from lexicon import validate_subscription
    >>> validate_subscription({"$type": "app.communitymap.subscription"})
    ['subject is required', 'createdAt is required']
"""

import json
import re
from pathlib import Path
from typing import Any

from .event import EVENT_NSID, parse_datetime

SUBSCRIPTION_NSID = "app.communitymap.subscription"

# backend/lexicon/subscription.py -> parents[2] is the repo root.
LEXICON_PATH = (
    Path(__file__).resolve().parents[2]
    / "lexicons"
    / "app"
    / "communitymap"
    / "subscription.json"
)

with LEXICON_PATH.open(encoding="utf-8") as _lexicon_file:
    LEXICON = json.load(_lexicon_file)

_RECORD = LEXICON["defs"]["main"]["record"]
SUBSCRIPTION_REQUIRED: list[str] = _RECORD["required"]

# The shape of a record's address (AT URI):
# at://<account DID>/<record type NSID>/<record key>.
_RECORD_URI_RE = re.compile(r"^at://([^/]+)/([^/]+)/([^/?#]+)$")


def _check_subject_uri(subject_uri: Any) -> list[str]:
    """
    Check that subject.uri is the address (AT URI) of an event record.

    A rule the lexicon language can't express: the strongRef must point at an
    app.communitymap.event, not at any other kind of record.

    :param subject_uri: the subject's "uri" value (untrusted).
    :returns: one message per problem (empty when it is fine).
    """
    if not isinstance(subject_uri, str) or not subject_uri.startswith("at://"):
        return ['subject.uri must be a string starting with "at://"']
    match = _RECORD_URI_RE.match(subject_uri)
    if not match or match.group(2) != EVENT_NSID:
        return [f"subject.uri must point at an {EVENT_NSID} record"]
    return []


def _check_subject(subject: Any) -> list[str]:
    """
    Check the subject: the pointer to the followed event.

    :param subject: a strongRef, {"uri": "at://...", "cid": "..."}
        (untrusted).
    :returns: one message per problem (empty when it is fine).
    """
    if not isinstance(subject, dict):
        return ["subject must be an object with uri and cid"]

    errors = []
    if "uri" not in subject:
        errors.append("subject.uri is required")
    else:
        errors += _check_subject_uri(subject["uri"])
    subject_cid = subject.get("cid")
    if "cid" not in subject:
        errors.append("subject.cid is required")
    elif not isinstance(subject_cid, str) or not subject_cid:
        errors.append("subject.cid must be a non-empty string")
    return errors


def validate_subscription(record: Any) -> list[str]:
    """
    Check an app.communitymap.subscription record.

    :param record: the subscription as a dict (e.g. parsed JSON read from
        the subscriber's account server, their PDS).
    :returns: A list of error messages. An empty list means the record is
        valid. Each message starts with the field it is about, for example
        "subject.cid is required".

    Fields that aren't in the lexicon are ignored, because the lexicon
    evolution rules let future versions add new optional fields.
    """
    if not isinstance(record, dict):
        return ["record must be an object"]

    errors = []
    if record.get("$type") != SUBSCRIPTION_NSID:
        errors.append(f'$type must be "{SUBSCRIPTION_NSID}"')

    for field in SUBSCRIPTION_REQUIRED:
        if field not in record:
            errors.append(f"{field} is required")

    if "subject" in record:
        errors += _check_subject(record["subject"])
    if "createdAt" in record and parse_datetime(record["createdAt"]) is None:
        errors.append(
            "createdAt must be a datetime with a timezone, "
            'e.g. "2026-12-01T18:00:00.000Z"'
        )
    return errors
