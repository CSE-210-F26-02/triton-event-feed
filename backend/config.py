"""Backend settings, read from environment variables.

Every deployment-specific value (host, port, allowed CORS origins, log level,
...) lives in backend/.env, never in code. backend/.env.example lists every
variable with a working development value: copy it to backend/.env and edit.

Real environment variables (e.g. set by a hosting provider) win over the
.env file, so production can configure the app without a file on disk.

load_settings() checks every variable and reports all problems at once, so a
misconfigured server fails immediately with a clear message instead of
misbehaving later.

Example:
    >>> from backend.config import load_settings
    >>> load_settings({"IS_PROD": "false", ...}).api_port
    8000
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

# backend/config.py -> backend/.env, wherever Python is started from.
ENV_PATH = Path(__file__).resolve().parent / ".env"

# Environment variable names, in one place so code and docs agree.
IS_PROD = "IS_PROD"
PRODUCTION_SITE_URL = "PRODUCTION_SITE_URL"
DEV_CORS_ORIGINS = "DEV_CORS_ORIGINS"
API_HOST = "API_HOST"
API_PORT = "API_PORT"
LOG_LEVEL = "LOG_LEVEL"

# Accepted spellings for boolean variables.
_TRUE_VALUES = {"true", "1", "yes"}
_FALSE_VALUES = {"false", "0", "no"}

# The CORS wildcard: any origin may call the API (development only).
ANY_ORIGIN = "*"

# Valid TCP port range.
_MIN_PORT = 1
_MAX_PORT = 65535

# logging level names accepted for LOG_LEVEL.
_LOG_LEVELS = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}


class ConfigError(ValueError):
    """Raised when one or more environment variables are missing or invalid.

    Attributes:
        problems: one human-readable message per bad variable.
    """

    def __init__(self, problems: list[str]):
        self.problems = problems
        details = "\n  - ".join(problems)
        super().__init__(
            "Invalid backend configuration (see backend/.env.example):"
            f"\n  - {details}"
        )


@dataclass(frozen=True)
class Settings:
    """Validated backend settings.

    Attributes:
        is_prod: True when running in production.
        cors_allowed_origins: origins allowed to call the API.
        api_host: interface uvicorn binds to, e.g. "127.0.0.1".
        api_port: TCP port uvicorn listens on.
        log_level: logging level name, e.g. "INFO".
    """

    is_prod: bool
    cors_allowed_origins: list[str]
    api_host: str
    api_port: int
    log_level: str


def load_env_file(path: Path = ENV_PATH) -> bool:
    """Load variables from a .env file into os.environ.

    Variables that are already set are left alone (override=False), so the
    real environment always wins over the file.

    Args:
        path: the .env file to read; a missing file is not an error.

    Returns:
        True if the file existed and was read.
    """
    return load_dotenv(path, override=False)


def _require(environ: Mapping[str, str], name: str, problems: list[str]):
    """Return a variable's trimmed value, or record a problem and None."""
    value = environ.get(name)
    if value is None or value.strip() == "":
        problems.append(f"{name} is required")
        return None
    return value.strip()


def _parse_bool(environ, name, problems) -> bool | None:
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


def _is_http_origin(value: str) -> bool:
    """True for an http(s) origin such as "https://events.example.edu"."""
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _parse_origins(environ, name, problems) -> list[str] | None:
    """Parse a comma-separated list of http(s) origins, or "*"."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    origins = [item.strip() for item in value.split(",") if item.strip()]
    if origins == [ANY_ORIGIN]:
        return origins
    bad = [item for item in origins if not _is_http_origin(item)]
    if bad or not origins:
        expected = '"*" or comma-separated http(s) origins'
        problems.append(f"{name} must be {expected}, got {value!r}")
        return None
    return origins


def _parse_port(environ, name, problems) -> int | None:
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


def _parse_log_level(environ, name, problems) -> str | None:
    """Parse a logging level name such as INFO (any case)."""
    value = _require(environ, name, problems)
    if value is None:
        return None
    if value.upper() not in _LOG_LEVELS:
        levels = ", ".join(sorted(_LOG_LEVELS))
        problems.append(f"{name} must be one of {levels}, got {value!r}")
        return None
    return value.upper()


def _cors_origins(environ, is_prod, problems) -> list[str] | None:
    """Production allows only PRODUCTION_SITE_URL; development uses
    DEV_CORS_ORIGINS (often "*"). The wildcard is refused in production."""
    if is_prod is None:
        return None
    name = PRODUCTION_SITE_URL if is_prod else DEV_CORS_ORIGINS
    origins = _parse_origins(environ, name, problems)
    if is_prod and origins == [ANY_ORIGIN]:
        problems.append(f'{name} cannot be "*" in production')
        return None
    return origins


def load_settings(environ: Mapping[str, str]) -> Settings:
    """Read and validate every backend setting.

    Args:
        environ: where to read variables from, usually os.environ (after
            load_env_file()). Tests pass a plain dict.

    Returns:
        The validated Settings.

    Raises:
        ConfigError: listing every missing or invalid variable.
    """
    problems: list[str] = []
    is_prod = _parse_bool(environ, IS_PROD, problems)
    settings = {
        "is_prod": is_prod,
        "cors_allowed_origins": _cors_origins(environ, is_prod, problems),
        "api_host": _require(environ, API_HOST, problems),
        "api_port": _parse_port(environ, API_PORT, problems),
        "log_level": _parse_log_level(environ, LOG_LEVEL, problems),
    }
    if problems:
        raise ConfigError(problems)
    return Settings(**settings)


def configure_logging(settings: Settings) -> None:
    """Set up the root logger at the configured level."""
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
