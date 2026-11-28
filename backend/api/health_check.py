"""
Health check API endpoints.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

health_router = APIRouter(prefix="/api/health", tags=["Health"])


@health_router.get("/check")
async def health_check():
    """
    Health check endpoint to verify if the API is running.

    :returns: a 200 JSON response with a status message.
    """
    return JSONResponse(content={"status": "API is running"}, status_code=200)
