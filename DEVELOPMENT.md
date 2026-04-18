# GitEcho — Development Guide

This document describes how to run, configure, and test GitEcho on a developer machine without Docker. For production deployment, see [README.md](./README.md).

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | The Docker image uses `node:22-bookworm-slim`; match locally to keep `better-sqlite3` prebuilt binaries valid. |
| npm | ≥ 10 | Ships with Node 22. |
| `git` | any recent | Used at runtime to clone/pull repos. |
| GitHub CLI (`gh`) | ≥ 2.40 | Required only if you backup GitHub repos. Install via `brew install gh` or [cli.github.com](https://cli.github.com). |
| Azure CLI (`az`) with `azure-devops` extension | ≥ 2.50 | Required only if you backup Azure DevOps repos. Install with `brew install azure-cli` then `az extension add --name azure-devops`. |
| `openssl` | any | Used to generate `MASTER_KEY`. |

Optional but recommended:

- A throwaway GitHub fine-grained PAT with `repo:read` and `metadata:read` scopes.
- An Azure DevOps PAT with **Code (Read)** scope.
- A real or test SMTP account (e.g. Mailtrap, Mailpit) for SMTP tests.

## 2. First-time setup

```bash
git clone https://github.com/tobiaswittenburg/GitEcho.git
cd GitEcho
npm install
```

`npm install` will download the prebuilt `better-sqlite3` Node-v127 binary; no native toolchain needed.

Create local mount points (matching the container layout):

```bash
mkdir -p .dev/{config,data,backups}
```

Create `.env.local` (loaded automatically by Astro, ignored by git):

```bash
cat > .env.local <<'EOF'
# Optional: override the local defaults (.dev/data, .dev/config, .dev/backups)
DATA_DIR=./.dev/data
CONFIG_DIR=./.dev/config
BACKUPS_DIR=./.dev/backups

# Required to use the Settings UI for storing PAT / SMTP secrets.
# Generate with: openssl rand -hex 32
MASTER_KEY=

# Recommended: protect the dev UI with Basic Auth
UI_USER=dev
UI_PASS=dev

# Backup behavior
BACKUP_MODE=option1
CRON_SCHEDULE=0 2 * * *

# Optional: set provider PATs via env, or leave empty and add them through the UI
# GITHUB_PAT=ghp_xxx
# GITHUB_PAT_EXPIRES=2026-12-31
# AZUREDEVOPS_PAT=xxx
# AZUREDEVOPS_PAT_EXPIRES=2026-12-31
# AZUREDEVOPS_ORG=myorg
EOF

echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env.local
```

> **Note:** `MASTER_KEY` must be 32 bytes (64 hex chars or base64). If you lose it, every secret stored via the UI is unrecoverable.

Optionally pre-seed `.dev/config/repos.txt`:

```bash
cat > .dev/config/repos.txt <<'EOF'
# One URL per line; comments start with #
https://github.com/octocat/Hello-World
EOF
```

## 3. Running in development

GitEcho is **two processes**: the Astro web server (UI + APIs) and the background worker (cron scheduler). Run them in two terminals.

### Terminal 1 — web UI

```bash
npm run dev
```

Serves the UI at <http://localhost:4321> with HMR. The dev server reads `.env.local` automatically.

If you leave `DATA_DIR`, `CONFIG_DIR`, and `BACKUPS_DIR` unset, GitEcho defaults to `.dev/data`, `.dev/config`, and `.dev/backups` on local runs.

When `UI_USER`/`UI_PASS` are set, the browser prompts for Basic Auth on the first request.

### Terminal 2 — worker (scheduler)

```bash
npm run worker:dev
```

This runs `worker/index.ts` directly through `tsx` (no build step). The worker:

1. Calls `initDatabase()` against `DATA_DIR/gitecho.db`.
2. Registers all provider plugins.
3. Starts node-cron with `CRON_SCHEDULE`.

To skip the cron and run a backup once on boot, set the schedule to fire immediately, e.g.:

```bash
CRON_SCHEDULE='*/1 * * * *' npm run worker:dev   # every minute
```

…or simply use the **Settings → General → Run backup** button in the UI (the web process acquires the same file lock as the worker, so they coordinate safely).

### Production-style local run

```bash
npm run build
npm start         # serves the built UI on port 3000
npm run worker    # runs the built worker
```

## 4. Verifying it works

1. **Open the UI** at <http://localhost:4321> — you should see the Dashboard with empty stats.
2. **Settings landing** (`/settings`) shows two banners:
   - Red banner if `UI_USER`/`UI_PASS` are unset.
   - Yellow banner if `MASTER_KEY` is unset.
   Both should be absent if you followed step 2.
3. **Add a repo** at `/settings/repos` — confirm it appears in `.dev/config/repos.txt`.
4. **Add a PAT** at `/settings/providers` — confirm:
   - `.dev/config/secrets.json` is created with mode `0600` and contains `{iv,tag,ct}` blobs (not the plaintext PAT).
   - The expiration date appears in `.dev/config/settings.json`.
   - **Test connection** returns `✓ Authenticated…`.
5. **Test SMTP** at `/settings/smtp` — enter creds and click *Send test email*. If you don't have SMTP, leave it for later.
6. **Trigger backup** at `/settings/general` — click *Run backup*. Watch the worker terminal for `[Scheduler]` / `[backup]` log lines, then visit `/runs` and `/runs/<id>` to see the per-repository result, plus `.dev/backups/` to see cloned repos or ZIPs.
7. **Lock coordination** — while a backup is running, the *Run backup* button is disabled and `/api/backup/trigger` returns `409 A backup is already running.` `.dev/data/.backup.lock` exists during the run and is removed afterwards.

## 5. Static checks

```bash
npx astro check       # TypeScript + Astro template diagnostics
npm run build         # full production build (Astro + worker via esbuild)
```

There are currently **no automated tests**. The `check` + `build` combo is the canonical "did I break anything" gate before opening a PR.

## 6. Useful manual API checks

With Basic Auth enabled, pass `-u dev:dev`:

```bash
# List configured repos
curl -s -u dev:dev http://localhost:4321/api/repos | jq

# Add a repo
curl -s -u dev:dev -X POST http://localhost:4321/api/repos \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/octocat/Hello-World"}'

# Test GitHub PAT (uses stored token unless you provide one)
curl -s -u dev:dev -X POST http://localhost:4321/api/test/github -d '{}' \
  -H 'Content-Type: application/json'

# Inspect lock state
curl -s -u dev:dev http://localhost:4321/api/backup/trigger | jq

# Trigger a backup
curl -s -u dev:dev -X POST http://localhost:4321/api/backup/trigger
```

## 7. Resetting state

To start completely fresh:

```bash
rm -rf .dev/data .dev/backups
# Optionally also blow away config (deletes encrypted secrets!)
rm -rf .dev/config
```

Restart `npm run worker:dev` afterwards so the database is recreated.

## 8. Project layout

```
src/
  layouts/Layout.astro          AdminLTE 4 shell (sidebar + topbar + dark mode)
  middleware.ts                 Basic Auth + cheap CSRF
  components/                   reusable Astro components (Sidebar, Topbar,
                                  SmallBox, Card, Toasts)
  scripts/                      client-side TS bundled by Astro
    theme.ts                    dark-mode toggle (data-bs-theme + localStorage)
    sidebar.ts                  sidebar collapse + treeview
    toasts.ts                   Bootstrap toast helper (window.gitechoToast)
    format.ts                   shared formatters
  lib/
    config.ts                   layered loader (env < settings < secrets)
    secrets.ts                  AES-256-GCM helpers
    settings.ts                 settings.json + secrets.json read/write
    backup-lock.ts              cross-process file mutex
    database.ts                 SQLite schema + CRUD
    stats.ts                    extended dashboard stats + storage usage
    scheduler.ts                node-cron entry point
    backup/engine.ts            the actual backup runner
    plugins/
      register.ts, github.ts, azuredevops.ts, interface.ts
    repos-file.ts               repos.txt parser/writer
  pages/
    index.astro, repos.astro, runs.astro
    runs/[id].astro             per-run detail
    browse/[...path].astro      file browser (option1)
    zips/[...path].astro        ZIP archive list (option2/3)
    settings/                   settings UI pages
    api/                        JSON endpoints used by the UI
                                  (incl. /api/storage, /api/logout)
worker/index.ts                 worker process entry
build-worker.mjs                esbuild bundle for the worker
```

### UI / theme notes

The web UI is built on **AdminLTE 4** (Bootstrap 5) and a small set of
custom Astro components. Key conventions:

- **Bootstrap & AdminLTE assets** are imported in
  `src/layouts/Layout.astro` (`bootstrap/dist/css`, `admin-lte/dist/css`,
  `bootstrap-icons/font`, plus `bootstrap.bundle.min.js` in a `<script>`
  tag). Astro/Vite hashes and emits them under `dist/client/_astro/`, so
  no CDN is needed at runtime.
- **Dark mode** uses Bootstrap 5's `data-bs-theme` on `<html>`. The
  toggle in the topbar persists the choice in `localStorage` under
  `gitecho.theme`; first-visit defaults follow `prefers-color-scheme`.
- **Toasts**: client code calls `import { toast } from 'src/scripts/toasts.ts'`
  (or `window.gitechoToast(message, variant)`). Variants:
  `success | danger | warning | info`. The container lives in
  `src/components/Toasts.astro` and is rendered once per page by the
  Layout.
- **Adding a sidebar item**: edit `src/components/Sidebar.astro`. Each
  `Layout` page sets `active="..."` (and optionally `settingsActive="..."`)
  to highlight the current entry.
- **Adding a dashboard widget**: extend `src/lib/stats.ts` with the data
  you need, then drop a `<SmallBox>` or `<Card>` into the appropriate
  row in `src/pages/index.astro`. For client-side charts, lazy-load
  `chart.js/auto` inside a `<script>` block so it only loads on pages
  that need it.
- **Storage usage** (`/api/storage`) is cached for 5 min in-process to
  avoid repeated `du`-style walks of `/backups`. Use `?force=1` to
  recompute.
- **AdminLTE version**: pinned to a v4 release candidate
  (`admin-lte@4.0.0-rc7`). When bumping, sanity-check the sidebar and
  small-box markup since the RC line is still evolving.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `MASTER_KEY environment variable is required` from a Save button | `.env.local` missing `MASTER_KEY`; restart `npm run dev` after editing. |
| Browser keeps re-prompting for credentials | `UI_USER` / `UI_PASS` mismatch; use `localhost` not `127.0.0.1` to avoid stale cached creds. |
| Worker logs `Another process is already running a backup` | A previous run crashed and left `.dev/data/.backup.lock`; the lock self-heals once the recorded PID is no longer alive (uses `process.kill(pid, 0)`). Delete the file manually if needed. |
| `gh: command not found` on Test connection | Install GitHub CLI (`brew install gh`). The check exec's the `gh` binary directly. |
| Cron schedule changed but worker still uses the old one | Cron is bound at worker startup; restart `npm run worker:dev` after editing the schedule. |
| `better-sqlite3` build error | Use Node 22 (`nvm use 22`) so the prebuilt binary is selected; otherwise install `python3` + a C++ toolchain. |
