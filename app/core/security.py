"""Small, explicit access guard for the single-user prototype API."""

import hmac
import ipaddress

from fastapi import HTTPException, Request, WebSocket, status

from app.core.config import settings


def _authorized(token: str | None, client_host: str | None) -> bool:
    if settings.api_token:
        return bool(token) and hmac.compare_digest(token, settings.api_token)
    if settings.environment != "development" or not client_host:
        return False
    try:
        return ipaddress.ip_address(client_host).is_loopback
    except ValueError:
        return False


async def require_api_access(request: Request) -> None:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    if not _authorized(token, request.client.host if request.client else None):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Valid bearer token required")


async def require_websocket_access(websocket: WebSocket) -> bool:
    token = websocket.query_params.get("token")
    ok = _authorized(token, websocket.client.host if websocket.client else None)
    if not ok:
        await websocket.close(code=1008, reason="Unauthorized")
    return ok
