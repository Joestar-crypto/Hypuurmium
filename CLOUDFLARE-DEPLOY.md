# Cloudflare Deployment

This repo now supports a Cloudflare-friendly setup:

- Cloudflare Pages serves the static site from the repo root.
- `functions/api/[[path]].js` proxies `/api/*` to a real backend origin.
- The backend remains a Node service because it needs:
  - a private key (`AGENT_PRIVATE_KEY`)
  - persistent storage (`backend/autobuy.db`)
  - a long-running worker (`node-cron`)

## Recommended Architecture

1. Deploy the frontend on Cloudflare Pages.
2. Deploy the backend as a Node service on a backend host.
3. Set `BACKEND_ORIGIN` in Cloudflare Pages so `/api/*` on `hypurrmium.xyz` proxies to that backend.

## Backend Deployment

Deploy this repo as a Node service using the repo root.

- Start command: `npm start`
- Healthcheck path: `/api/health`

## Railway Backend Quick Start

If you already deployed the repo on Railway, do this next:

1. Open the Railway service for this repo.
2. Confirm the service starts from the repo root.
3. If Railway did not detect it automatically, set the start command to `node backend/server.js`.
4. Open the generated Railway domain and test `/api/health`.

Expected result:

- `https://your-service.up.railway.app/api/health` returns JSON.

Then configure persistence:

1. Add a Railway Volume.
2. Mount it at `/data`.
3. Add `DB_PATH=/data/autobuy.db` to Railway variables.

Safety hardening:

1. Add `REQUIRE_PERSISTENT_DB=true` to Railway variables.
2. Check `https://your-service.up.railway.app/api/health` and confirm `storage.dbPersistent` is `true`.
3. Confirm `storage.dataVolumeMounted` is `true`.
4. Configure automatic backups on the same persistent volume:
  - `DB_BACKUP_DIR=/data/backups`
  - `DB_BACKUP_INTERVAL_MINUTES=60`
  - `DB_BACKUP_MAX_FILES=168`
5. Use the admin backup endpoints occasionally:
  - `/api/admin/backups`
  - `/api/admin/backups/:name/download`
  - `/api/admin/export`
  - `/api/admin/db-download`

Then configure backend variables:

- `AGENT_PRIVATE_KEY=...`
- `CORS_ORIGINS=https://hypurrmium.xyz,https://www.hypurrmium.xyz`
- `DB_PATH=/data/autobuy.db`

Usually also needed:

- `RESEND_API_KEY=...`
- `EMAIL_FROM=Hypurrmium <noreply@hypurrmium.xyz>`
- `ADMIN_KEY=...`
- `BUILDER_ADDRESS=...`
- `BUILDER_APPROVAL_MAX_FEE_RATE=0.10%`
- `DISABLE_WORKER=false`
- `REQUIRE_PERSISTENT_DB=true`
- `DB_BACKUP_DIR=/data/backups`
- `DB_BACKUP_INTERVAL_MINUTES=60`
- `DB_BACKUP_MAX_FILES=168`

After saving the variables, redeploy the Railway service.

Final Railway verification:

1. Open `https://your-service.up.railway.app/`
2. Open `https://your-service.up.railway.app/api/health`
3. Open `https://your-service.up.railway.app/api/agent-address`

Expected results:

- `/` returns the site HTML
- `/api/health` returns JSON
- `/api/agent-address` returns JSON if `AGENT_PRIVATE_KEY` is set

Required backend environment variables:

- `AGENT_PRIVATE_KEY`
- `CORS_ORIGINS=https://hypurrmium.xyz,https://www.hypurrmium.xyz`

Usually also needed:

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `ADMIN_KEY`
- `BUILDER_ADDRESS`
- `BUILDER_APPROVAL_MAX_FEE_RATE`
- `DISABLE_WORKER=false`

Notes:

- The backend uses SQLite in `backend/autobuy.db`.
- Use a persistent disk/volume or set `DB_PATH` to persistent storage.
- If `/data` is mounted and `DB_PATH` is not set, the backend now auto-detects `/data/autobuy.db`.
- `REQUIRE_PERSISTENT_DB=true` makes the service fail on startup instead of silently using ephemeral storage.
- The backend now creates a pre-migration backup on startup and rolling DB snapshots after writes when backups are enabled.

## Cloudflare Pages Deployment

Use the repo root as the Pages project.

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `.`

Create this Pages environment variable:

- `BACKEND_ORIGIN=https://your-backend-host.example.com`

If your backend is on Railway, use:

- `BACKEND_ORIGIN=https://your-service.up.railway.app`

Important:

- `BACKEND_ORIGIN` should be the backend origin without `/api`.
- The Cloudflare function will forward `/api/*` to `${BACKEND_ORIGIN}/api/*`.

## What the Proxy Does

The file `functions/api/[[path]].js` makes these work on the main domain:

- `https://hypurrmium.xyz/api/agent-address`
- `https://hypurrmium.xyz/api/pe`
- `https://hypurrmium.xyz/api/strategies/...`
- `https://hypurrmium.xyz/api/defillama/fees`
- `https://hypurrmium.xyz/api/defillama/protocol`
- `https://hypurrmium.xyz/api/hl-info`
- `https://hypurrmium.xyz/api/hl-exchange`

Without changing the frontend.

## Verification

After deployment:

1. Open `https://hypurrmium.xyz/api/health`
2. It must return JSON, not HTML
3. Open `https://hypurrmium.xyz/api/defillama/fees`
4. It must return JSON, not HTML
3. Open the site and verify:
   - wallet balance loads
   - `Set Up Strategy` no longer shows `Backend not reachable`

## Failure Modes

- If `/api/health` returns HTML, Cloudflare Pages is not using the function route.
- If `/api/health` returns `BACKEND_ORIGIN is not configured`, set the Pages env var.
- If `/api/health` returns a 502, Cloudflare cannot reach your backend origin.