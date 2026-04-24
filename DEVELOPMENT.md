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
| GitLab CLI (`glab`) | ≥ 1.40 | Optional — only used for the `glab auth status` boot probe inside the container and for ad-hoc debugging. Discovery goes through the REST API directly, so you can skip installing `glab` locally if you only run the Astro dev server. Install via `brew install glab` or from <https://gitlab.com/gitlab-org/cli>. |
| `openssl` | any | Used to generate `MASTER_KEY`. |

Optional but recommended:

- A throwaway GitHub fine-grained PAT with `repo:read` and `metadata:read` scopes.
- An Azure DevOps PAT with **Code (Read)** scope.
- A GitLab PAT with `read_api` and `read_repository` scopes.
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

# Required — encrypts the admin password hash, PATs and SMTP secrets.
# GitEcho refuses to start without it. Generate with: openssl rand -hex 32
MASTER_KEY=

# Backup behavior
BACKUP_MODE=option1
CRON_SCHEDULE=0 2 * * *

# Optional: set provider PATs via env, or leave empty and add them through the UI
# GITHUB_PAT=ghp_xxx
# GITHUB_PAT_EXPIRES=2026-12-31
# AZUREDEVOPS_PAT=xxx
# AZUREDEVOPS_PAT_EXPIRES=2026-12-31
# AZUREDEVOPS_ORG=myorg
# GITLAB_PAT=glpat-xxx
# GITLAB_PAT_EXPIRES=2026-12-31
# GITLAB_HOST=gitlab.example.com   # only for self-hosted
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

Serves the UI at <http://localhost:3000> with HMR. The dev server reads `.env.local` automatically.

If you leave `DATA_DIR`, `CONFIG_DIR`, and `BACKUPS_DIR` unset, GitEcho defaults to `.dev/data`, `.dev/config`, and `.dev/backups` on local runs.

On first boot GitEcho bootstraps an `admin` / `admin` account and forces a
password change through `/login` → `/settings/account`. The new password is
stored (bcrypt-hashed) in `.dev/config/secrets.json`. To reset during
development, just delete that file and reload — admin/admin is seeded
again.

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

1. **Open the UI** at <http://localhost:3000> — you should see the Dashboard with empty stats.
2. **Settings landing** (`/settings`) shows a yellow banner if you are still
   signed in as the default `admin` / `admin` — following the banner link
   opens the change-password page. A second yellow banner warns when
   `MASTER_KEY` is unset (in dev; in a container, startup would have
   aborted).
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

Obtain a session cookie first, then reuse it on subsequent requests:

```bash
# 1. Sign in and save the Set-Cookie value into cookies.txt
curl -s -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'

# 2. Reuse the cookie jar for any subsequent API call
curl -s -b cookies.txt http://localhost:3000/api/repos | jq

# Add a repo
curl -s -b cookies.txt -X POST http://localhost:3000/api/repos \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -d '{"url":"https://github.com/octocat/Hello-World"}'

# Test GitHub PAT (uses stored token unless you provide one)
curl -s -b cookies.txt -X POST http://localhost:3000/api/test/github -d '{}' \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000'

# Test GitLab PAT (uses stored token + host unless you provide them)
curl -s -u dev:dev -X POST http://localhost:3000/api/test/gitlab -d '{}' \
  -H 'Content-Type: application/json'

# Inspect lock state
curl -s -u dev:dev http://localhost:3000/api/backup/trigger | jq

# Trigger a backup
curl -s -u dev:dev -X POST http://localhost:3000/api/backup/trigger
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
  middleware.ts                 Session-cookie auth + Origin-based CSRF
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
    logger.ts                   structured JSONL logger (stdout + DATA_DIR/gitecho.log,
                                  size-based rotation, secret redaction)
    backup/engine.ts            the actual backup runner
    plugins/
      register.ts, github.ts, azuredevops.ts, gitlab.ts, interface.ts
    repos-file.ts               repos.txt parser/writer
  pages/
    index.astro, repos.astro, runs.astro, logs.astro
    runs/[id].astro             per-run detail
    browse/[...path].astro      file browser (option1)
    zips/[...path].astro        ZIP archive list (option2/3)
    settings/                   settings UI pages
    api/                        JSON endpoints used by the UI
                                  (incl. /api/storage, /api/logout,
                                  /api/logs, /api/logs/download)
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

## 9. Database schema migrations

GitEcho ships its schema **inside the Docker image** and reconciles it on
every container start, so updating to a newer image is a single
`docker compose up -d` away — no separate migration step.

### What runs at startup

`initDatabase()` in `src/lib/database.ts` is called by both the worker and
the web server on boot, and performs three steps in order:

1. **`SCHEMA`** — `CREATE TABLE IF NOT EXISTS …` for every table. Fresh
   installs land here with the current shape.
2. **Legacy idempotent helpers** — calls like
   `migrateAddColumnIfMissing(instance, 'backup_runs', 'repos_unavailable', …)`.
   These pre-date the versioned runner and remain in place so installs
   that existed before the runner self-heal automatically.
3. **`runMigrations()`** — applies every entry of the append-only
   `MIGRATIONS` array whose index is `>= PRAGMA user_version`, each inside
   a transaction that also bumps `user_version` by exactly one.

The SQLite file lives on the `/data` volume and survives image upgrades,
so steps 1–3 run against your existing data on every container start.

### Adding a migration

Append a single function to `MIGRATIONS` in `src/lib/database.ts`:

```ts
const MIGRATIONS: ReadonlyArray<(instance: DatabaseInstance) => void> = [
  // v0 → v1
  (instance) => instance.exec(`CREATE INDEX idx_items_run ON backup_items(run_id)`),
  // v1 → v2
  (instance) => instance.exec(`ALTER TABLE repositories ADD COLUMN labels TEXT`),
];
```

Rules — these are load-bearing, please follow them:

- **Append-only.** Never edit, reorder, or delete a migration that has
  shipped. The index of each entry *is* its version number.
- **Don't duplicate** what `SCHEMA` or the legacy helpers already do.
  Both fresh installs (after `SCHEMA`) and pre-versioning installs (after
  the legacy helpers) start at `user_version = 0`, so a new migration
  runs against the same starting shape on both. Encode only the *new*
  change.
- **One concern per migration.** The transaction wrapping that
  `runMigrations` adds rolls back the whole step on failure; keep it
  small enough that a rollback is meaningful.
- Update `SCHEMA` in the same PR so fresh installs get the new shape
  directly without going through the migration.

### Destructive changes

SQLite can't `DROP COLUMN` portably and can't change a column's type. Use
the standard 4-step recipe inside one migration:

```ts
(instance) => instance.exec(`
  CREATE TABLE backup_items_new (...new shape...);
  INSERT INTO backup_items_new (col1, col2, ...) SELECT col1, col2, ... FROM backup_items;
  DROP TABLE backup_items;
  ALTER TABLE backup_items_new RENAME TO backup_items;
`);
```

The `runMigrations` transaction makes this atomic. Re-create any indexes
on the new table inside the same migration.

### Rollback safety

When you make a schema change, try to keep the application code tolerant
of the previous shape (e.g. read with `COALESCE`, treat new columns as
nullable on read paths) for one release. That way rolling back to the
previous image tag still boots cleanly against the migrated DB.

### Pre-startup database snapshot

`entrypoint.sh` snapshots `/data/gitecho.db` to
`/data/gitecho.db.bak.<timestamp>` on every container start (best-effort,
keeps the last 5). If a deployment ever leaves the DB in a bad state, the
recovery is:

```bash
docker compose down
# Inside the data volume, restore the most recent good snapshot:
cp /data/gitecho.db.bak.<timestamp> /data/gitecho.db
# Re-pin compose to the previous image tag, then:
docker compose up -d
```

### Production upgrade checklist

- **Pin image tags** (e.g. `gitecho:1.4.2`, never `:latest`) so upgrades
  and rollbacks are deliberate.
- Take a manual backup of the `/data` volume before major upgrades — the
  built-in snapshot is a safety net, not a substitute for off-host
  backups.
- Watch the worker/server logs for `[db] migrating vN → vN+1` lines on
  the first boot of a new image; absence of such lines means no
  migration ran.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `MASTER_KEY environment variable is required` from a Save button | `.env.local` missing `MASTER_KEY`; restart `npm run dev` after editing. |
| Login redirects back to `/login` with `error=invalid` | Wrong username / password. Default bootstrap is `admin` / `admin`. To reset, stop the dev server and delete `.dev/config/secrets.json`. |
| "Password change required" blocks everything | Expected \u2014 finish the forced first-login change at `/settings/account`. |
| Worker logs `Another process is already running a backup` | A previous run crashed and left `.dev/data/.backup.lock`; the lock self-heals once the recorded PID is no longer alive (uses `process.kill(pid, 0)`). Delete the file manually if needed. |
| `gh: command not found` on Test connection | Install GitHub CLI (`brew install gh`). The check exec's the `gh` binary directly. |
| `glab: command not found` inside the container / during `glab auth status` | The Dockerfile installs `glab` via the official tarball release; rebuild the image after pulling changes. Locally the Astro server uses the REST API directly, so `glab` is optional for development. |
| Cron schedule changed but worker still uses the old one | Cron is bound at worker startup; restart `npm run worker:dev` after editing the schedule. |
| `better-sqlite3` build error | Use Node 22 (`nvm use 22`) so the prebuilt binary is selected; otherwise install `python3` + a C++ toolchain. |
| One repo fails to clone (`curl 56`, `early EOF`, `HTTP/2 CANCEL`) while others succeed | Enable **Verbose git trace (debug)** on `/settings/repos/<id>`, trigger a backup, then download the captured log from the **Debug traces** card. The log under `/data/debug-logs/repo-<id>/` contains full `GIT_TRACE` / `GIT_CURL_VERBOSE` / `GIT_TRACE_PACKET` output. Typical root causes: Docker bridge MTU on the host (try `com.docker.network.driver.mtu: 1400`), ISP/DPI resetting long single flows, container OOM during `index-pack` on large repos, or Azure DevOps `dev.azure.com` vs `*.visualstudio.com` routing. Logs are capped at 250 MiB each and the last 10 per repo are retained. |
