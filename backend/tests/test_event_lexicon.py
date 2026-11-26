"""Run every shared fixture in fixtures/event/ through validate_event.

The frontend's Vitest suite runs the same files, so both validators must
agree on what a valid event is.
"""

import json
from pathlib import Path

import pytest

from backend.lexicon import validate_event
from backend.lexicon.event import LEXICON_PATH, count_graphemes

# backend/tests/test_event_lexicon.py -> parents[2] is the repo root.
FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures" / "event"


def load_fixtures(folder):
    """Return a pytest.param per .json file in fixtures/event/<folder>/."""
    files = sorted((FIXTURES_DIR / folder).glob("*.json"))
    return [
        pytest.param(json.loads(f.read_text(encoding="utf-8")), id=f.name)
        for f in files
    ]


VALID = load_fixtures("valid")
INVALID = load_fixtures("invalid")


def test_fixtures_were_found():
    """Guard against a wrong path silently running zero fixture tests."""
    assert VALID and INVALID


@pytest.mark.parametrize("fixture", VALID)
def test_valid_fixture(fixture):
    assert validate_event(fixture["record"]) == []


@pytest.mark.parametrize("fixture", INVALID)
def test_invalid_fixture(fixture):
    errors = validate_event(fixture["record"])
    expected = fixture["expectedErrorContains"]
    assert any(
        expected in e for e in errors
    ), f"expected an error containing {expected!r}, got {errors}"


def test_lexicon_path_exists():
    assert LEXICON_PATH.is_file()


def test_graphemes_count_emoji_as_one():
    # A family emoji is several code points but one visible character.
    assert count_graphemes("👨‍👩‍👧") == 1
    assert count_graphemes("café") == 4
