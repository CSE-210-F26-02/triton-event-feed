# Single container: FastAPI AppView + static frontend. Fits free tiers (Fly.io, Render, Railway).

# ---- Stage 1: build the frontend with Vite (frontend/dist) ---------------------------
FROM node:22-slim AS frontend-build
WORKDIR /srv
# Dependencies first (cached layer): exact versions from package-lock.json, and no
# package runs an install script.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --ignore-scripts
COPY frontend frontend
# The frontend bundles the shared record schemas (src/lexicon/registry.js).
COPY lexicons lexicons
# Vite bakes the VITE_* settings into the bundle at build time. .env files never enter
# the build context (.dockerignore), so the documented public defaults are used.
RUN cd frontend && cp .env.example .env && npm run build

# ---- Stage 2: the server ----------------------------------------------------------------
FROM python:3.12-slim

# Unprivileged account the server runs as (the base image defaults to root).
ARG APP_USER=appuser
ARG APP_UID=10001

WORKDIR /srv

# Dependencies first (cached layer): exact, hash-pinned versions from uv.lock, wheels
# only, so no package runs a setup script while installing.
COPY backend/requirements.lock backend/requirements.lock
RUN pip install --no-cache-dir --only-binary :all: --require-hashes \
    -r backend/requirements.lock

COPY backend backend
# Only the built site: no source, node_modules or package files in the image.
COPY --from=frontend-build /srv/frontend/dist frontend
COPY lexicons lexicons

# The backend runs from source in /srv/backend (its modules import each other by
# top-level name from the working directory), so it is not pip-installed. Only the
# database volume is writable.
RUN useradd --system --uid "${APP_UID}" --no-create-home --shell /usr/sbin/nologin "${APP_USER}" \
    && mkdir -p /data \
    && chown "${APP_USER}" /data

WORKDIR /srv/backend
# The bundled frontend is served from this same origin, so no CORS origin is
# needed: with PRODUCTION_SITE_URL unset, no other site may call the API. If a
# frontend hosted elsewhere must call it, set PRODUCTION_SITE_URL on the hosting
# platform, e.g. `docker run -e PRODUCTION_SITE_URL=https://events.example.edu`.
ENV IS_PROD=true \
    API_HOST=0.0.0.0 \
    API_PORT=8000 \
    LOG_LEVEL=INFO \
    DATABASE_PATH=/data/communitymap.db \
    FRONTEND_DIR=/srv/frontend \
    DEV_MODE=false \
    JETSTREAM_ENABLED=true
VOLUME /data
EXPOSE 8000
# Numeric UID so platforms that enforce "run as non-root" can verify it.
USER ${APP_UID}
CMD ["python", "main.py"]
