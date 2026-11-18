from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api import *
import os
from dotenv import load_dotenv
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

load_dotenv()

app = FastAPI()
load_dotenv()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        (
            "*"
            if os.getenv("IS_PROD") == "False"
            else os.getenv("PRODUCTION_SITE_URL") or "http://localhost:3000"
        )
    ],
    allow_credentials=True,
    allow_methods=(
        ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
        if os.getenv("IS_PROD") == "False"
        else ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    ),
    allow_headers=["*"],
)

app.include_router(health_router)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
