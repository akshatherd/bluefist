import ast
import asyncio
import json
import logging
import time
import httpx
from datetime import datetime
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

# Import your services
from app.services.github_service import get_repo, get_python_files
from app.services.gemini_service import generate_fix
from app.services.sandbox_service import run_isothermal_sandbox
from app.services.twilio_service import send_whatsapp, send_incident_notification

logger = logging.getLogger("bluefist")

router = APIRouter()

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


class RepoRequest(BaseModel):
    repo_url: str


class MonitorTarget(BaseModel):
    """A target that the background observer loop will watch."""
    target_id: str
    repo_url: str
    endpoint_url: str
    check_interval: int = 60


class ApprovalDecision(BaseModel):
    """Human-in-the-loop gate decision payload."""
    approval_id: str
    decision: str           # "approve" | "reject"
    reviewer_note: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# UTILITY HELPERS
# ─────────────────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.utcnow().isoformat() + "Z"


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
            await ws.send_text(json.dumps(message))
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
) -> tuple[bool, str]:
    """
    Closed-loop reflex engine: generate patch → validate in sandbox → retry.
    Accepts a real WebSocket or the _HeadlessWS adapter.
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
            fixed_code = generate_fix(
                original_code,
                "Runtime/Syntax Fault Detected",
                ast_context=ast_context,
                file_path=file_path,
                previous_attempts=previous_attempts,
            )
        except Exception as exc:
            logger.error(f"Gemini generate_fix failed: {exc}")
            await websocket.send_text(
                f"❌ [SYSTEM] Gemini Reasoning Agent error: {exc}\n"
            )
            break

        if not fixed_code:
            await websocket.send_text(
                "❌ [SYSTEM] AI Swarm failed to output code.\n"
            )
            break

        await websocket.send_text(
            "🧠 [DIAGNOSIS] Patch synthesized. Transferring to Sandbox...\n"
        )

        sandbox_error = ""

        try:
            async for log_line, is_done, is_success, err_out in run_isothermal_sandbox(
                fixed_code
            ):
                await websocket.send_text(log_line)
                if is_done:
                    success = is_success
                    sandbox_error = err_out
                    final_fixed_code = fixed_code
        except Exception as exc:
            logger.error(f"Sandbox execution failed: {exc}")
            await websocket.send_text(f"🚨 [SANDBOX ERROR] {exc}\n")
            sandbox_error = str(exc)
            success = False

        if not success:
            await websocket.send_text(
                "🚨 [FEEDBACK LOOP] Sandbox rejected patch. "
                "Feeding Traceback to Critic Agent...\n"
            )
            previous_attempts.append({"code": fixed_code, "error": sandbox_error})
            attempt += 1
            await asyncio.sleep(1)

    return success, final_fixed_code


def create_pull_request(repo, file, final_fixed_code: str):
    """
    Creates a feature branch, commits the verified patch, opens a PR.
    Returns the created PR object.
    """
    default_branch = repo.default_branch
    source = repo.get_branch(default_branch)
    branch = f"bluefist-fix-{int(time.time())}"

    repo.create_git_ref(ref=f"refs/heads/{branch}", sha=source.commit.sha)

    latest_file = repo.get_contents(file.path, ref=branch)
    repo.update_file(
        path=latest_file.path,
        message="BLUEFIST Autonomous Patch (Exit Code 0 Verified)",
        content=final_fixed_code,
        sha=latest_file.sha,
        branch=branch,
    )

    pr = repo.create_pull(
        title="⚡ BLUEFIST Auto-Fix Patch",
        body=(
            f"Automated resolution by BLUEFIST ARE.\n\n"
            f"📁 File: {file.path}\n"
            f"✅ Verified Exit Code 0 in Execution Sandbox."
        ),
        head=branch,
        base=default_branch,
    )
    return pr


def notify_completion(file_path: str, pr_url: str):
    """
    Sends completion notification via Twilio.
    Falls back to send_whatsapp() if the richer helper fails.
    """
    message = (
        f"✅ BLUEFIST Patch Verified & Deployed\n"
        f"📁 File: {file_path}\n"
        f"🔧 Status: Exit Code 0 Verified\n"
        f"🔗 PR: {pr_url}"
    )
    try:
        send_incident_notification(
            file_path=file_path,
            status="resolved",
            pr_url=pr_url,
            message=message,
        )
    except TypeError:
        try:
            send_incident_notification(message)
        except Exception as exc:
            logger.warning(f"send_incident_notification fallback failed: {exc}")
            send_whatsapp(message)
    except Exception as exc:
        logger.warning(
            f"send_incident_notification failed, falling back: {exc}"
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
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(endpoint_url)
            result["http_code"] = resp.status_code
            result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
            result["status"] = "healthy" if resp.status_code < 300 else "degraded"
    except httpx.TimeoutException:
        result["status"] = "timeout"
        result["error"] = "Request timed out after 10 s"
        result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
    except Exception as exc:
        result["status"] = "unreachable"
        result["error"] = str(exc)
        result["latency_ms"] = round((time.monotonic() - t_start) * 1000, 2)
    return result


async def _run_tdd_and_queue_approval(
    target_id: str, repo_url: str, ping_result: dict
):
    """
    Triggered on anomaly detection:
      1. Fetch repo & Python files.
      2. Run headless Gemini + Sandbox reflex loop.
      3. Queue patch as PENDING APPROVAL and broadcast to dashboard.
    """
    approval_id = f"appr-{target_id}-{int(time.time())}"
    logger.info(
        f"[MONITOR] Starting headless TDD loop for {target_id} ({approval_id})"
    )

    entry = _append_telemetry(
        "anomaly_detected",
        target_id,
        {"ping": ping_result, "approval_id": approval_id},
    )
    await _broadcast({"type": "anomaly", **entry})

    try:
        repo = get_repo(repo_url)
        files = get_python_files(repo)
    except Exception as exc:
        logger.error(f"[MONITOR] GitHub fetch failed for {target_id}: {exc}")
        err_entry = _append_telemetry(
            "monitor_error", target_id, {"error": str(exc)}
        )
        await _broadcast({"type": "monitor_error", **err_entry})
        return

    if not files:
        logger.warning(f"[MONITOR] No Python files in {repo_url}")
        return

    file = files[0]
    original_code = file.decoded_content.decode()
    ast_context = extract_ast(original_code)

    collected_logs: List[str] = []

    class _HeadlessWS:
        """Fake WebSocket that collects text lines into a list."""
        async def send_text(self, text: str):
            collected_logs.append(text)
            logger.debug(f"[HEADLESS-WS] {text.strip()}")

    fake_ws = _HeadlessWS()
    success, final_fixed_code = await run_reflex_loop(
        fake_ws,
        original_code,
        file.path,
        ast_context,
    )

    if not success:
        fatal_entry = _append_telemetry(
            "tdd_fatal",
            target_id,
            {
                "approval_id": approval_id,
                "logs": collected_logs[-20:],
                "message": "Max iterations reached. Human intervention required.",
            },
        )
        await _broadcast({"type": "tdd_fatal", **fatal_entry})
        return

    _pending_approvals[approval_id] = {
        "approval_id": approval_id,
        "target_id": target_id,
        "repo_url": repo_url,
        "file_path": file.path,
        "patch_code": final_fixed_code,
        "original_code": original_code,
        "ping_result": ping_result,
        "logs": collected_logs,
        "created_at": _now_iso(),
        "status": "pending",
        "_repo_obj": repo,
        "_file_obj": file,
    }

    approval_entry = _append_telemetry(
        "approval_queued",
        target_id,
        {
            "approval_id": approval_id,
            "file_path": file.path,
            "patch_preview": final_fixed_code[:400],
            "ping_result": ping_result,
        },
    )
    await _broadcast(
        {
            "type": "approval_required",
            **approval_entry,
            "full_patch": final_fixed_code,
            "original_code": original_code,
            "logs_tail": collected_logs[-30:],
        }
    )
    logger.info(
        f"[MONITOR] Approval queued: {approval_id} — waiting for human gate."
    )


async def _monitor_loop():
    """
    Main background observer loop.
    Pings each registered endpoint and triggers the TDD pipeline on anomaly.
    """
    logger.info("[MONITOR] Background observer loop started.")
    while True:
        if not _monitor_registry:
            await asyncio.sleep(5)
            continue

        for target_id, cfg in list(_monitor_registry.items()):
            # Skip if a patch is already pending for this target
            already_pending = any(
                v["target_id"] == target_id and v["status"] == "pending"
                for v in _pending_approvals.values()
            )
            if already_pending:
                logger.debug(
                    f"[MONITOR] Skipping {target_id} — approval already pending."
                )
                continue

            ping_result = await _ping_endpoint(target_id, cfg["endpoint_url"])

            hb_entry = _append_telemetry(
                "heartbeat", target_id, {"ping": ping_result}
            )
            await _broadcast({"type": "heartbeat", **hb_entry})

            if ping_result["status"] not in ("healthy",):
                logger.warning(
                    f"[MONITOR] Anomaly on {target_id}: {ping_result['status']}"
                )
                asyncio.create_task(
                    _run_tdd_and_queue_approval(
                        target_id, cfg["repo_url"], ping_result
                    )
                )

            await asyncio.sleep(cfg.get("check_interval", 60))


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
def get_telemetry(limit: int = 50):
    """Return the most recent telemetry events (newest-first)."""
    events = list(reversed(_telemetry_log))[:limit]
    return {"events": events, "total_stored": len(_telemetry_log)}


@router.get("/telemetry/summary")
def get_telemetry_summary():
    """Return a per-target health summary from the telemetry log."""
    summary: Dict[str, dict] = {}
    for entry in reversed(_telemetry_log):
        tid = entry.get("target")
        if tid and tid not in summary and entry.get("event") == "heartbeat":
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
    approve → deploy PR + Twilio alert
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
            pr = create_pull_request(
                appr["_repo_obj"],
                appr["_file_obj"],
                appr["patch_code"],
            )
        except Exception as exc:
            logger.error(f"[APPROVE] PR creation failed: {exc}")
            appr["status"] = "deploy_failed"
            err_entry = _append_telemetry(
                "deploy_failed",
                appr["target_id"],
                {"approval_id": decision.approval_id, "error": str(exc)},
            )
            await _broadcast({"type": "deploy_failed", **err_entry})
            raise HTTPException(
                status_code=500,
                detail=f"GitHub PR creation failed: {exc}",
            )

        appr["pr_url"] = pr.html_url
        appr["status"] = "deployed"

        try:
            notify_completion(appr["file_path"], pr.html_url)
        except Exception as exc:
            logger.warning(f"[APPROVE] Twilio notify failed: {exc}")

        done_entry = _append_telemetry(
            "deploy_complete",
            appr["target_id"],
            {
                "approval_id": decision.approval_id,
                "pr_url": pr.html_url,
                "reviewer_note": decision.reviewer_note,
            },
        )
        await _broadcast({"type": "deploy_complete", **done_entry})

        return {
            "status": "deployed",
            "approval_id": decision.approval_id,
            "pr_url": pr.html_url,
        }

    raise HTTPException(
        status_code=400,
        detail="decision must be 'approve' or 'reject'",
    )


# ─────────────────────────────────────────────────────────────────────────────
# WEBSOCKET ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────


@router.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    """
    Persistent WebSocket channel for the frontend dashboard.
    Receives all broadcast events in real time.
    """
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


@router.websocket("/ws/ghost-terminal")
async def ghost_terminal(websocket: WebSocket):
    """
    Original Ghost Terminal endpoint — manual repository trigger.
    Behaviour unchanged; emits telemetry events for the dashboard.
    """
    await websocket.accept()

    try:
        data = await websocket.receive_json()
        repo_url = data.get("repo_url")

        if not repo_url:
            await websocket.send_text(
                "❌ Error: No repository URL provided.\n"
            )
            return

        await websocket.send_text(
            f"🔍 [SYSTEM] Connecting to GitHub repository: {repo_url}...\n"
        )

        try:
            repo = get_repo(repo_url)
            files = get_python_files(repo)
        except Exception as exc:
            logger.error(f"GitHub fetch failed: {exc}")
            await websocket.send_text(f"❌ [SYSTEM] GitHub error: {exc}\n")
            return

        if not files:
            await websocket.send_text(
                "⚠️ [SYSTEM] No Python files found in repository.\n"
            )
            return

        file = files[0]
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
            "⚠️ [DETECTOR] Anomaly detected. "
            "Engaging Gemini Reasoning Agent...\n"
        )

        success, final_fixed_code = await run_reflex_loop(
            websocket, original_code, file.path, ast_context
        )

        if not success:
            await websocket.send_text(
                "\n💀 [FATAL] Max iterations reached. "
                "Human intervention required. Pipeline Halted.\n"
            )
            return

        await websocket.send_text(
            "\n🔗 [GIT ENGINE] Creating feature branch "
            "and applying verified patch...\n"
        )

        try:
            pr = create_pull_request(repo, file, final_fixed_code)
        except Exception as exc:
            logger.error(f"GitHub PR creation failed: {exc}")
            await websocket.send_text(f"❌ [GIT ENGINE ERROR] {exc}\n")
            return

        await websocket.send_text(
            f"✅ [SUCCESS] Pull Request established: {pr.html_url}\n"
        )
        await websocket.send_text(
            "📱 [NOTIFY] Sending Twilio WhatsApp update...\n"
        )

        try:
            notify_completion(file.path, pr.html_url)
        except Exception as exc:
            logger.error(f"Twilio notification failed: {exc}")
            await websocket.send_text(
                f"⚠️ [NOTIFY] Failed to send WhatsApp notification: {exc}\n"
            )

        await websocket.send_text(
            "🏁 [SYSTEM] Self-healing sequence complete.\n"
        )

        entry = _append_telemetry(
            "manual_fix_deployed",
            "ghost-terminal",
            {
                "repo_url": repo_url,
                "file": file.path,
                "pr_url": pr.html_url,
            },
        )
        await _broadcast({"type": "manual_fix_deployed", **entry})

    except WebSocketDisconnect:
        logger.info("UI disconnected from Ghost Terminal.")
    except Exception as exc:
        logger.error(f"Fatal error in ghost_terminal: {exc}")
        try:
            await websocket.send_text(f"❌ [FATAL ERROR] {str(exc)}\n")
        except Exception:
            pass