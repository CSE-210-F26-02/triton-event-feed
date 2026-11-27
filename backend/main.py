"""FastAPI entry point.

All deployment-specific values come from environment variables (backend/.env
in development; see backend/.env.example and backend/config.py).
"""

import os

from backend.api import health_check
from backend.config import configure_logging, load_env_file, load_settings
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_env_file()
settings = load_settings(os.environ)
configure_logging(settings)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=(["GET", "POST", "PUT", "DELETE", "OPTIONS"]),
    allow_headers=["*"],
)

app.include_router(health_check.health_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.api_host, port=settings.api_port)
