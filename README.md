# Bluefist

Bluefist is a single-operator prototype for turning a reviewer-supplied incident report into a scoped Python patch proposal. It loads one selected file from GitHub, asks Gemini for a complete-file edit, performs a syntax-only check in a network-isolated Docker container, and waits for a human decision before opening a pull request.

**It does not execute generated code, run the repository test suite, automatically repair an outage, or merge a pull request.** An HTTP health check reports availability only; it is not used to guess a code fix. Review and test every proposed change before merging.

## Local setup

Requirements: Python 3.11+, Node.js 20+, and Git. Docker Desktop is optional for local demo mode; production mode requires its Linux container engine.

1. Copy `.env.example` to `.env`. Set `GEMINI_API_KEY` to enable patch proposals. For public repositories, GitHub reads can work without a token; set `GITHUB_TOKEN` to avoid low anonymous API limits. The token needs repository contents read and pull request/contents write permissions only if you approve PR creation.
2. Install and start the backend in one terminal:

   ```powershell
   py -3.11 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install -r requirements-dev.txt
   python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --ws-max-size 65536
   ```

3. Install and start the dashboard in a second terminal:

   ```powershell
   cd bluefist-frontend
   npm ci
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000). The API docs are at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

With Docker running, the syntax check uses `python:3.12-alpine` with no network, a read-only root filesystem, dropped Linux capabilities, and resource limits. If Docker is stopped in local development, Bluefist falls back to a Python AST syntax parse; generated source is never executed in either mode. Production mode fails closed when Docker is unavailable.

## Demo flow

1. Enter a public or accessible GitHub repository URL and the exact `.py` file path.
2. Paste a relevant traceback or concise reproduction details. Remove secrets and personal data first; the source file and incident context are sent to the configured Gemini API.
3. Select **Prepare proposal**. Bluefist fetches that file, requests a patch, and checks syntax.
4. Inspect the original and proposed code in the approval dialog. Reject it or approve it to create a GitHub branch and pull request. Approval does not merge the PR.
5. Run the repository's own tests and review the full PR diff before merging.

## Secured deployment configuration

Set `BLUEFIST_ENV=production`, a strong `BLUEFIST_API_TOKEN`, `BLUEFIST_SANDBOX=docker`, and exact comma-separated `BLUEFIST_CORS_ORIGINS` values. The dashboard accepts the bearer token in the **API bearer token** field; it stays in memory for the open page and must be pasted again after a reload. Bind the API behind HTTPS and an authenticated reverse proxy. Never expose the development server directly to the public internet.

This prototype keeps targets, telemetry, and approvals in process memory. Restarting the backend clears them, and it is designed for one API worker. Durable storage, job queues, team accounts/RBAC, audit retention, rate limits, webhook verification, and multi-worker deployment are not implemented; do not use it as a production incident-response service yet.

## Checks

```powershell
python -m pytest
cd bluefist-frontend
npm run lint
npm run build
```

## API overview

- `GET /` — service status
- `POST /monitor/register`, `GET /monitor/targets`, `DELETE /monitor/{target_id}` — endpoint monitoring
- `GET /telemetry`, `GET /telemetry/summary` — recent health and anomaly events
- `GET /approvals/pending`, `POST /approvals/decide` — human review gate
- `/ws/dashboard`, `/ws/ghost-terminal` — live events and scoped proposal workflow

The local development mode permits loopback requests without a token. Production mode requires a bearer token on API requests and a token query parameter on WebSocket connections. Endpoint monitoring blocks private/reserved address resolutions and does not follow redirects.
