from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import router

app = FastAPI(
    title="BLUEFIST API",
    description="BLUEFIST Autonomous Reliability Engine — Live Site Monitor",
    version="2.0.0",
)

# ─────────────────────────────────────────────────────────────────────────────
# CORS MIDDLEWARE
# Allows the Next.js frontend (localhost:3000) to make cross-origin requests
# to the FastAPI backend (localhost:8000) without 405 / preflight failures.
# ─────────────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    # In production replace "*" with your exact frontend origin,
    # e.g. ["https://bluefist.yourdomain.com"]
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],   # GET, POST, DELETE, OPTIONS (preflight), etc.
    allow_headers=["*"],   # Content-Type, Authorization, etc.
)

app.include_router(router)


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP / SHUTDOWN EVENTS (optional quality-of-life hooks)
# ─────────────────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup():
    print("🚀 BLUEFIST API online — CORS enabled, router mounted.")


@app.on_event("shutdown")
async def on_shutdown():
    print("🛑 BLUEFIST API shutting down.")