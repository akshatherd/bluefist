# Bluefist

Bluefist is a single-operator prototype for turning a reviewer-supplied incident report into a scoped Python patch proposal. It can monitor registered HTTP endpoints for availability anomalies. For code proposals, an operator selects a GitHub Python file and supplies the incident details; Bluefist loads that file, asks Gemini for a complete-file edit, performs a syntax-only check in a network-isolated Docker container, and waits for explicit human approval before committing the patch directly to the repository's default branch.

**Approval writes directly to the default branch.** Bluefist does not execute generated code, run the repository test suite, or automatically repair an outage. An HTTP health check reports availability only; it is not used to guess a code fix. Review every proposed diff carefully; run project tests before approving.

## Local setup

Requirements: Python 3.11+, Node.js 20+, and Git. Docker Desktop is optional for local demo mode; production mode requires its Linux container engine.

1. Copy `.env.example` to `.env`. Set `GEMINI_API_KEY` to enable patch proposals. Set `GITHUB_TOKEN` to a fine-grained token scoped to the target repository with **Contents: Read and write** so Bluefist can commit an approved patch. The token owner must have write access to that repository.
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

1. Enter a public or accessible GitHub repository URL and the exact `.py` file path. Bluefist does not scan the repository source or test suite to discover code bugs automatically.
2. Paste a relevant traceback or concise reproduction details. Remove secrets and personal data first; the source file and incident context are sent to the configured Gemini API.
3. Select **Prepare proposal**. Bluefist fetches that file, requests a patch, and checks syntax.
4. Inspect the original and proposed code in the approval dialog. Reject it or approve it to write a commit directly to the repository's default branch. The dialog closes on success and provides a link to the resulting commit. Verify that commit on GitHub and run the repository's own tests.

### Intentional demo bug

`demo/buggy_sample.py` intentionally returns one too many. To try the proposal flow, use the Bluefist repository URL, file path `demo/buggy_sample.py`, and incident details such as: `add_numbers(2, 3) returns 6; it should return 5. Remove the extra +1.` This demonstrates a reviewer-supplied issue. It is not automatic repository anomaly detection. The demo file must be present on the repository's default branch to load through the current UI; merge the branch that adds it first, or use another accessible repo with the same file.

## Secured deployment configuration

Set `BLUEFIST_ENV=production`, a strong `BLUEFIST_API_TOKEN`, `BLUEFIST_SANDBOX=docker`, and exact comma-separated `BLUEFIST_CORS_ORIGINS` values. The dashboard accepts the bearer token in the **API bearer token** field; it stays in memory for the open page and must be pasted again after a reload. Bind the API behind HTTPS and an authenticated reverse proxy. Never expose the development server directly to the public internet.

This prototype commits approved code changes directly to the default branch, so only use it with repositories where that behavior is intended. It keeps targets, telemetry, and approvals in process memory. Restarting the backend clears them, and it is designed for one API worker. Durable storage, job queues, team accounts/RBAC, audit retention, rate limits, webhook verification, and multi-worker deployment are not implemented; do not use it as a production incident-response service yet.

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
