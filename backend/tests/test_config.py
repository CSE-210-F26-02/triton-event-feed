"""Tests for backend/config.py (settings read from environment variables).

Every test passes its own dict, so none depend on the developer's .env.
"""

import os
from pathlib import Path

import pytest
from dotenv import dotenv_values

from backend.config import (
    ANY_ORIGIN,
    ConfigError,
    load_env_file,
    load_settings,
)

EXAMPLE_PATH = Path(__file__).resolve().parents[1] / ".env.example"

DEV_ENV = {
    "IS_PROD": "false",
    "PRODUCTION_SITE_URL": "https://events.example.edu",
    "DEV_CORS_ORIGINS": "*",
    "API_HOST": "127.0.0.1",
    "API_PORT": "8000",
    "LOG_LEVEL": "info",
}


def env(**overrides):
    """DEV_ENV with some variables replaced (None removes a variable)."""
    merged = {**DEV_ENV, **overrides}
    return {key: value for key, value in merged.items() if value is not None}


def problems_for(environ):
    """The ConfigError problems load_settings reports for environ."""
    with pytest.raises(ConfigError) as caught:
        load_settings(environ)
    return caught.value.problems


def test_example_file_is_a_valid_configuration():
    """.env.example must always work as-is, so copying it is enough."""
    values = dotenv_values(EXAMPLE_PATH)
    settings = load_settings(values)
    assert settings.is_prod is False
    assert settings.cors_allowed_origins == [ANY_ORIGIN]


def test_development_settings():
    settings = load_settings(DEV_ENV)
    assert settings.is_prod is False
    assert settings.cors_allowed_origins == [ANY_ORIGIN]
    assert settings.api_host == "127.0.0.1"
    assert settings.api_port == 8000
    assert settings.log_level == "INFO"


def test_production_allows_only_the_site_url():
    settings = load_settings(env(IS_PROD="TRUE"))
    assert settings.is_prod is True
    assert settings.cors_allowed_origins == ["https://events.example.edu"]


def test_production_accepts_several_origins():
    origins = "https://a.example.edu, https://b.example.edu"
    settings = load_settings(env(IS_PROD="yes", PRODUCTION_SITE_URL=origins))
    assert settings.cors_allowed_origins == [
        "https://a.example.edu",
        "https://b.example.edu",
    ]


def test_production_refuses_the_wildcard():
    problems = problems_for(env(IS_PROD="true", PRODUCTION_SITE_URL="*"))
    assert problems == ['PRODUCTION_SITE_URL cannot be "*" in production']


def test_production_does_not_need_dev_origins():
    settings = load_settings(env(IS_PROD="true", DEV_CORS_ORIGINS=None))
    assert settings.is_prod is True


def test_development_accepts_listed_origins():
    origins = "http://localhost:5173,http://127.0.0.1:5173"
    settings = load_settings(env(DEV_CORS_ORIGINS=origins))
    assert settings.cors_allowed_origins == origins.split(",")


def test_reports_every_missing_variable_at_once():
    problems = problems_for({})
    assert problems == [
        "IS_PROD is required",
        "API_HOST is required",
        "API_PORT is required",
        "LOG_LEVEL is required",
    ]


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_values_count_as_missing(value):
    assert problems_for(env(API_HOST=value)) == ["API_HOST is required"]


@pytest.mark.parametrize("value", ["maybe", "Fals", "2"])
def test_rejects_unclear_booleans(value):
    problems = problems_for(env(IS_PROD=value))
    assert problems[0].startswith('IS_PROD must be "true" or "false"')


@pytest.mark.parametrize("value", ["0", "65536", "80a", "-1", "8000.5"])
def test_rejects_bad_ports(value):
    problems = problems_for(env(API_PORT=value))
    assert problems[0].startswith("API_PORT must be a port number")


@pytest.mark.parametrize(
    "value", ["localhost:3000", "ftp://x.edu", ",", "*,x"]
)
def test_rejects_bad_origins(value):
    problems = problems_for(env(DEV_CORS_ORIGINS=value))
    assert problems[0].startswith("DEV_CORS_ORIGINS must be")


def test_rejects_unknown_log_levels():
    problems = problems_for(env(LOG_LEVEL="LOUD"))
    assert problems[0].startswith("LOG_LEVEL must be one of")


def test_error_message_names_every_problem_and_the_example_file():
    with pytest.raises(ConfigError) as caught:
        load_settings(env(API_PORT="x", LOG_LEVEL="LOUD"))
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
