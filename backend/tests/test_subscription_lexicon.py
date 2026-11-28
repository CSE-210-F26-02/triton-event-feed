"""
Run every shared fixture in fixtures/subscription/ through
validate_subscription.

The frontend's Vitest suite runs the same files, so both validators must
agree on what a valid subscription is.
"""

import json
from pathlib import Path

import pytest

from lexicon import SUBSCRIPTION_NSID, validate_subscription
from lexicon.subscription import LEXICON_PATH

# backend/tests/test_subscription_lexicon.py -> parents[2] is the repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "fixtures" / "subscription"

EVENT_DID = "did:plc:7iza6de2dwap2sbkpav7c6c6"
EVENT_URI = f"at://{EVENT_DID}/app.communitymap.event/3lbxq7k2mzs2a"
EVENT_CID = "bafyreihooyosut5ztb3xty23uwoyij5ovnqr5qldanntxmah33quatfwoy"


def load_fixtures(folder):
    """
    Return a pytest.param per .json file in fixtures/subscription/<folder>/.

    :param folder: "valid" or "invalid".
    :returns: one param per fixture, named after its file.
    """
    files = sorted((FIXTURES_DIR / folder).glob("*.json"))
    return [
        pytest.param(
            json.loads(fixture_file.read_text(encoding="utf-8")),
            id=fixture_file.name,
        )
        for fixture_file in files
    ]


def make_record(**overrides):
    """
    Build a valid subscription record, with fields replaced by overrides.

    :param overrides: field values to replace.
    :returns: the record.
    """
    record = {
        "$type": SUBSCRIPTION_NSID,
        "subject": {"uri": EVENT_URI, "cid": EVENT_CID},
        "createdAt": "2026-11-26T18:00:00.000Z",
    }
    record.update(overrides)
    return record


VALID = load_fixtures("valid")
INVALID = load_fixtures("invalid")


def test_fixtures_were_found():
    """
    Guard against a wrong path silently running zero fixture tests.
    """
    assert VALID and INVALID


@pytest.mark.parametrize("fixture", VALID)
def test_valid_fixture(fixture):
    assert validate_subscription(fixture["record"]) == []


@pytest.mark.parametrize("fixture", INVALID)
def test_invalid_fixture(fixture):
    errors = validate_subscription(fixture["record"])
    expected = fixture["expectedErrorContains"]
    message = f"expected an error containing {expected!r}, got {errors}"
    assert any(expected in error for error in errors), message


def test_lexicon_path_exists():
    assert LEXICON_PATH.is_file()


@pytest.mark.parametrize("record", [None, "subscription", 42, []])
def test_rejects_non_objects(record):
    assert validate_subscription(record) == ["record must be an object"]


def test_rejects_wrong_type():
    record = make_record(**{"$type": "app.bsky.feed.like"})
    errors = validate_subscription(record)
    assert errors == [f'$type must be "{SUBSCRIPTION_NSID}"']


@pytest.mark.parametrize("subject", ["at://x", 7, ["uri", "cid"], None])
def test_rejects_subject_that_is_not_an_object(subject):
    errors = validate_subscription(make_record(subject=subject))
    assert errors == ["subject must be an object with uri and cid"]


@pytest.mark.parametrize("invalid_cid", ["", 5, None])
def test_rejects_empty_or_non_string_cid(invalid_cid):
    record = make_record(subject={"uri": EVENT_URI, "cid": invalid_cid})
    errors = validate_subscription(record)
    assert errors == ["subject.cid must be a non-empty string"]


@pytest.mark.parametrize(
    "non_event_uri",
    [
        "at://did:plc:abc/app.communitymap.event",
        "at://did:plc:abc/app.communitymap.group/3lbxq7k2mzs2a",
    ],
)
def test_rejects_uri_that_is_not_an_event_record(non_event_uri):
    record = make_record(subject={"uri": non_event_uri, "cid": EVENT_CID})
    errors = validate_subscription(record)
    expected = "subject.uri must point at an app.communitymap.event record"
    assert errors == [expected]


def test_rejects_createdat_without_timezone():
    record = make_record(createdAt="2026-11-26T18:00:00")
    errors = validate_subscription(record)
    assert len(errors) == 1 and errors[0].startswith("createdAt")
