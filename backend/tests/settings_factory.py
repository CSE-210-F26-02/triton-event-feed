"""
Builds complete Settings for tests, so no test reads backend/.env.
"""

from dataclasses import replace

from config import (
    ANY_ORIGIN,
    DEFAULT_EXPIRY_GRACE_SECONDS,
    DEFAULT_EXPIRY_INTERVAL_SECONDS,
    DEFAULT_EXPIRY_PURGE_DAYS,
    DEFAULT_ICAL_INTERVAL_SECONDS,
    DEFAULT_JETSTREAM_URL,
    Settings,
)

# A development configuration with every optional value at its default.
BASE_TEST_SETTINGS = Settings(
    is_prod=False,
    cors_allowed_origins=[ANY_ORIGIN],
    api_host="127.0.0.1",
    api_port=8000,
    log_level="INFO",
    database_path=":memory:",
    frontend_dir="../frontend/dist",
    dev_mode=False,
    jetstream_enabled=False,
    jetstream_url=DEFAULT_JETSTREAM_URL,
    ical_feed_urls=[],
    ical_interval_seconds=DEFAULT_ICAL_INTERVAL_SECONDS,
    expiry_interval_seconds=DEFAULT_EXPIRY_INTERVAL_SECONDS,
    expiry_grace_seconds=DEFAULT_EXPIRY_GRACE_SECONDS,
    expiry_purge_days=DEFAULT_EXPIRY_PURGE_DAYS,
)


def make_test_settings(**overrides: object) -> Settings:
    """
    Return BASE_TEST_SETTINGS with some fields replaced.

    :param overrides: Settings field names and the values to use instead.
    :returns: A new, complete Settings.
    """
    return replace(BASE_TEST_SETTINGS, **overrides)
