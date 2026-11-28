"""
Tests for backend/config.py (settings read from environment variables).

Every test passes its own dict, so none depend on the developer's .env.
"""

import os
from pathlib import Path

import pytest
from dotenv import dotenv_values

from config import (
    ANY_ORIGIN,
    DEFAULT_EXPIRY_GRACE_SECONDS,
    DEFAULT_EXPIRY_INTERVAL_SECONDS,
    DEFAULT_EXPIRY_PURGE_DAYS,
    DEFAULT_ICAL_INTERVAL_SECONDS,
    DEFAULT_JETSTREAM_URL,
    SAME_ORIGIN_ONLY,
    ConfigError,
    load_env_file,
    load_settings,
    load_settings_from_environment,
)

EXAMPLE_PATH = Path(__file__).resolve().parents[1] / ".env.example"

DEV_ENV = {
    "IS_PROD": "false",
    "PRODUCTION_SITE_URL": "https://events.example.edu",
    "DEV_CORS_ORIGINS": "*",
    "API_HOST": "127.0.0.1",
    "API_PORT": "8000",
    "LOG_LEVEL": "info",
    "DATABASE_PATH": "data/test.db",
    "FRONTEND_DIR": "../frontend",
    "DEV_MODE": "false",
    "JETSTREAM_ENABLED": "false",
}


@pytest.fixture
def clean_environment(monkeypatch):
    """
    Unset every DEV_ENV variable for one test, and undo afterwards
    whatever the test (or load_dotenv) writes to os.environ.

    :param monkeypatch: pytest's monkeypatch fixture.
    :returns: the same monkeypatch, for tests that set more variables.
    """
    for variable_name in DEV_ENV:
        # setenv first so monkeypatch remembers to remove the key again.
        monkeypatch.setenv(variable_name, "placeholder")
        monkeypatch.delenv(variable_name)
    return monkeypatch


def env_with(**overrides):
    """
    DEV_ENV with some variables replaced (None removes a variable).

    :param overrides: new values by variable name.
    :returns: the resulting environment.
    """
    merged = {**DEV_ENV, **overrides}
    return {
        variable_name: value
        for variable_name, value in merged.items()
        if value is not None
    }


def problems_for(environ):
    """
    The ConfigError problems load_settings reports for an environment.

    :param environ: the environment to load.
    :returns: the problem messages.
    """
    with pytest.raises(ConfigError) as caught:
        load_settings(environ)
    return caught.value.problems


def test_example_file_is_a_valid_configuration():
    """
    .env.example must always work as-is, so copying it is enough.
    """
    values = dotenv_values(EXAMPLE_PATH)
    settings = load_settings(values)
    assert settings.is_prod is False
    assert settings.cors_allowed_origins == [ANY_ORIGIN]
    assert settings.dev_mode is False
    assert settings.jetstream_enabled is False


def test_development_settings():
    settings = load_settings(DEV_ENV)
    assert settings.is_prod is False
    assert settings.cors_allowed_origins == [ANY_ORIGIN]
    assert settings.api_host == "127.0.0.1"
    assert settings.api_port == 8000
    assert settings.log_level == "INFO"
    assert settings.database_path == "data/test.db"
    assert settings.frontend_dir == "../frontend"
    assert settings.dev_mode is False
    assert settings.jetstream_enabled is False


def test_production_allows_only_the_site_url():
    settings = load_settings(env_with(IS_PROD="TRUE"))
    assert settings.is_prod is True
    assert settings.cors_allowed_origins == ["https://events.example.edu"]


def test_production_accepts_several_origins():
    origins = "https://a.example.edu, https://b.example.edu"
    settings = load_settings(
        env_with(IS_PROD="yes", PRODUCTION_SITE_URL=origins)
    )
    assert settings.cors_allowed_origins == [
        "https://a.example.edu",
        "https://b.example.edu",
    ]


def test_production_refuses_the_wildcard():
    problems = problems_for(env_with(IS_PROD="true", PRODUCTION_SITE_URL="*"))
    assert problems == ['PRODUCTION_SITE_URL cannot be "*" in production']


@pytest.mark.parametrize("value", [None, "", "   "])
def test_production_without_site_url_is_same_origin_only(value):
    settings = load_settings(
        env_with(IS_PROD="true", PRODUCTION_SITE_URL=value)
    )
    assert settings.cors_allowed_origins == list(SAME_ORIGIN_ONLY) == []


def test_development_still_requires_dev_origins():
    problems = problems_for(env_with(DEV_CORS_ORIGINS=None))
    assert problems == ["DEV_CORS_ORIGINS is required"]


def test_production_does_not_need_dev_origins():
    settings = load_settings(env_with(IS_PROD="true", DEV_CORS_ORIGINS=None))
    assert settings.is_prod is True


def test_development_accepts_listed_origins():
    origins = "http://localhost:5173,http://127.0.0.1:5173"
    settings = load_settings(env_with(DEV_CORS_ORIGINS=origins))
    assert settings.cors_allowed_origins == origins.split(",")


def test_reports_every_missing_variable_at_once():
    problems = problems_for({})
    assert problems == [
        "IS_PROD is required",
        "API_HOST is required",
        "API_PORT is required",
        "LOG_LEVEL is required",
        "DATABASE_PATH is required",
        "FRONTEND_DIR is required",
        "DEV_MODE is required",
        "JETSTREAM_ENABLED is required",
    ]


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_values_count_as_missing(value):
    assert problems_for(env_with(API_HOST=value)) == ["API_HOST is required"]


@pytest.mark.parametrize("value", ["maybe", "Fals", "2"])
def test_rejects_unclear_booleans(value):
    problems = problems_for(env_with(IS_PROD=value))
    assert problems[0].startswith('IS_PROD must be "true" or "false"')


@pytest.mark.parametrize("value", ["0", "65536", "80a", "-1", "8000.5"])
def test_rejects_bad_ports(value):
    problems = problems_for(env_with(API_PORT=value))
    assert problems[0].startswith("API_PORT must be a port number")


@pytest.mark.parametrize(
    "value", ["localhost:3000", "ftp://x.edu", ",", "*,x"]
)
def test_rejects_bad_origins(value):
    problems = problems_for(env_with(DEV_CORS_ORIGINS=value))
    assert problems[0].startswith("DEV_CORS_ORIGINS must be")


def test_rejects_unknown_log_levels():
    problems = problems_for(env_with(LOG_LEVEL="LOUD"))
    assert problems[0].startswith("LOG_LEVEL must be one of")


def test_error_message_names_every_problem_and_the_example_file():
    with pytest.raises(ConfigError) as caught:
        load_settings(env_with(API_PORT="x", LOG_LEVEL="LOUD"))
    message = str(caught.value)
    assert ".env.example" in message
    assert "API_PORT" in message and "LOG_LEVEL" in message


def test_load_env_file_does_not_override_real_environment(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env"
    env_file.write_text("API_HOST=0.0.0.0\nAPI_PORT=9000\n", encoding="utf-8")
    monkeypatch.setenv("API_HOST", "127.0.0.1")
    monkeypatch.delenv("API_PORT", raising=False)
    assert load_env_file(env_file) is True
    assert os.environ["API_HOST"] == "127.0.0.1"
    assert os.environ["API_PORT"] == "9000"


def test_load_env_file_tolerates_a_missing_file(tmp_path):
    assert load_env_file(tmp_path / "missing.env") is False


def test_optional_values_default_when_unset():
    settings = load_settings(DEV_ENV)
    assert settings.jetstream_url == DEFAULT_JETSTREAM_URL
    assert settings.ical_feed_urls == []
    assert settings.ical_interval_seconds == DEFAULT_ICAL_INTERVAL_SECONDS
    assert settings.expiry_interval_seconds == DEFAULT_EXPIRY_INTERVAL_SECONDS
    assert settings.expiry_grace_seconds == DEFAULT_EXPIRY_GRACE_SECONDS
    assert settings.expiry_purge_days == DEFAULT_EXPIRY_PURGE_DAYS


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_optional_values_use_the_default(value):
    settings = load_settings(
        env_with(JETSTREAM_URL=value, EXPIRY_PURGE_DAYS=value)
    )
    assert settings.jetstream_url == DEFAULT_JETSTREAM_URL
    assert settings.expiry_purge_days == DEFAULT_EXPIRY_PURGE_DAYS


def test_optional_values_can_be_set():
    settings = load_settings(
        env_with(
            DEV_MODE="true",
            JETSTREAM_ENABLED="yes",
            JETSTREAM_URL="ws://localhost:6008/subscribe",
            ICAL_FEED_URLS=" https://a.example/x.ics , http://b.example/y ",
            ICAL_INTERVAL_SECONDS="30",
            EXPIRY_INTERVAL_SECONDS="5",
            EXPIRY_GRACE_SECONDS="0",
            EXPIRY_PURGE_DAYS="0",
        )
    )
    assert settings.dev_mode is True
    assert settings.jetstream_enabled is True
    assert settings.jetstream_url == "ws://localhost:6008/subscribe"
    assert settings.ical_feed_urls == [
        "https://a.example/x.ics",
        "http://b.example/y",
    ]
    assert settings.ical_interval_seconds == 30
    assert settings.expiry_interval_seconds == 5
    assert settings.expiry_grace_seconds == 0
    assert settings.expiry_purge_days == 0


@pytest.mark.parametrize("name", ["DEV_MODE", "JETSTREAM_ENABLED"])
def test_rejects_unclear_feature_flags(name):
    problems = problems_for(env_with(**{name: "sometimes"}))
    assert problems[0].startswith(f'{name} must be "true" or "false"')


@pytest.mark.parametrize(
    "value", ["https://jetstream.example", "jetstream.example", "wss://"]
)
def test_rejects_non_websocket_jetstream_url(value):
    problems = problems_for(env_with(JETSTREAM_URL=value))
    assert problems == [f"JETSTREAM_URL must be a ws(s):// URL, got {value!r}"]


@pytest.mark.parametrize(
    "value", ["file:///etc/passwd", "https://ok.example/x.ics,ftp://x/y"]
)
def test_rejects_non_http_feed_urls(value):
    problems = problems_for(env_with(ICAL_FEED_URLS=value))
    assert problems[0].startswith("ICAL_FEED_URLS must be comma-separated")


def test_feed_url_list_ignores_empty_entries():
    settings = load_settings(
        env_with(ICAL_FEED_URLS=",https://a.example/x.ics,,")
    )
    assert settings.ical_feed_urls == ["https://a.example/x.ics"]


@pytest.mark.parametrize(
    "name", ["ICAL_INTERVAL_SECONDS", "EXPIRY_INTERVAL_SECONDS"]
)
@pytest.mark.parametrize("value", ["0", "-5", "1.5", "soon"])
def test_rejects_intervals_below_one_second(name, value):
    problems = problems_for(env_with(**{name: value}))
    assert problems == [
        f"{name} must be a whole number of at least 1, got {value!r}"
    ]


@pytest.mark.parametrize("name", ["EXPIRY_GRACE_SECONDS", "EXPIRY_PURGE_DAYS"])
@pytest.mark.parametrize("value", ["-1", "2.5", "a week"])
def test_rejects_negative_or_fractional_durations(name, value):
    problems = problems_for(env_with(**{name: value}))
    assert problems == [
        f"{name} must be a whole number of at least 0, got {value!r}"
    ]


def test_load_settings_from_environment_reads_the_env_file(
    tmp_path, clean_environment
):
    env_file = tmp_path / ".env"
    lines = [
        f"{variable_name}={value}" for variable_name, value in DEV_ENV.items()
    ]
    env_file.write_text("\n".join(lines), encoding="utf-8")
    clean_environment.setenv("API_PORT", "9001")
    settings = load_settings_from_environment(env_file)
    assert settings.database_path == "data/test.db"
    assert settings.api_port == 9001  # the real environment wins


def test_load_settings_from_environment_reports_problems(
    tmp_path, clean_environment
):
    with pytest.raises(ConfigError):
        load_settings_from_environment(tmp_path / "missing.env")
