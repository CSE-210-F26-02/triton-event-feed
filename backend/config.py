"""
Backend settings, read from environment variables.

Every deployment-specific value (host, port, allowed CORS origins, log level,
database path, ...) lives in backend/.env, never in code.
backend/.env.example lists every variable with a working development value:
copy it to backend/.env and edit.

Tuning knobs that rarely change between deployments (how often the expiry
sweep and the iCal poller run, which Jetstream instance to use, ...) are
optional: when they are unset, the documented default below is used.

Real environment variables (e.g. set by a hosting provider) win over the
.env file, so production can configure the app without a file on disk.

load_settings() checks every variable and reports all problems at once, so a
misconfigured server fails immediately with a clear message instead of
misbehaving later.

Example:
    >>> from config import load_settings
    >>> load_settings({"IS_PROD": "false", ...}).api_port
    8000
"""

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

# backend/config.py -> backend/.env, wherever Python is started from.
ENV_PATH = Path(__file__).resolve().parent / ".env"

# Where settings are read from: os.environ, or a plain dict in tests (values
# from dotenv_values() may be None for a bare `NAME` line).
Environ = Mapping[str, str | None]

# Required environment variable names, in one place so code and docs agree.
IS_PROD = "IS_PROD"
PRODUCTION_SITE_URL = "PRODUCTION_SITE_URL"
DEV_CORS_ORIGINS = "DEV_CORS_ORIGINS"
API_HOST = "API_HOST"
API_PORT = "API_PORT"
LOG_LEVEL = "LOG_LEVEL"
DATABASE_PATH = "DATABASE_PATH"
FRONTEND_DIR = "FRONTEND_DIR"
DEV_MODE = "DEV_MODE"
JETSTREAM_ENABLED = "JETSTREAM_ENABLED"

# Optional environment variable names (a default is used when unset).
JETSTREAM_URL = "JETSTREAM_URL"
ICAL_FEED_URLS = "ICAL_FEED_URLS"
ICAL_INTERVAL_SECONDS = "ICAL_INTERVAL_SECONDS"
EXPIRY_INTERVAL_SECONDS = "EXPIRY_INTERVAL_SECONDS"
EXPIRY_GRACE_SECONDS = "EXPIRY_GRACE_SECONDS"
EXPIRY_PURGE_DAYS = "EXPIRY_PURGE_DAYS"

# Defaults for the optional variables.
DEFAULT_JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe"
DEFAULT_ICAL_INTERVAL_SECONDS = 900
DEFAULT_EXPIRY_INTERVAL_SECONDS = 60
# 0 hides an event the moment it ends; raise it to keep ended events visible.
DEFAULT_EXPIRY_GRACE_SECONDS = 0
DEFAULT_EXPIRY_PURGE_DAYS = 7

# Smallest accepted values: a 0-second polling interval would spin the CPU.
_MIN_INTERVAL_SECONDS = 1
_MIN_NON_NEGATIVE = 0

# Accepted spellings for boolean variables.
_TRUE_VALUES = {"true", "1", "yes"}
_FALSE_VALUES = {"false", "0", "no"}

# The CORS wildcard: any origin may call the API (development only).
ANY_ORIGIN = "*"

# No cross-origin callers: only pages served by this backend may call it.
SAME_ORIGIN_ONLY: tuple[str, ...] = ()

# URL schemes accepted for web origins / iCal feeds and for Jetstream.
_HTTP_SCHEMES = {"http", "https"}
_WEBSOCKET_SCHEMES = {"ws", "wss"}

# Separator for list-valued variables such as DEV_CORS_ORIGINS.
_LIST_SEPARATOR = ","

# Valid TCP port range.
_MIN_PORT = 1
_MAX_PORT = 65535

# logging level names accepted for LOG_LEVEL.
_LOG_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class ConfigError(ValueError):
    """
    Raised when one or more environment variables are missing or invalid.

    :ivar problems: one human-readable message per bad variable.
    """

    def __init__(self, problems: list[str]):
        """
        Build the error message from every recorded problem.

        :param problems: one human-readable message per bad variable.
        """
        self.problems = problems
        details = "\n  - ".join(problems)
        super().__init__(
            "Invalid backend configuration (see backend/.env.example):"
            f"\n  - {details}"
        )


@dataclass(frozen=True)
class Settings:
    """
    Validated backend settings.

    :ivar is_prod: True when running in production.
    :ivar cors_allowed_origins: origins allowed to call the API; empty means
        same-origin only (no cross-origin callers).
    :ivar api_host: interface uvicorn binds to, e.g. "127.0.0.1".
    :ivar api_port: TCP port uvicorn listens on.
    :ivar log_level: logging level name, e.g. "INFO".
    :ivar database_path: SQLite file path, or ":memory:" for tests.
    :ivar frontend_dir: folder of static frontend files served at "/".
    :ivar dev_mode: True exposes POST /api/dev/records, which simulates
        firehose commits locally (demo mode).
    :ivar jetstream_enabled: True indexes live records from Jetstream; False
        indexes only via dev mode and iCal imports.
    :ivar jetstream_url: Jetstream WebSocket endpoint (ws:// or wss://).
    :ivar ical_feed_urls: iCal feed URLs polled in the background.
    :ivar ical_interval_seconds: seconds between iCal polling rounds.
    :ivar expiry_interval_seconds: seconds between expiry sweeps.
    :ivar expiry_grace_seconds: seconds an event stays visible after it ends.
    :ivar expiry_purge_days: days an expired event is kept before deletion.
    """

    is_prod: bool
    cors_allowed_origins: list[str]
    api_host: str
    api_port: int
    log_level: str
    database_path: str
    frontend_dir: str
    dev_mode: bool
    jetstream_enabled: bool
    jetstream_url: str
    ical_feed_urls: list[str]
    ical_interval_seconds: int
    expiry_interval_seconds: int
    expiry_grace_seconds: int
    expiry_purge_days: int


def load_env_file(path: Path = ENV_PATH) -> bool:
    """
    Load variables from a .env file into os.environ.

    Variables that are already set are left alone (override=False), so the
    real environment always wins over the file.

    :param path: the .env file to read; a missing file is not an error.
    :returns: True if the file existed and was read.
    """
    return load_dotenv(path, override=False)


def _optional(environ: Environ, name: str) -> str | None:
    """
    Return a variable's trimmed value, or None when unset or blank.

    :param environ: where to read variables from.
    :param name: the variable to read.
    :returns: The trimmed value, or None if the variable is missing or blank.
    """
    value = environ.get(name)
    if value is None or value.strip() == "":
        return None
    return value.strip()


def _require(environ: Environ, name: str, problems: list[str]) -> str | None:
    """Return a variable's trimmed value, or record a problem and None."""
    value = _optional(environ, name)
    if value is None:
        problems.append(f"{name} is required")
    return value


def _parse_bool(
    environ: Environ, name: str, problems: list[str]
) -> bool | None:
    """Parse a true/false variable (true/false, 1/0, yes/no; any case)."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    if value.lower() in _TRUE_VALUES:
        return True
    if value.lower() in _FALSE_VALUES:
        return False
    problems.append(f'{name} must be "true" or "false", got {value!r}')
    return None


def _has_scheme_and_host(value: str, allowed_schemes: set[str]) -> bool:
    """
    True when value is a URL with one of allowed_schemes and a host.

    :param value: the candidate URL, e.g. "https://events.example.edu".
    :param allowed_schemes: accepted schemes, e.g. {"http", "https"}.
    :returns: Whether the scheme is allowed and a host is present.
    """
    parsed = urlparse(value)
    return parsed.scheme in allowed_schemes and bool(parsed.netloc)


def _split_list(value: str) -> list[str]:
    """Split a comma-separated value into trimmed, non-empty parts."""
    parts = value.split(_LIST_SEPARATOR)
    return [part.strip() for part in parts if part.strip()]


def _parse_origins(
    environ: Environ, name: str, problems: list[str]
) -> list[str] | None:
    """Parse a comma-separated list of http(s) origins, or "*"."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    origins = _split_list(value)
    if origins == [ANY_ORIGIN]:
        return origins
    invalid_origins = [
        origin
        for origin in origins
        if not _has_scheme_and_host(origin, _HTTP_SCHEMES)
    ]
    if invalid_origins or not origins:
        problems.append(
            f'{name} must be "*" or comma-separated http(s) origins, '
            f"got {value!r}"
        )
        return None
    return origins


def _parse_port(
    environ: Environ, name: str, problems: list[str]
) -> int | None:
    """Parse a TCP port number (1-65535)."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    if not value.isdigit() or not _MIN_PORT <= int(value) <= _MAX_PORT:
        problems.append(
            f"{name} must be a port number from {_MIN_PORT} to {_MAX_PORT}, "
            f"got {value!r}"
        )
        return None
    return int(value)


def _parse_log_level(
    environ: Environ, name: str, problems: list[str]
) -> str | None:
    """Parse a logging level name such as INFO (any case)."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    if value.upper() not in _LOG_LEVELS:
        levels = ", ".join(sorted(_LOG_LEVELS))
        problems.append(f"{name} must be one of {levels}, got {value!r}")
        return None
    return value.upper()


def _parse_optional_integer(
    environ: Environ,
    name: str,
    problems: list[str],
    default: int,
    minimum: int,
) -> int | None:
    """
    Parse an optional whole number that must be at least minimum.

    :param environ: where to read variables from.
    :param name: the variable to read.
    :param problems: list that collects one message per bad variable.
    :param default: value used when the variable is unset or blank.
    :param minimum: smallest accepted value.
    :returns: The parsed number, the default, or None after recording a
        problem.
    """
    value = _optional(environ, name)
    if value is None:
        return default
    if not value.isdigit() or int(value) < minimum:
        problems.append(
            f"{name} must be a whole number of at least {minimum}, "
            f"got {value!r}"
        )
        return None
    return int(value)


def _parse_optional_jetstream_url(
    environ: Environ, name: str, problems: list[str]
) -> str | None:
    """Parse the optional Jetstream WebSocket URL (ws:// or wss://)."""
    value = _optional(environ, name)
    if value is None:
        return DEFAULT_JETSTREAM_URL
    if not _has_scheme_and_host(value, _WEBSOCKET_SCHEMES):
        problems.append(f"{name} must be a ws(s):// URL, got {value!r}")
        return None
    return value


def _parse_optional_feed_urls(
    environ: Environ, name: str, problems: list[str]
) -> list[str] | None:
    """Parse an optional comma-separated list of http(s) iCal feed URLs."""
    value = _optional(environ, name)
    if value is None:
        return []
    feed_urls = _split_list(value)
    invalid_feed_urls = [
        feed_url
        for feed_url in feed_urls
        if not _has_scheme_and_host(feed_url, _HTTP_SCHEMES)
    ]
    if invalid_feed_urls:
        problems.append(
            f"{name} must be comma-separated http(s) URLs, "
            f"got {', '.join(invalid_feed_urls)!r}"
        )
        return None
    return feed_urls


def _cors_origins(
    environ: Environ, is_prod: bool | None, problems: list[str]
) -> list[str] | None:
    """
    Production allows only PRODUCTION_SITE_URL; development uses
    DEV_CORS_ORIGINS (often "*"). The wildcard is refused in production.

    PRODUCTION_SITE_URL is optional: when unset, no other origin may call
    the API (SAME_ORIGIN_ONLY). The frontend this server hosts itself is
    same-origin, so it keeps working without any CORS origin.
    """
    if is_prod is None:
        return None
    if is_prod and _optional(environ, PRODUCTION_SITE_URL) is None:
        return list(SAME_ORIGIN_ONLY)
    name = PRODUCTION_SITE_URL if is_prod else DEV_CORS_ORIGINS
    origins = _parse_origins(environ, name, problems)
    if is_prod and origins == [ANY_ORIGIN]:
        problems.append(f'{name} cannot be "*" in production')
        return None
    return origins


def _server_settings(
    environ: Environ, problems: list[str]
) -> dict[str, object]:
    """Parse the settings for the web server itself (CORS, host, logs)."""
    is_prod = _parse_bool(environ, IS_PROD, problems)
    return {
        "is_prod": is_prod,
        "cors_allowed_origins": _cors_origins(environ, is_prod, problems),
        "api_host": _require(environ, API_HOST, problems),
        "api_port": _parse_port(environ, API_PORT, problems),
        "log_level": _parse_log_level(environ, LOG_LEVEL, problems),
        "database_path": _require(environ, DATABASE_PATH, problems),
        "frontend_dir": _require(environ, FRONTEND_DIR, problems),
        "dev_mode": _parse_bool(environ, DEV_MODE, problems),
    }


def _ingest_settings(
    environ: Environ, problems: list[str]
) -> dict[str, object]:
    """Parse the settings for Jetstream and iCal ingestion."""
    return {
        "jetstream_enabled": _parse_bool(environ, JETSTREAM_ENABLED, problems),
        "jetstream_url": _parse_optional_jetstream_url(
            environ, JETSTREAM_URL, problems
        ),
        "ical_feed_urls": _parse_optional_feed_urls(
            environ, ICAL_FEED_URLS, problems
        ),
        "ical_interval_seconds": _parse_optional_integer(
            environ,
            ICAL_INTERVAL_SECONDS,
            problems,
            DEFAULT_ICAL_INTERVAL_SECONDS,
            _MIN_INTERVAL_SECONDS,
        ),
    }


def _expiry_settings(
    environ: Environ, problems: list[str]
) -> dict[str, object]:
    """Parse the settings for the background expiry sweep."""
    return {
        "expiry_interval_seconds": _parse_optional_integer(
            environ,
            EXPIRY_INTERVAL_SECONDS,
            problems,
            DEFAULT_EXPIRY_INTERVAL_SECONDS,
            _MIN_INTERVAL_SECONDS,
        ),
        "expiry_grace_seconds": _parse_optional_integer(
            environ,
            EXPIRY_GRACE_SECONDS,
            problems,
            DEFAULT_EXPIRY_GRACE_SECONDS,
            _MIN_NON_NEGATIVE,
        ),
        "expiry_purge_days": _parse_optional_integer(
            environ,
            EXPIRY_PURGE_DAYS,
            problems,
            DEFAULT_EXPIRY_PURGE_DAYS,
            _MIN_NON_NEGATIVE,
        ),
    }


def load_settings(environ: Environ) -> Settings:
    """
    Read and validate every backend setting.

    :param environ: where to read variables from, usually os.environ (after
        load_env_file()). Tests pass a plain dict.
    :returns: The validated Settings.
    :raises ConfigError: listing every missing or invalid variable.
    """
    problems: list[str] = []
    values = {
        **_server_settings(environ, problems),
        **_ingest_settings(environ, problems),
        **_expiry_settings(environ, problems),
    }
    if problems:
        raise ConfigError(problems)
    return _build_settings(values)


def _typed_field[FieldType](
    values: Mapping[str, object], name: str, expected_type: type[FieldType]
) -> FieldType:
    """
    Return one parsed value, checking it has the type its field needs.

    :param values: every parsed value, keyed by Settings field name.
    :param name: the field to read.
    :param expected_type: the type the field holds, e.g. bool or list.
    :returns: the value, now known to be of expected_type.
    :raises TypeError: when a parser returned the wrong type (a bug here,
        not a configuration mistake).
    """
    value = values.get(name)
    if not isinstance(value, expected_type):
        raise TypeError(
            f"setting {name} should be {expected_type.__name__}, "
            f"got {type(value).__name__}"
        )
    return value


def _build_settings(values: Mapping[str, object]) -> Settings:
    """
    Turn the parsed values (all valid, no problems recorded) into Settings.

    :param values: every parsed value, keyed by Settings field name.
    :returns: the validated Settings.
    """
    return Settings(
        is_prod=_typed_field(values, "is_prod", bool),
        cors_allowed_origins=_typed_field(
            values, "cors_allowed_origins", list
        ),
        api_host=_typed_field(values, "api_host", str),
        api_port=_typed_field(values, "api_port", int),
        log_level=_typed_field(values, "log_level", str),
        database_path=_typed_field(values, "database_path", str),
        frontend_dir=_typed_field(values, "frontend_dir", str),
        dev_mode=_typed_field(values, "dev_mode", bool),
        jetstream_enabled=_typed_field(values, "jetstream_enabled", bool),
        jetstream_url=_typed_field(values, "jetstream_url", str),
        ical_feed_urls=_typed_field(values, "ical_feed_urls", list),
        ical_interval_seconds=_typed_field(
            values, "ical_interval_seconds", int
        ),
        expiry_interval_seconds=_typed_field(
            values, "expiry_interval_seconds", int
        ),
        expiry_grace_seconds=_typed_field(values, "expiry_grace_seconds", int),
        expiry_purge_days=_typed_field(values, "expiry_purge_days", int),
    )


def load_settings_from_environment(env_path: Path = ENV_PATH) -> Settings:
    """
    Load backend/.env into os.environ, then read and validate settings.

    :param env_path: the .env file to read; a missing file is not an error.
    :returns: The validated Settings.
    :raises ConfigError: listing every missing or invalid variable.
    """
    load_env_file(env_path)
    return load_settings(os.environ)


def configure_logging(settings: Settings) -> None:
    """
    Set up the root logger at the configured level.

    :param settings: the validated settings; only log_level is used.
    """
    logging.basicConfig(
        level=settings.log_level,
        format=_LOG_FORMAT,
        datefmt=_LOG_DATE_FORMAT,
    )
