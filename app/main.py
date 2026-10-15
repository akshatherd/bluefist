import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import routes as api_routes
from app.core.config import settings

@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    task = api_routes._monitor_task
    if task and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(
    title="Bluefist API",
    description="Human-reviewed incident triage and repair prototype",
    version="0.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(api_routes.router)
app.include_router(api_routes.websocket_router)
