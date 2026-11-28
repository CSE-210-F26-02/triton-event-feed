"""HTTP endpoints. Each module holds one APIRouter that main.py mounts."""

from .health_check import health_router

__all__ = ["health_router"]
