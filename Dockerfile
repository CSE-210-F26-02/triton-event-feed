# Single container: FastAPI AppView + static frontend. Fits free tiers (Fly.io, Render, Railway).
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
COPY frontend frontend
COPY lexicons lexicons

# The backend runs from source in /srv/backend (uvicorn imports `app` from the working
# directory), so it is not pip-installed. Only the database volume is writable.
RUN useradd --system --uid "${APP_UID}" --no-create-home --shell /usr/sbin/nologin "${APP_USER}" \
    && mkdir -p /data \
    && chown "${APP_USER}" /data

WORKDIR /srv/backend
ENV CM_DB_PATH=/data/communitymap.db CM_FRONTEND_DIR=/srv/frontend CM_JETSTREAM_ENABLED=true CM_DEV_MODE=false
VOLUME /data
EXPOSE 8000
# Numeric UID so platforms that enforce "run as non-root" can verify it.
USER ${APP_UID}
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
