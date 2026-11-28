"""
FastAPI entry point and composition root.

This is the only module that knows the concrete classes: it builds the
store, notifier and ingest pipeline, starts the background loops and mounts
every API router. Everything else depends only on the interfaces in
store/base.py and notify/base.py.

All deployment-specific values come from environment variables (backend/.env
in development; see backend/.env.example and backend/config.py).

Run from the backend/ folder:
    python main.py                                   # uses API_HOST/API_PORT
    uv run main.py
    uvicorn main:create_app --factory --reload       # auto-reload for dev
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from api import dev, events, health_check, imports, meta, subscriptions
from config import Settings, configure_logging, load_settings_from_environment
from expiry import run_expiry_loop
from ingest.handles import HandleResolver
from ingest.ical import run_ical_loop
from ingest.jetstream import JetstreamClient
from ingest.processor import CommitProcessor
from notify.service import SubscriptionNotifier
from store.sqlite import SqliteStore

logger = logging.getLogger(__name__)

# "AppView" is the AT Protocol name for a server that collects records
# from users' accounts and serves an app's view of them: our events index.
APP_TITLE = "Triton Event Feed AppView"
APP_VERSION = "0.1.0"

# Responses smaller than this are sent uncompressed.
GZIP_MINIMUM_SIZE_BYTES = 1024

CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
CORS_ALLOWED_HEADERS = ["*"]

# Static frontend mount point and name.
FRONTEND_MOUNT_PATH = "/"
FRONTEND_MOUNT_NAME = "frontend"

# Files that exist only in the frontend source folder, never in its build.
FRONTEND_SOURCE_MARKERS = ("package.json",)
FRONTEND_BUILD_HINT = (
    "Build it with `npm run build` in frontend/ and set FRONTEND_DIR to "
    "frontend/dist (see backend/.env.example)."
)

# Every router the app serves, in the order they are mounted.
API_ROUTERS = (
    health_check.health_router,
    meta.router,
    events.router,
    subscriptions.router,
    imports.router,
    dev.router,
)

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def _start_background_tasks(
    settings: Settings,
    store: SqliteStore,
    notifier: SubscriptionNotifier,
    processor: CommitProcessor,
) -> list[asyncio.Task]:
    """
    Start the expiry sweep, the iCal poller and (if enabled) Jetstream.

    :param settings: the validated settings.
    :param store: the event store the loops read and write.
    :param notifier: tells subscribers about expired or changed events.
    :param processor: turns record changes from the network (Jetstream
        commits) into index changes.
    :returns: The started tasks, so the caller can cancel them on shutdown.
    """
    tasks = [
        asyncio.create_task(run_expiry_loop(store, notifier, settings)),
        asyncio.create_task(run_ical_loop(store, notifier, settings)),
    ]
    if settings.jetstream_enabled:
        jetstream_client = JetstreamClient(
            settings.jetstream_url, processor, store
        )
        tasks.append(asyncio.create_task(jetstream_client.run_forever()))
    return tasks


async def _cancel_tasks(tasks: list[asyncio.Task]) -> None:
    """
    Cancel every task and wait until each one has stopped.

    :param tasks: the background tasks to stop.
    """
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


def _build_lifespan(settings: Settings, background: bool) -> Lifespan:
    """
    Build the startup/shutdown handler that owns every service.

    :param settings: the validated settings.
    :param background: False skips the background loops (used by tests).
    :returns: A FastAPI lifespan function.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """
        Create the services on startup and release them on shutdown.

        :param app: the FastAPI app; the services are placed on app.state.
        :yields: once startup is done; shutdown runs when the app stops.
        """
        store = SqliteStore(settings.database_path)
        notifier = SubscriptionNotifier(store)
        resolver = HandleResolver()
        processor = CommitProcessor(store, notifier, resolver)
        app.state.settings, app.state.store = settings, store
        app.state.notifier, app.state.processor = notifier, processor
        tasks = []
        if background:
            tasks = _start_background_tasks(
                settings, store, notifier, processor
            )
        try:
            yield
        finally:
            await _cancel_tasks(tasks)
            await resolver.aclose()
            store.close()

    return lifespan


def _add_middleware(app: FastAPI, settings: Settings) -> None:
    """
    Add response compression and CORS.

    :param app: the application to configure.
    :param settings: the validated settings; cors_allowed_origins is used.
    """
    app.add_middleware(GZipMiddleware, minimum_size=GZIP_MINIMUM_SIZE_BYTES)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=True,
        allow_methods=CORS_ALLOWED_METHODS,
        allow_headers=CORS_ALLOWED_HEADERS,
    )


def is_frontend_source(folder: Path) -> bool:
    """
    True when folder is the frontend's source (frontend/), not its build.

    The source cannot run in a browser as-is (Vite must resolve its npm
    imports and VITE_* settings), and serving it would also publish files
    such as frontend/.env and package.json.

    :param folder: the folder FRONTEND_DIR points at.
    :returns: Whether a source-only marker file (package.json) is present.
    """
    return any(
        (folder / marker).is_file() for marker in FRONTEND_SOURCE_MARKERS
    )


def _mount_frontend(app: FastAPI, frontend_dir: str) -> None:
    """
    Serve the built frontend at "/" when its folder exists.

    A missing folder, or the unbuilt source folder, is logged and skipped:
    the API keeps working either way.

    :param app: the application to configure.
    :param frontend_dir: folder holding the built frontend (frontend/dist).
    """
    frontend = Path(frontend_dir)
    if not frontend.is_dir():
        logger.warning(
            "frontend dir %s not found; serving API only. %s",
            frontend,
            FRONTEND_BUILD_HINT,
        )
        return
    if is_frontend_source(frontend):
        logger.error(
            "FRONTEND_DIR %s is the frontend source, not a build; serving "
            "API only. %s",
            frontend,
            FRONTEND_BUILD_HINT,
        )
        return
    app.mount(
        FRONTEND_MOUNT_PATH,
        StaticFiles(directory=frontend, html=True),
        name=FRONTEND_MOUNT_NAME,
    )


def create_app(
    settings: Settings | None = None, *, background: bool = True
) -> FastAPI:
    """
    Build the FastAPI application.

    :param settings: the validated settings; None reads them from backend/.env
        and the environment (and sets up logging).
    :param background: False skips the expiry, iCal and Jetstream loops.
    :returns: The configured application.
    :raises ConfigError: when settings is None and the environment is invalid.
    """
    if settings is None:
        settings = load_settings_from_environment()
        configure_logging(settings)
    app = FastAPI(
        title=APP_TITLE,
        version=APP_VERSION,
        lifespan=_build_lifespan(settings, background),
    )
    _add_middleware(app, settings)
    for router in API_ROUTERS:
        app.include_router(router)
    _mount_frontend(app, settings.frontend_dir)
    return app


def run_server() -> None:
    """
    Read settings from the environment and serve the app with uvicorn.
    """
    settings = load_settings_from_environment()
    configure_logging(settings)
    uvicorn.run(
        create_app(settings), host=settings.api_host, port=settings.api_port
    )


if __name__ == "__main__":
    run_server()
