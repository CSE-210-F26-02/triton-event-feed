"""
Integration test: full app wired by main.create_app,
dev commit -> feed -> notification.
"""

import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

import main
import seed
from config import ConfigError
from main import create_app
from models import EventQuery
from store.sqlite import SqliteStore
from tests.settings_factory import make_test_settings

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
BUILT_PAGE_MARKER = "built-frontend-page"


def commit(operation: str, record: dict | None = None) -> dict:
    """
    Build a Jetstream commit for the event 3kabc of did:plc:host.

    :param operation: "create", "update" or "delete".
    :param record: the record's content (omitted for deletes).
    :returns: the decoded message.
    """
    body: dict[str, object] = {
        "operation": operation,
        "collection": "app.communitymap.event",
        "rkey": "3kabc",
        "cid": operation,
    }
    if record:
        body["record"] = record
    return {
        "did": "did:plc:host",
        "time_us": 1,
        "kind": "commit",
        "commit": body,
    }


RECORD = {
    "name": "Taco Night",
    "startsAt": "2099-01-01T18:00:00Z",
    "endsAt": "2099-01-01T20:00:00Z",
    "location": {"name": "Price Center"},
    "tags": ["food"],
    "createdAt": "2098-12-01T00:00:00Z",
}


def make_built_frontend(parent):
    """
    Create a minimal built frontend (what `npm run build` emits).

    :param parent: the folder to create dist/ in.
    :returns: the dist/ folder.
    """
    built = parent / "dist"
    (built / "assets").mkdir(parents=True)
    (built / "index.html").write_text(
        f"<html><body>{BUILT_PAGE_MARKER}</body></html>", encoding="utf-8"
    )
    (built / "assets" / "index-abc123.js").write_text("", encoding="utf-8")
    (built / "sw.js").write_text("", encoding="utf-8")
    return built


def test_end_to_end(tmp_path):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        dev_mode=True,
        frontend_dir=str(make_built_frontend(tmp_path)),
    )
    with TestClient(create_app(settings, background=False)) as client:
        assert client.get("/api/health").json()["ok"] is True
        assert (
            client.post(
                "/api/dev/records", json=commit("create", RECORD)
            ).status_code
            == 200
        )

        events = client.get("/api/events", params={"tag": "food"}).json()[
            "events"
        ]
        assert [event["name"] for event in events] == ["Taco Night"]
        uri = events[0]["uri"]

        subscription_request = {"subscriberId": "tester-123", "eventUri": uri}
        assert (
            client.post(
                "/api/subscriptions", json=subscription_request
            ).status_code
            == 204
        )

        moved = {**RECORD, "location": {"name": "Sun God Lawn"}}
        client.post("/api/dev/records", json=commit("update", moved))
        notes = client.get(
            "/api/notifications", params={"subscriberId": "tester-123"}
        ).json()
        assert notes[0]["kind"] == "updated"
        assert "Sun God Lawn" in notes[0]["message"]

        page = client.get("/")  # the built frontend is served
        assert page.status_code == 200
        assert BUILT_PAGE_MARKER in page.text


def test_dev_route_disabled_by_default(tmp_path):
    settings = make_test_settings(database_path=str(tmp_path / "t.db"))
    with TestClient(create_app(settings, background=False)) as client:
        assert (
            client.post(
                "/api/dev/records", json=commit("create", RECORD)
            ).status_code
            == 404
        )


def test_health_check_router_is_mounted(tmp_path):
    settings = make_test_settings(database_path=str(tmp_path / "t.db"))
    with TestClient(create_app(settings, background=False)) as client:
        response = client.get("/api/health/check")
    assert response.status_code == 200
    assert response.json() == {"status": "API is running"}


def test_create_app_reads_settings_from_the_environment(tmp_path, monkeypatch):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"), dev_mode=True
    )
    monkeypatch.setattr(
        main, "load_settings_from_environment", lambda: settings
    )
    with TestClient(main.create_app(background=False)) as client:
        assert client.get("/api/config").json()["devMode"] is True


def test_create_app_raises_on_invalid_environment(monkeypatch):
    def invalid_environment():
        """
        Stand in for load_settings with an invalid environment.

        :raises ConfigError: always.
        """
        raise ConfigError(["IS_PROD is required"])

    monkeypatch.setattr(
        main, "load_settings_from_environment", invalid_environment
    )
    with pytest.raises(ConfigError):
        main.create_app(background=False)


def test_cors_allows_only_configured_origins(tmp_path):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        is_prod=True,
        cors_allowed_origins=["https://events.example.edu"],
    )
    with TestClient(create_app(settings, background=False)) as client:
        allowed = client.get(
            "/api/health", headers={"Origin": "https://events.example.edu"}
        )
        refused = client.get(
            "/api/health", headers={"Origin": "https://evil.example"}
        )
    assert (
        allowed.headers["access-control-allow-origin"]
        == "https://events.example.edu"
    )
    assert "access-control-allow-origin" not in refused.headers


def test_same_origin_only_refuses_every_cross_origin_caller(tmp_path):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        is_prod=True,
        cors_allowed_origins=[],
    )
    with TestClient(create_app(settings, background=False)) as client:
        same_origin = client.get("/api/health")
        cross_origin = client.get(
            "/api/health", headers={"Origin": "https://other.example"}
        )
    assert same_origin.json() == {"ok": True}
    assert "access-control-allow-origin" not in cross_origin.headers


def test_built_frontend_files_are_served(tmp_path):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        frontend_dir=str(make_built_frontend(tmp_path)),
    )
    with TestClient(create_app(settings, background=False)) as client:
        assert client.get("/sw.js").status_code == 200
        assert client.get("/assets/index-abc123.js").status_code == 200
        assert client.get("/api/health").json() == {"ok": True}


def test_frontend_source_folder_is_never_served(tmp_path, caplog):
    source = tmp_path / "frontend"
    source.mkdir()
    (source / "package.json").write_text("{}", encoding="utf-8")
    (source / "index.html").write_text("<html></html>", encoding="utf-8")
    (source / ".env").write_text("VITE_SECRET=x", encoding="utf-8")
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"), frontend_dir=str(source)
    )
    with caplog.at_level(logging.ERROR, logger="main"):
        app = create_app(settings, background=False)
    assert "is the frontend source, not a build" in caplog.text
    assert "npm run build" in caplog.text
    with TestClient(app) as client:
        assert client.get("/").status_code == 404
        assert client.get("/.env").status_code == 404
        assert client.get("/package.json").status_code == 404
        assert client.get("/api/health").json() == {"ok": True}


def test_is_frontend_source(tmp_path):
    assert main.is_frontend_source(tmp_path) is False
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    assert main.is_frontend_source(tmp_path) is True


def test_missing_frontend_dir_logs_how_to_build(tmp_path, caplog):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        frontend_dir=str(tmp_path / "no-such-folder"),
    )
    with caplog.at_level(logging.WARNING, logger="main"):
        create_app(settings, background=False)
    assert "not found; serving API only" in caplog.text
    assert "npm run build" in caplog.text


def test_missing_frontend_dir_still_serves_the_api(tmp_path):
    settings = make_test_settings(
        database_path=str(tmp_path / "t.db"),
        frontend_dir=str(tmp_path / "no-such-folder"),
    )
    with TestClient(create_app(settings, background=False)) as client:
        assert client.get("/api/health").json() == {"ok": True}
        assert client.get("/").status_code == 404


def test_seed_main_fills_the_configured_database(
    tmp_path, monkeypatch, capsys
):
    database_path = str(tmp_path / "seeded.db")
    settings = make_test_settings(database_path=database_path)
    monkeypatch.setattr(
        seed, "load_settings_from_environment", lambda: settings
    )
    seed.main()
    assert f"seeded 12 events into {database_path}" in capsys.readouterr().out
    store = SqliteStore(database_path)
    try:
        page = store.query_events(
            EventQuery(ends_after=EPOCH, limit=100), datetime.now(UTC)
        )
    finally:
        store.close()
    assert len(page.events) == 12
