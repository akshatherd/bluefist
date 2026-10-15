import ast
import asyncio
import json
import logging
import time
import ipaddress
import re
import socket
import uuid
from urllib.parse import urlsplit
import httpx
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, field_validator

# Import your services
from app.services.github_service import get_repo
from app.services.gemini_service import generate_fix
from app.services.sandbox_service import validate_patch_syntax
from app.services.twilio_service import send_whatsapp
from app.core.security import require_api_access, require_websocket_access

logger = logging.getLogger("bluefist")

router = APIRouter(dependencies=[Depends(require_api_access)])
websocket_router = APIRouter()

MAX_ATTEMPTS = 3

# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL STATE STORES
# ─────────────────────────────────────────────────────────────────────────────

# Tracks all active WebSocket dashboard connections for broadcasting
_dashboard_connections: Set[WebSocket] = set()

# Tracks live monitoring state per target (keyed by target_id)
_monitor_registry: Dict[str, dict] = {}

# Pending human-in-the-loop approvals queue
# Key: approval_id, Value: approval payload dict
_pending_approvals: Dict[str, dict] = {}

# Background monitor task handle
_monitor_task: Optional[asyncio.Task] = None

# Global telemetry accumulator
_telemetry_log: List[dict] = []

# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────────────────────────────────────────


class MonitorTarget(BaseModel):
    """A target that the background observer loop will watch."""
    target_id: str = Field(min_length=1, max_length=63)
    repo_url: str = Field(min_length=1, max_length=250)
    endpoint_url: str = Field(min_length=8, max_length=2048)
    check_interval: int = Field(default=60, ge=15, le=3600)

    @field_validator("target_id")
    @classmethod
    def validate_target_id(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}", value):
            raise ValueError("target_id must be a 1–63 character slug")
        return value

    @field_validator("repo_url")
    @classmethod
    def validate_repo_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.query or parsed.fragment:
            raise ValueError("repo_url must be an HTTPS github.com repository URL")
        if not re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?", parsed.path):
            raise ValueError("repo_url must identify one owner and repository")
        return value.rstrip("/")

    @field_validator("endpoint_url")
    @classmethod
    def validate_endpoint_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("endpoint_url must be an HTTP(S) URL without embedded credentials")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("endpoint_url contains an invalid port") from exc
        if parsed.hostname.lower() in {"localhost", "localhost.localdomain"} or parsed.hostname.lower().endswith((".local", ".internal")):
            raise ValueError("local and internal endpoints cannot be monitored")
        try:
            address = ipaddress.ip_address(parsed.hostname)
            if not address.is_global:
                raise ValueError("private and reserved IP addresses cannot be monitored")
        except ValueError as exc:
            if "private and reserved" in str(exc):
                raise
        return value


class ApprovalDecision(BaseModel):
    """Human-in-the-loop gate decision payload."""
    approval_id: str = Field(min_length=1, max_length=64)
    decision: str
    reviewer_note: str = Field(default="", max_length=1000)

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, value: str) -> str:
        if value not in {"approve", "reject"}:
            raise ValueError("decision must be 'approve' or 'reject'")
        return value


# ─────────────────────────────────────────────────────────────────────────────
# UTILITY HELPERS
# ─────────────────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _append_telemetry(event_type: str, target_id: str, payload: dict) -> dict:
    """
    Append a structured telemetry event to the global log.
    Keeps only the last 500 events to avoid unbounded memory growth.
    """
    entry = {
        "ts": _now_iso(),
        "event": event_type,
        "target": target_id,
        **payload,
    }
    _telemetry_log.append(entry)
    if len(_telemetry_log) > 500:
        _telemetry_log.pop(0)
    return entry


async def _broadcast(message: dict):
    """
    Fan-out a JSON message to every connected dashboard WebSocket client.
    Silently removes stale connections.
    """
    stale: Set[WebSocket] = set()
    for ws in list(_dashboard_connections):
        try:
            await asyncio.wait_for(ws.send_text(json.dumps(message)), timeout=5)
        except Exception:
            stale.add(ws)
    _dashboard_connections.difference_update(stale)


def extract_ast(source_code: str) -> Optional[str]:
    """
    Attempt to parse source into an AST and return a dumped string
    representation for Gemini context.
    Returns None and logs a warning if parsing fails.
    """
    try:
        tree = ast.parse(source_code)
        return ast.dump(tree, indent=2)
    except SyntaxError as exc:
        logger.warning(f"AST extraction failed (SyntaxError): {exc}")
        return None
    except Exception as exc:
        logger.warning(f"AST extraction failed: {exc}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# CORE ENGINE HELPERS
# ─────────────────────────────────────────────────────────────────────────────


async def run_reflex_loop(
    websocket,
    original_code: str,
    file_path: str,
    ast_context: Optional[str],
    error_context: str,
) -> tuple[bool, str]:
    """
    Generate a complete-file patch, run a Docker syntax check, and retry if needed.
    Returns (success, final_fixed_code).
    """
    attempt = 1
    success = False
    previous_attempts: List[dict] = []
    final_fixed_code = ""

    while attempt <= MAX_ATTEMPTS and not success:
        await websocket.send_text(
            f"\n🔄 [ITERATION {attempt}/{MAX_ATTEMPTS}] Synthesizing patch...\n"
        )

        try:
            fixed_code = await asyncio.to_thread(
                generate_fix,
                original_code,
                error_context,
                ast_context,
                file_path,
                previous_attempts,
            )
        except Exception as exc:
            logger.error("Gemini proposal generation failed: %s", exc)
            await websocket.send_text(
                f"❌ [SYSTEM] Gemini Reasoning Agent error: {exc}\n"
            )
            break

        if not fixed_code:
            await websocket.send_text(
                "❌ [SYSTEM] Model returned an empty patch proposal.\n"
            )
            break

        await websocket.send_text(
                "🧠 [PROPOSAL] Patch synthesized. Starting syntax-only validation...\n"
        )

        validation_error = ""

        try:
            async for log_line, is_done, is_success, err_out in validate_patch_syntax(
                fixed_code
            ):
                await websocket.send_text(log_line)
                if is_done:
                    success = is_success
                    validation_error = err_out
                    final_fixed_code = fixed_code
        except Exception as exc:
            logger.error("Syntax validation failed: %s", exc)
            await websocket.send_text(f"🚨 [VALIDATION ERROR] {exc}\n")
            validation_error = str(exc)
            success = False

        if not success:
            await websocket.send_text(
                "🚨 [FEEDBACK LOOP] Syntax check failed. Retrying with validator output...\n"
            )
            previous_attempts.append({"code": fixed_code, "error": validation_error})
            attempt += 1
            await asyncio.sleep(1)

    return success, final_fixed_code


def apply_approved_patch(repo, file, final_fixed_code: str):
    """Commit the human-approved patch directly to the repository default branch."""
    branch = repo.default_branch
    latest_file = repo.get_contents(file.path, ref=branch)
    if latest_file.sha != file.sha:
        raise RuntimeError(
            "The target file changed after this proposal was created. Generate and review a fresh proposal."
        )

    result = repo.update_file(
        path=latest_file.path,
        message="bluefist: apply human-approved incident fix",
        content=final_fixed_code,
        sha=latest_file.sha,
        branch=branch,
    )
    return result["commit"]


def notify_completion(file_path: str, commit_url: str):
    """Send an optional notification after an approved patch is committed."""
    message = (
        f"✅ BLUEFIST Patch Applied to Default Branch\n"
        f"📁 File: {file_path}\n"
        f"🔧 Status: Human-approved commit created\n"
        f"🔗 Commit: {commit_url}"
    )
    send_whatsapp(message)


# ─────────────────────────────────────────────────────────────────────────────
# LIVE MONITORING BACKGROUND LOOP
# ─────────────────────────────────────────────────────────────────────────────


async def _ping_endpoint(target_id: str, endpoint_url: str) -> dict:
    """
    HTTP GET health-check against the target endpoint.
    Returns a structured result dict.
    """
    result: dict = {
        "target_id": target_id,
        "endpoint": endpoint_url,
        "status": "unknown",
        "http_code": None,
        "latency_ms": None,
        "error": None,
    }
    t_start = time.monotonic()
    try:
        hostname = urlsplit(endpoint_url).hostname or ""
        addresses = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, hostname, None, 0, socket.SOCK_STREAM),
            timeout=2,
        )
        resolved = {ipaddress.ip_address(item[4][0]) for item in addresses}
        if not resolved or any(not ip.is_global for ip in resolved):
            raise ValueError("Endpoint resolves to a private or reserved address")
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0), follow_redirects=False) as client:
            resp = await client.get(endpoint_url)
            result["http_code"] = resp.status_code
            result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
            result["status"] = "healthy" if resp.status_code < 300 else "degraded"
    except httpx.TimeoutException:
        result["status"] = "timeout"
        result["error"] = "Request timed out after 8 s"
        result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
    except Exception as exc:
        result["status"] = "unreachable"
        result["error"] = str(exc)
        result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
    return result


async def _monitor_loop():
    """Poll registered endpoints on their own intervals; never infer code fixes from uptime alone."""
    logger.info("[MONITOR] Background observer loop started.")
    last_checked: Dict[str, float] = {}
    while True:
        now = time.monotonic()
        due = [
            (target_id, cfg)
            for target_id, cfg in list(_monitor_registry.items())
            if now - last_checked.get(target_id, 0) >= cfg.get("check_interval", 60)
        ]
        async def check(target_id: str, cfg: dict) -> None:
            ping_result = await _ping_endpoint(target_id, cfg["endpoint_url"])
            entry_type = "heartbeat" if ping_result["status"] == "healthy" else "anomaly"
            event = _append_telemetry(entry_type, target_id, {"ping": ping_result})
            await _broadcast({"type": entry_type, **event})
        for target_id, _ in due:
            last_checked[target_id] = now
        if due:
            await asyncio.gather(*(check(target_id, cfg) for target_id, cfg in due))
        for target_id in list(last_checked):
            if target_id not in _monitor_registry:
                del last_checked[target_id]
        await asyncio.sleep(1 if _monitor_registry else 5)


# ─────────────────────────────────────────────────────────────────────────────
# REST ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/")
def home():
    return {
        "message": "BLUEFIST Autonomous Engine Online — Live Monitor Active"
    }


# ── Monitor registry ──────────────────────────────────────────────────────────


@router.post("/monitor/register")
async def register_monitor_target(target: MonitorTarget):
    """
    Register a new live endpoint + repository for continuous observation.
    Auto-starts the background monitor loop on first registration.

    This endpoint explicitly handles the OPTIONS preflight via FastAPI's
    CORS middleware (configured in main.py) so no manual OPTIONS handler
    is needed here.
    """
    global _monitor_task

    if target.target_id not in _monitor_registry and len(_monitor_registry) >= 50:
        raise HTTPException(status_code=409, detail="Prototype monitor limit reached (50 targets)")

    _monitor_registry[target.target_id] = target.model_dump()
    logger.info(f"[MONITOR] Registered target: {target.target_id}")

    # Lazily start the background loop on first registration
    if _monitor_task is None or _monitor_task.done():
        _monitor_task = asyncio.create_task(_monitor_loop())
        logger.info("[MONITOR] Observer loop task created.")

    return {
        "status": "registered",
        "target_id": target.target_id,
        "repo_url": target.repo_url,
        "endpoint_url": target.endpoint_url,
        "check_interval": target.check_interval,
        "registered_at": _now_iso(),
    }


@router.delete("/monitor/{target_id}")
async def deregister_monitor_target(target_id: str):
    """Remove a target from the live observation registry."""
    if target_id not in _monitor_registry:
        raise HTTPException(status_code=404, detail="Target not found")
    del _monitor_registry[target_id]
    logger.info(f"[MONITOR] Deregistered target: {target_id}")
    return {"status": "deregistered", "target_id": target_id}


@router.get("/monitor/targets")
def list_monitor_targets():
    """Return the current registry of monitored targets (strips internal keys)."""
    safe = {
        tid: {k: v for k, v in cfg.items() if not k.startswith("_")}
        for tid, cfg in _monitor_registry.items()
    }
    return {"targets": safe, "count": len(safe)}


# ── Telemetry ─────────────────────────────────────────────────────────────────


@router.get("/telemetry")
def get_telemetry(limit: int = Query(default=50, ge=1, le=500)):
    """Return the most recent telemetry events (newest-first)."""
    events = list(reversed(_telemetry_log))[:limit]
    return {"events": events, "total_stored": len(_telemetry_log)}


@router.get("/telemetry/summary")
def get_telemetry_summary():
    """Return a per-target health summary from the telemetry log."""
    summary: Dict[str, dict] = {}
    for entry in reversed(_telemetry_log):
        tid = entry.get("target")
        if tid and tid not in summary and entry.get("event") in {"heartbeat", "anomaly"}:
            ping = entry.get("ping", {})
            summary[tid] = {
                "target_id": tid,
                "last_seen": entry["ts"],
                "status": ping.get("status", "unknown"),
                "latency_ms": ping.get("latency_ms"),
                "http_code": ping.get("http_code"),
            }
    return {"summary": summary}


# ── Human-in-the-loop approval gate ──────────────────────────────────────────


@router.get("/approvals/pending")
def list_pending_approvals():
    """Return all patch approvals currently awaiting human decision."""
    safe = [
        {k: v for k, v in appr.items() if not k.startswith("_")}
        for appr in _pending_approvals.values()
        if appr["status"] == "pending"
    ]
    return {"pending": safe, "count": len(safe)}


@router.post("/approvals/decide")
async def decide_approval(decision: ApprovalDecision):
    """
    Human-in-the-loop gate.
    approve → commit the reviewed patch to the default branch + optional Twilio alert
    reject  → discard patch
    """
    appr = _pending_approvals.get(decision.approval_id)
    if not appr:
        raise HTTPException(status_code=404, detail="Approval ID not found")
    if appr["status"] != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Approval already {appr['status']}",
        )

    if decision.decision == "reject":
        appr["status"] = "rejected"
        appr["decided_at"] = _now_iso()
        appr["reviewer_note"] = decision.reviewer_note

        rej_entry = _append_telemetry(
            "approval_rejected",
            appr["target_id"],
            {
                "approval_id": decision.approval_id,
                "reviewer_note": decision.reviewer_note,
            },
        )
        await _broadcast({"type": "approval_rejected", **rej_entry})
        return {"status": "rejected", "approval_id": decision.approval_id}

    if decision.decision == "approve":
        appr["status"] = "deploying"
        appr["decided_at"] = _now_iso()
        appr["reviewer_note"] = decision.reviewer_note

        dep_start = _append_telemetry(
            "deploy_started",
            appr["target_id"],
            {"approval_id": decision.approval_id},
        )
        await _broadcast({"type": "deploy_started", **dep_start})

        try:
            commit = await asyncio.to_thread(apply_approved_patch,
                appr["_repo_obj"],
                appr["_file_obj"],
                appr["patch_code"],
            )
        except Exception as exc:
            logger.error(f"[APPROVE] Patch application failed: {exc}")
            appr["status"] = "deploy_failed"
            err_entry = _append_telemetry(
                "deploy_failed",
                appr["target_id"],
                {"approval_id": decision.approval_id, "error": str(exc)},
            )
            await _broadcast({"type": "deploy_failed", **err_entry})
            raise HTTPException(
                status_code=500,
                detail=f"GitHub patch application failed: {exc}",
            )

        appr["commit_url"] = commit.html_url
        appr["commit_sha"] = commit.sha
        appr["status"] = "applied"

        try:
            await asyncio.to_thread(notify_completion, appr["file_path"], commit.html_url)
        except Exception as exc:
            logger.warning(f"[APPROVE] Twilio notify failed: {exc}")

        done_entry = _append_telemetry(
            "deploy_complete",
            appr["target_id"],
            {
                "approval_id": decision.approval_id,
                "commit_url": commit.html_url,
                "commit_sha": commit.sha,
                "reviewer_note": decision.reviewer_note,
            },
        )
        await _broadcast({"type": "deploy_complete", **done_entry})

        return {
            "status": "applied",
            "approval_id": decision.approval_id,
            "commit_url": commit.html_url,
            "commit_sha": commit.sha,
        }

    raise HTTPException(
        status_code=400,
        detail="decision must be 'approve' or 'reject'",
    )


# ─────────────────────────────────────────────────────────────────────────────
# WEBSOCKET ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────


@websocket_router.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    """
    Persistent WebSocket channel for the frontend dashboard.
    Receives all broadcast events in real time.
    """
    if not await require_websocket_access(websocket):
        return
    await websocket.accept()
    _dashboard_connections.add(websocket)
    logger.info(
        f"[DASHBOARD-WS] Client connected. "
        f"Total: {len(_dashboard_connections)}"
    )

    # Send current state snapshot on connect
    pending_safe = [
        {k: v for k, v in appr.items() if not k.startswith("_")}
        for appr in _pending_approvals.values()
        if appr["status"] == "pending"
    ]
    try:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "state_snapshot",
                    "ts": _now_iso(),
                    "pending_approvals": pending_safe,
                    "monitored_targets": list(_monitor_registry.keys()),
                    "recent_telemetry": list(reversed(_telemetry_log))[:20],
                }
            )
        )
    except Exception:
        pass

    try:
        while True:
            try:
                msg = await asyncio.wait_for(
                    websocket.receive_text(), timeout=30
                )
                if msg == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except asyncio.TimeoutError:
                await websocket.send_text(
                    json.dumps({"type": "keepalive"})
                )
    except WebSocketDisconnect:
        logger.info("[DASHBOARD-WS] Client disconnected.")
    except Exception as exc:
        logger.warning(f"[DASHBOARD-WS] Unexpected error: {exc}")
    finally:
        _dashboard_connections.discard(websocket)


@websocket_router.websocket("/ws/ghost-terminal")
async def ghost_terminal(websocket: WebSocket):
    """
    Create a scoped, syntax-checked proposal from reviewer-provided incident context.
    """
    if not await require_websocket_access(websocket):
        return
    await websocket.accept()

    try:
        data = await websocket.receive_json()
        repo_url = str(data.get("repo_url", "")).strip()
        file_path = str(data.get("file_path", "")).strip()
        error_context = str(data.get("error_trace", "")).strip()
        if not repo_url or not file_path or not error_context:
            await websocket.send_text(
                "❌ Provide a GitHub repository, exact Python file path, and incident details or traceback.\n"
            )
            return
        if (len(error_context) > 20000 or len(file_path) > 500
                or not file_path.endswith(".py") or ".." in file_path.split("/")):
            await websocket.send_text("❌ Incident context must be at most 20,000 characters and the target must be a Python file.\n")
            return

        await websocket.send_text(
            f"🔍 [SYSTEM] Connecting to GitHub repository: {repo_url}...\n"
        )

        try:
            repo = await asyncio.to_thread(get_repo, repo_url)
            file = await asyncio.to_thread(repo.get_contents, file_path)
            if file.type != "file" or not file.path.endswith(".py"):
                raise ValueError("Target must be an existing Python file")
            if len(file.decoded_content) > 500_000:
                raise ValueError("Target Python file is larger than the 500 KB proposal limit")
        except Exception as exc:
            logger.warning("GitHub file fetch failed: %s", exc)
            await websocket.send_text("❌ [SYSTEM] Could not load that file. Check the repository URL, file path, and GitHub token permissions.\n")
            return

        original_code = file.decoded_content.decode()
        await websocket.send_text(
            f"📂 [PARSER] Extracted Abstract Syntax Tree from: {file.path}\n"
        )

        ast_context = extract_ast(original_code)
        if ast_context is None:
            await websocket.send_text(
                "⚠️ [PARSER] AST extraction failed, "
                "continuing without AST context.\n"
            )

        await asyncio.sleep(0.5)
        await websocket.send_text(
            "📝 [CONTEXT] Reviewer-provided incident details captured. "
            "Engaging Gemini Reasoning Agent...\n"
        )

        validation_logs: List[str] = []

        class _RecordingWebSocket:
            async def send_text(self, text: str):
                validation_logs.append(text)
                await websocket.send_text(text)

        success, final_fixed_code = await run_reflex_loop(
            _RecordingWebSocket(), original_code, file.path, ast_context, error_context
        )

        if not success:
            await websocket.send_text(
                "\n💀 [FATAL] Max iterations reached. "
                "Human intervention required. Pipeline Halted.\n"
            )
            return

        approval_id = f"appr-{uuid.uuid4().hex[:12]}"
        logs = ["Incident context supplied by reviewer.", *validation_logs[-20:]]
        _pending_approvals[approval_id] = {
            "approval_id": approval_id,
            "target_id": repo.full_name,
            "repo_url": repo_url,
            "file_path": file.path,
            "patch_code": final_fixed_code,
            "original_code": original_code,
            "ping_result": {"status": "reviewer_reported"},
            "logs": logs,
            "created_at": _now_iso(),
            "status": "pending",
            "_repo_obj": repo,
            "_file_obj": file,
        }
        entry = _append_telemetry("approval_queued", repo.full_name, {
            "approval_id": approval_id,
            "file_path": file.path,
            "patch_preview": final_fixed_code[:400],
        })
        await websocket.send_text("🔐 [REVIEW REQUIRED] Proposal queued. No PR was opened; review and approve it in the dashboard.\n")
        await _broadcast({
            "type": "approval_required", **entry, "repo_url": repo_url,
            "full_patch": final_fixed_code, "original_code": original_code,
            "logs_tail": logs,
        })

    except WebSocketDisconnect:
        logger.info("UI disconnected from Ghost Terminal.")
    except Exception as exc:
        logger.error(f"Fatal error in ghost_terminal: {exc}")
        try:
            await websocket.send_text(f"❌ [FATAL ERROR] {str(exc)}\n")
        except Exception:
            pass
