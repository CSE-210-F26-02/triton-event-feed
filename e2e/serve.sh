#!/usr/bin/env sh
# Builds the frontend, then starts a fresh, seeded backend for e2e runs (demo mode on,
# no live network) that serves that build.
set -e
cd "$(dirname "$0")/../frontend"
if [ ! -f .env ]; then
  echo "frontend/.env is missing: cp frontend/.env.example frontend/.env" >&2
  exit 1
fi
npm run build
cd ../backend
PY="${PYTHON:-../.venv/bin/python}"
DB="$(mktemp -d)/e2e.db"
# Real environment variables win over backend/.env (see backend/config.py).
export IS_PROD=false DEV_CORS_ORIGINS="*" API_HOST=127.0.0.1 API_PORT="${PORT:-8100}" \
    LOG_LEVEL=INFO DATABASE_PATH="$DB" FRONTEND_DIR=../frontend/dist DEV_MODE=true \
    JETSTREAM_ENABLED=false EXPIRY_INTERVAL_SECONDS=2 ICAL_FEED_URLS=
"$PY" seed.py
exec "$PY" main.py
