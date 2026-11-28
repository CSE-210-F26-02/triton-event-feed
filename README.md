# Community Map

Campus events on the AT Protocol. Students browse a feed of events near UCSD, filter by tag or org, and subscribe to get live updates. Hosts post events with their Bluesky account, so the data lives in their own PDS and not in our database.

**Status:** working prototype. It has 98 backend tests, 81 frontend tests and 16 Playwright user-story tests, and CI runs all of them.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install --require-hashes -r backend/requirements-dev.lock
(cd frontend && npm ci && cp .env.example .env && npm run build)   # -> frontend/dist
cd backend
cp .env.example .env                                   # then edit; every variable is explained
../.venv/bin/python seed.py                            # 12 sample UCSD events
DEV_MODE=true ../.venv/bin/uvicorn main:create_app --factory --reload
# or: ../.venv/bin/python main.py   (listens on API_HOST:API_PORT from .env)
# open http://localhost:8000   (API docs: /docs)
```

FastAPI serves the built frontend in `frontend/dist`, so rebuild (`npm run build` in `frontend/`) after frontend changes, or use `npm run dev` for live reload. All backend settings live in `backend/.env` (see `backend/.env.example`); real environment variables override it. `DEV_MODE=true` turns on **Demo mode**: you can post events without a Bluesky account. Set `JETSTREAM_ENABLED=true` to index real records from the network.

Backend layout: `api/` (HTTP endpoints), `store/` (database), `ingest/` (Jetstream, iCal, handles), `notify/` (subscriber notifications), `utils/` (helpers), `lexicon/` (record validators); `main.py`, `config.py`, `models.py`, `expiry.py` and `seed.py` sit in `backend/` itself.

Tests: `cd backend && ../.venv/bin/pytest` · `cd frontend && npm ci && npm test`

User-story tests (Playwright; starts its own seeded server on :8100):
```bash
cd e2e && npm ci && npx playwright install chromium && npx playwright test
```

| User story | Spec |
|---|---|
| Student discovers and filters events (desktop + mobile) | `e2e/tests/discover.spec.js` |
| Last-minute Larry: moves location, attendees notified live | `e2e/tests/last-minute-larry.spec.js` |
| Host Henry: Bluesky hashtag post syncs to the event | `e2e/tests/host-henry.spec.js` |
| Events expire gracefully | `e2e/tests/expiry.spec.js` |
| Poor WiFi: cached feed while offline | `e2e/tests/offline.spec.js` |

## What it does

| Requirement (from the spec) | Where |
|---|---|
| Curated feed: list view first, filters by tag, group and text, "near me" | `frontend/src/views/listView.js`, `filterBar.js`, `GET /api/events` |
| Map of events/POIs (secondary tab, loaded on demand) | `frontend/src/views/mapView.js` (Leaflet + OSM; tile URL is configurable) |
| Hosts post events with a time window and location | `frontend/src/atproto.js` writes `app.communitymap.event` to the user's PDS |
| Events expire gracefully | Badges show "Ending soon", subscribers get an "ended" notice, then `backend/expiry.py` removes the event |
| Subscribe to an event and get notified when it changes | `backend/notify/`, SSE stream, plus catch-up on reconnect |
| Listeners: sync event updates from Bluesky posts (Host Henry) | An `app.communitymap.listener` record. A post with `#hashtag` becomes an announcement on the event |
| Import from other sources | iCal feeds (`backend/ingest/ical.py`, `POST /api/import/ical`) |
| Poor campus WiFi | A service worker caches the app shell and API responses, the app shows a stale-data banner, and responses are gzipped |
| No location stored | The user's position stays in the browser. The server never sees it |

## Docs

- [Architecture + infrastructure diagram](docs/projects/triton-event-feed/ARCHITECTURE.md)
- [How the work was split](docs/projects/triton-event-feed/TEAM.md)
- [Design decisions to debate](docs/projects/triton-event-feed/DECISIONS.md)
- [API and record contracts](docs/projects/triton-event-feed/CONTRACTS.md) · [Lexicons](lexicons/)
