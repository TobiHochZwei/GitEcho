# GitHub Backup / Azure DevOps Backup

## Technical Stack
This is a node.js application built with Astro.js and background tasks in node.js

## Purpose
This app helps you back up the code on GitHub.com and Azure DevOps. It creates offline backups of selected repositories. Repository URLs are stored in a text file (`/config/repos.txt`), and all backup state — repositories, backup runs, sync times, and checksums — is stored in a local SQLite database (`/data/gitecho.db`).

## App flow
The app starts in red or green. The background is light red when there was no backup in the last 24h (read from the local SQLite database `gitecho.db` in `/data`). The background is green when there was a successful backup in the last 24h.

Container:
- Environment PAT for Github / AzureDevOps
- User needs to specify per Token the ExpireTime
- Mount Points for the Targets
- GH Cli should be used for all actions (Github)
- Azure DevOps CLI (AzureDevOps)
- The tool should store all available repositories, backup-run history, and the last sync time in a local SQLite database (`gitecho.db`) on the data mount point
- The tool should run in configurable cycles via environment variable — the user can specify a cron syntax to schedule
- Everything should be configurable via environment variables + mount points
- It should be an immutable container so that the data lives outside via mount points
- Add SMTP functionality for notifying about critical issues or optionally successful runs with a short summary — warning about PAT expirations per email

Option1:
- Think about a bulletproof mechanism for backing up the repository. Data should not be lost. Having a repo and full history is okay. But make it in a way that history cannot get lost. Mechanism for a backup is git pull (download in the WebUI via ZIP)

Option2:
- Every run creates a ZIP of the repo. A SHA-256 checksum decides whether the new ZIP is kept: if the checksum matches the previous run's stored checksum, the new ZIP is discarded and the previous archive is kept; if it differs, the new ZIP is stored under a timestamped filename.

Option3 (mirror + ZIP snapshots):
- Maintains a bare `git clone --mirror` of the repository under
  `/backups/<provider>/<owner>/<repo>/clone/` so every branch, tag, and
  note is preserved. Auto-GC is disabled (`gc.auto = 0`) on the mirror so
  unreachable commits (e.g. after an upstream force-push) stay alive on
  disk. On every cycle the remote URL is refreshed (PAT-rotation safe)
  and `git remote update --prune` is run.
- In addition, a ZIP snapshot of `HEAD` is produced via `git archive` and
  written to `/backups/<provider>/<owner>/<repo>/zips/<repo>_<timestamp>.zip`,
  deduplicated by SHA-256 just like option2.
- This is the strongest revision-safety mode but doubles the on-disk
  footprint (mirror + ZIPs). The Browse UI is not available for option3
  repos because a bare mirror has no working tree — use the ZIP archives
  page instead.

User can decide which mode via environment variable: option1, option2, or option3

WebApp features
- Dashboard (`/`) — overall status, total repos, last backup time, current mode, and the most recent backup runs. Background turns green/red based on whether a successful backup occurred in the last 24h.
- Repositories (`/repos`) — list of all known repos with provider, last sync time, last status, and a per-repo action (Browse for option1, ZIP archives for option2 and option3).
- Backup runs (`/runs`) — chronological history of backup runs with totals, success/failure counts, and error summaries.
- Browse (`/browse/<provider>/<owner>/<repo>/...`, option1 only) — read-only file/folder navigation of the cloned repo, with download as ZIP for files, folders, or the whole repo.
- ZIP archives (`/zips/<provider>/<owner>/<repo>`, option2 and option3) — list of stored ZIP snapshots for a repo with size, date, and download link.
- Logs (`/logs`) — live view of the structured JSONL log (`/data/gitecho.log`) with filtering by level (debug/info/warn/error), source (server/worker), and free-text search, plus a download button for the rotated log files.

### Unavailable upstream repositories

When an upstream repository can no longer be reached (deleted, renamed, made
private, PAT no longer authorized, or the host returns 404 / 403) GitEcho:

- **continues the run** for all remaining repositories — a single missing repo
  never aborts the cycle;
- marks the affected repository with the `unavailable` status (visible on
  `/repos` and in the per-run details on `/runs/<id>`);
- records `repos_unavailable` on the `backup_runs` row so the count is shown
  in `/runs` and the dashboard;
- adds an **Unavailable Upstream** count card and a warning banner to the
  dashboard whenever any repository is currently unavailable;
- sends **one summary email per run** listing all repositories that became
  unavailable during that run (independent of `NOTIFY_ON_SUCCESS`; only sent
  when SMTP is configured).

Existing local backups (clones / ZIP snapshots) are kept untouched — nothing is
deleted automatically. Once the upstream becomes reachable again the next
successful backup transitions the repository back to `success`.

 Implementation Strategy:
 - Make the providers like Azure DevOps / GitHub in a plugin style to have the possibility to add other git tools easily in the future

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    GitEcho Container                │
│                                                     │
│  ┌───────────┐   ┌──────────────────────────────┐   │
│  │  Astro.js │   │     Background Scheduler      │   │
│  │  Web UI   │   │  (cron-based backup cycles)   │   │
│  │           │   │                               │   │
│  │ - Status  │   │  ┌─────────┐  ┌───────────┐  │   │
│  │ - Browse  │   │  │ GitHub  │  │ Azure     │  │   │
│  │ - Download│   │  │ Plugin  │  │ DevOps    │  │   │
│  │           │   │  │ (GH CLI)│  │ Plugin    │  │   │
│  └─────┬─────┘   │  └────┬────┘  └─────┬─────┘  │   │
│        │         │       │              │        │   │
│        │         └───────┼──────────────┼────────┘   │
│        │                 │              │            │
│  ┌─────▼─────────────────▼──────────────▼─────────┐  │
│  │              Local Database                     │  │
│  │    (repos, sync times, checksums, stats)        │  │
│  └─────────────────────┬───────────────────────────┘  │
│                        │                             │
│  ┌─────────────────────▼───────────────────────────┐  │
│  │           SMTP Notification Service             │  │
│  │  (critical alerts, success summaries, PAT exp.) │  │
│  └─────────────────────────────────────────────────┘  │
│                                                     │
└──────────┬──────────────┬──────────────┬────────────┘
           │              │              │
     ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
     │  /data    │ │  /config  │ │  /backups  │
     │ (SQLite   │ │ (repos    │ │ (cloned    │
     │  DB)      │ │  list)    │ │  repos/ZIPs│
     └───────────┘ └───────────┘ └───────────┘
        Mount Points (persistent volumes)
```

**Plugin System:** Each git provider (GitHub, Azure DevOps, etc.) is implemented as an isolated plugin. Plugins share a common interface for repository discovery, cloning, and syncing — making it straightforward to add support for GitLab, Bitbucket, or other providers in the future.

## Environment Variables

GitEcho is configured in two places:

- **Settings UI** (`/settings`) — the recommended place for anything secret or
  anything you may want to change at runtime: PATs, PAT expiration dates,
  Azure DevOps org, SMTP credentials, backup mode, cron schedule, discovery
  filters, and notification toggles. Persisted to `/config/settings.json` and
  AES-256-GCM-encrypted `/config/secrets.json`.
- **Environment variables** — container-level bootstrap that the UI cannot
  change: where to bind mounts, how to gate the UI itself, and the encryption
  key for the secrets file.

Configuration precedence is **builtin defaults < environment variables <
`settings.json` < `secrets.json`**, so values set in the UI always win over
the environment.

### Recommended (set via environment)

| Variable | Required | Description | Example |
|---|---|---|---|
| `MASTER_KEY` | Yes (for Settings UI secrets) | 32-byte key (hex or base64) used to encrypt PATs and the SMTP password at rest. Generate with `openssl rand -hex 32`. **If you lose it, all stored secrets are unrecoverable.** | `7f...` (64 hex chars) |
| `UI_USER` | Recommended | Username for the Web UI HTTP Basic Auth. Auth is enforced only when both `UI_USER` and `UI_PASS` are set. | `admin` |
| `UI_PASS` | Recommended | Password for the Web UI HTTP Basic Auth. | `change-me` |
| `PUBLIC_URL` | Required behind a reverse proxy | Comma-separated list of external URLs under which the UI is reachable (scheme + host + port). Browser requests whose `Origin` matches an entry here are accepted for state-changing operations. Without this, requests through a proxy that rewrites the host (Synology DSM portal, Traefik, nginx, subdomains) may be rejected with **403**. | `https://gitecho.example.com,https://nas.local:5000` |
| `DATA_DIR` | No | Override the data mount path (SQLite database, sync metadata). | `/data` |
| `CONFIG_DIR` | No | Override the config mount path (`repos.txt`, `settings.json`, `secrets.json`). | `/config` |
| `BACKUPS_DIR` | No | Override the backups mount path (cloned repos / ZIPs). | `/backups` |
| `LOG_LEVEL` | No | Default log level (`debug`, `info`, `warn`, `error`). Overridden by the value set in the Settings UI if present. | `info` |
| `LOG_MAX_BYTES` | No | Size threshold in bytes at which `/data/gitecho.log` is rotated. Up to 5 archives (`gitecho.log.1` … `gitecho.log.5`) are kept. | `10485760` (10 MB) |

### Configure in the Settings UI

These used to be environment variables and are still accepted as a fallback
(useful for first boot or fully-declarative deployments), but the Settings UI
is the preferred place — PATs go into the encrypted secrets store and
expiration dates, SMTP credentials, cron schedule, etc. can be rotated
without recreating the container.

| Setting | UI location | Env fallback |
|---|---|---|
| GitHub PAT + expiration date | `/settings/providers` → GitHub | `GITHUB_PAT`, `GITHUB_PAT_EXPIRES` |
| Azure DevOps PAT + expiration date + organization | `/settings/providers` → Azure DevOps | `AZUREDEVOPS_PAT`, `AZUREDEVOPS_PAT_EXPIRES`, `AZUREDEVOPS_ORG` |
| SMTP host / port / user / password / from / to | `/settings/smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TO` |
| Backup mode (`option1` / `option2` / `option3`) | `/settings/general` | `BACKUP_MODE` |
| Cron schedule | `/settings/general` | `CRON_SCHEDULE` |
| Notify on successful backups | `/settings/smtp` | `NOTIFY_ON_SUCCESS` |
| PAT-expiry warning window (days) | `/settings/smtp` | `PAT_EXPIRY_WARN_DAYS` |

### Required PAT scopes

The same guidance is shown inline next to the input field on
`/settings/providers`, so you don't have to switch windows when rotating a
token.

**GitHub**

- **Classic PAT:** `repo` (full — needed to clone private repos) and
  `read:org` (to list org-owned repos via `gh repo list`). A single classic
  PAT sees every private repo your GitHub account has access to — your own
  repos, repos in orgs you belong to, and repos in other users' accounts
  where you're a collaborator.
- **Fine-grained PAT:** Repository permissions → *Contents: Read* and
  *Metadata: Read*. Grant access to **all repositories** (or all in the
  target org) you want backed up — a fine-grained PAT only sees repos it
  was explicitly granted access to. Fine-grained PATs are scoped to a
  single resource owner and don't support cross-account collaborator
  access — use a classic PAT if you need to back up repos from multiple
  owners.
- **SAML SSO:** if an org enforces SSO, open the token on
  <https://github.com/settings/tokens> and click *Configure SSO* →
  *Authorize* for each org. Without this, that org's repos stay invisible
  to the PAT even though you personally have access.

Create tokens at <https://github.com/settings/tokens>.

**Azure DevOps**

- **Code** → *Read* (clone + list repos per project)
- **Project and Team** → *Read* (list all projects in the org)
- Set **Organization** to *All accessible organizations* (or the specific
  one) when creating the PAT.
- Azure DevOps PATs are scoped to one organization at creation time. To
  back up repos from **additional orgs**, list them in `repos.txt` with
  their full `https://dev.azure.com/<other-org>/<project>/_git/<repo>`
  URL; the same PAT authenticates as long as it was issued with *All
  accessible organizations*. If the orgs live in different Entra tenants,
  create one PAT per tenant and run separate GitEcho instances.

Create tokens at `https://dev.azure.com/<your-org>/_usersSettings/tokens`.

**Defaults:** `BACKUP_MODE=option1`, `CRON_SCHEDULE=0 2 * * *` (daily at 2 AM), `PAT_EXPIRY_WARN_DAYS=14`, `NOTIFY_ON_SUCCESS=false`.

## Settings UI

GitEcho ships with a web UI for managing configuration without restarting the container. Visit `/settings` after logging in to:

- **Repositories** — add or remove URLs in `/config/repos.txt` from the browser.
- **Providers** — set or rotate GitHub / Azure DevOps PATs, record their expiration dates, toggle GitHub auto-discovery, and run a one-click *Test connection* (uses `gh auth status` / `az devops project list`).
- **SMTP** — configure host/port/user/password/from/to, toggle "notify on success", set `pat_expiry_warn_days`, and send a test email.
- **General** — change backup mode, edit the cron schedule, and trigger an ad-hoc backup with **Run backup**. The button is disabled while a run is already in progress (the worker process and the web process share a filesystem lock at `/data/.backup.lock`).
- **Per-run details** — `/runs/<id>` lists every repository that was processed in a given run with status, error message, ZIP path, and SHA-256.

UI changes are persisted to:

- `/config/repos.txt` — repository list (preserves your existing comments).
- `/config/settings.json` — non-secret settings (PAT expirations, SMTP host/port, cron, mode, etc.).
- `/config/secrets.json` — AES-256-GCM-encrypted PATs and SMTP password.

Configuration precedence is **builtin defaults < environment variables < `settings.json` < `secrets.json`**, re-read by both processes on every backup cycle. Note: changes to the **cron schedule** only take effect after the worker container restarts.

### Security notes

- HTTP Basic Auth is plaintext on the wire. **Always put GitEcho behind a TLS-terminating reverse proxy** (Caddy, nginx, Traefik, …) when exposing it beyond `localhost`.
- If `UI_USER`/`UI_PASS` are unset, the Settings UI is reachable without authentication and a warning is logged at startup.
- When running behind a reverse proxy that rewrites the host (Synology DSM portal, subdomains, etc.), set `PUBLIC_URL` to the external URL(s). Otherwise add/remove/save actions from the UI may fail with `403 Forbidden` because the browser's `Origin` header does not match the container's internal host.
- Losing `MASTER_KEY` means losing every PAT and SMTP password stored via the UI — back it up alongside your other secrets.
- The container is no longer strictly immutable when you use the Settings UI: state lives in `/config` and `/data`, both of which must be persistent volumes.

## Docker Setup

### Docker Run

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e MASTER_KEY="$(openssl rand -hex 32)" \
  -e UI_USER=admin \
  -e UI_PASS=change-me \
  -v gitecho-data:/data \
  -v gitecho-config:/config \
  -v gitecho-backups:/backups \
  gitecho:latest
```

Then open <http://localhost:3000/settings> and configure provider PATs,
SMTP, backup mode, and cron schedule from the UI.

### Docker Compose

```yaml
services:
  gitecho:
    image: gitecho:latest
    container_name: gitecho
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      # Encrypts PATs + SMTP password stored via the Settings UI.
      # Generate once with: openssl rand -hex 32
      MASTER_KEY: "replace-with-64-hex-chars"

      # HTTP Basic Auth for the Web UI (strongly recommended)
      UI_USER: admin
      UI_PASS: change-me

      # Required when running behind a reverse proxy that rewrites the host.
      # PUBLIC_URL: "https://gitecho.example.com"
    volumes:
      - gitecho-data:/data       # SQLite database
      - gitecho-config:/config   # repos.txt, settings.json, encrypted secrets.json
      - gitecho-backups:/backups # Cloned repos or ZIP archives

volumes:
  gitecho-data:
  gitecho-config:
  gitecho-backups:
```

Everything else — GitHub / Azure DevOps PATs and their expiration dates,
SMTP credentials, backup mode, cron schedule, discovery filters — is
configured at runtime under `/settings` and persisted to the `/config`
volume. The legacy `GITHUB_PAT` / `AZUREDEVOPS_PAT` / `SMTP_*` /
`BACKUP_MODE` / `CRON_SCHEDULE` environment variables are still honored as
a fallback if you prefer a fully declarative deployment.

### Mount Points

| Path | Purpose |
|---|---|
| `/data` | Local SQLite database (`gitecho.db`), structured log file (`gitecho.log` + rotated archives), and sync metadata |
| `/config` | `repos.txt` — text file containing repository URLs to back up |
| `/backups` | Cloned repositories (option1), ZIP archives (option2), or bare mirror + ZIP snapshots (option3) |

### Upgrading

GitEcho ships its database schema inside the image and reconciles it on
every container start, so upgrading is a single command:

```bash
docker compose pull && docker compose up -d
```

What happens on boot:

- `initDatabase()` runs `CREATE TABLE IF NOT EXISTS …` plus a versioned,
  append-only migration runner backed by `PRAGMA user_version`. New tables
  appear automatically; new migrations are applied in order, each in a
  transaction.
- `entrypoint.sh` first snapshots `/data/gitecho.db` to
  `/data/gitecho.db.bak.<timestamp>` (best-effort, last 5 retained), so a
  botched upgrade is recoverable by restoring the most recent snapshot
  and re-pinning the previous image tag.
- The `/data` volume persists across upgrades, so all history, repos and
  metadata survive.

Recommendations for production:

- **Pin image tags** (e.g. `gitecho:1.4.2`, never `:latest`) so upgrades
  and rollbacks are deliberate.
- Back up the `/data` volume off-host before major upgrades — the
  built-in snapshot is a safety net, not a substitute.

For the full migration strategy and how to add a new schema migration as
a contributor, see [DEVELOPMENT.md §9](./DEVELOPMENT.md#9-database-schema-migrations).

### `/config/repos.txt` format

One repository URL per line. Lines that are blank or start with `#` are
ignored. Supported URL forms:

- GitHub: `https://github.com/<owner>/<repo>` (with or without `.git`)
- Azure DevOps: `https://dev.azure.com/<org>/<project>/_git/<repo>`

Example:

```
# GitHub repos
https://github.com/octocat/Hello-World

# Azure DevOps repos
https://dev.azure.com/myorg/MyProject/_git/my-repo
```

> **GitHub auto-discovery:** in addition to anything listed in `repos.txt`,
> the GitHub provider also discovers all repositories visible to the
> configured `GITHUB_PAT` via `gh repo list` and merges them with the file
> entries (deduplicated by URL). If you only want a curated subset, use a
> PAT scoped to those repos.
>
> **Azure DevOps auto-discovery:** the Azure DevOps provider also discovers
> all repositories visible to the configured `AZUREDEVOPS_PAT` via
> `az devops project list` + `az repos list`. Discovery can be disabled per
> provider via the `Auto-discover` checkbox on `/settings/providers`.
>
> **Filters & auto-add:** on `/settings/providers` you can additionally:
> - Restrict discovery by **owner/org allow-list** and **deny-list**
>   (case-insensitive, comma-separated; for Azure DevOps either the org or
>   the project segment matches).
> - Restrict by **visibility** (`All` / `Public only` / `Private only`).
> - Optionally **append newly-discovered URLs to `/config/repos.txt`** so
>   the file stays in sync with what's being backed up.
> - Optionally **send an email** when previously-unseen repos are
>   discovered (requires SMTP).
>
> Newly-discovered repos are always persisted in the local SQLite database
> and appear in the `/repos` UI.

> **Note:** The container is designed to be immutable — all persistent state lives in the mount points. You can safely recreate the container without losing data.

## Development

Local development without Docker (Node.js 22+ required):

```bash
npm install

# Run the Astro web UI in dev mode
npm run dev

# Run the background worker in watch/TS-on-the-fly mode (separate terminal)
npm run worker:dev

# Production build (Astro server + bundled worker)
npm run build

# Run the built app
npm start          # web server on :3000
npm run worker     # background scheduler
```

By default the app expects the mount paths `/data`, `/config`, and
`/backups` to exist. For local development, override them with `DATA_DIR`,
`CONFIG_DIR`, and `BACKUPS_DIR` (see Environment Variables).

## License

This project is licensed under the [MIT License](LICENSE).
