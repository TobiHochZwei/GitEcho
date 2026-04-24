<p align="center">
  <img src="public/logo.svg" alt="GitEcho logo" width="128" height="128" />
</p>

<h1 align="center">GitEcho</h1>

<p align="center"><em>Self-hosted backups for GitHub, Azure DevOps and GitLab repositories.</em></p>

<p align="center">
  <a href="https://github.com/TobiHochZwei/GitEcho/actions/workflows/docker-publish.yml"><img src="https://github.com/TobiHochZwei/GitEcho/actions/workflows/docker-publish.yml/badge.svg" alt="Build and publish Docker image" /></a>
  <a href="https://github.com/TobiHochZwei/GitEcho/actions/workflows/ghcr-cleanup.yml"><img src="https://github.com/TobiHochZwei/GitEcho/actions/workflows/ghcr-cleanup.yml/badge.svg" alt="GHCR cleanup" /></a>
  <a href="https://github.com/TobiHochZwei/GitEcho/pkgs/container/gitecho"><img src="https://img.shields.io/badge/ghcr.io-tobihochzwei%2Fgitecho-2496ED?logo=docker&logoColor=white" alt="GHCR image" /></a>
  <a href="https://github.com/TobiHochZwei/GitEcho/releases/latest"><img src="https://img.shields.io/github/v/release/TobiHochZwei/GitEcho?display_name=tag&sort=semver" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/TobiHochZwei/GitEcho" alt="License" /></a>
</p>

## Technical Stack
This is a node.js application built with Astro.js and background tasks in node.js

## Purpose
This app helps you back up the code on GitHub.com, Azure DevOps, and GitLab (SaaS or self-hosted). It creates offline backups of selected repositories. The SQLite database (`/data/gitecho.db`) is the **source of truth** for every repository GitEcho knows about — it is populated automatically via provider auto-discovery (`gh repo list`, `az repos list`, GitLab REST `GET /projects?membership=true`) and is merged with an optional *extras* list in `/config/repos.txt` for repos auto-discovery can't see (other orgs, read-only tokens, manual pins). All backup state — repositories, backup runs, sync times, notes, and checksums — lives in the database.

## App flow
The app starts in red or green. The background is light red when there was no backup in the last 24h (read from the local SQLite database `gitecho.db` in `/data`). The background is green when there was a successful backup in the last 24h.

Container:
- Environment PAT for GitHub / Azure DevOps / GitLab
- User needs to specify per Token the ExpireTime
- Mount Points for the Targets
- GH CLI should be used for all actions (GitHub)
- Azure DevOps CLI (Azure DevOps)
- GitLab: REST API for discovery (via `PRIVATE-TOKEN` header) and `glab` CLI is installed in the image for ad-hoc debugging; cloning uses `git` with the PAT embedded as HTTP Basic auth (`oauth2:<pat>`)
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
- Dashboard (`/`) — overall status, total repos, last backup time, current mode, cached storage usage, and the most recent backup runs. Background turns green/red based on whether a successful backup occurred in the last 24h. The storage figure is served from a persistent cache refreshed by the worker after every run, so the dashboard never blocks on a filesystem walk.
- Repositories (`/repos`) — list of all known repos with provider, last sync time, last status, and a per-repo action (Browse for option1, ZIP archives for option2 and option3).
- Repository settings (`/settings/repos`) — DB-first view of every repository GitEcho backs up, with a filter, source badge (`discovered` vs. `extra`), and a separate section for extras pinned in `repos.txt`. Redundant `repos.txt` entries that are already in the DB are cleaned up automatically each cycle (toggle under `/settings/providers`).
- Repository detail (`/settings/repos/<id>`) — per-repo overview with status, last error, free-text **notes** (up to 4000 chars), a **“Exclude from future backups”** toggle that skips the repo without touching its last known status or history, a **“Verbose git trace (debug)”** toggle that captures full `GIT_TRACE` / `GIT_CURL_VERBOSE` / `GIT_TRACE_PACKET` / `GIT_TRACE_PERFORMANCE` output on the next clone or fetch, a list of captured trace logs with per-file downloads, and the last 20 backup attempts joined with their run.
- Backup runs (`/runs`) — chronological history of backup runs with totals, success / failed / unavailable / **skipped** counts, and error summaries.
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
│  │ - Status  │   │  ┌───────┐ ┌────────┐ ┌─────┐ │   │
│  │ - Browse  │   │  │GitHub │ │ Azure  │ │Git- │ │   │
│  │ - Download│   │  │Plugin │ │ DevOps │ │Lab  │ │   │
│  │           │   │  │(gh CLI│ │ Plugin │ │Plgn │ │   │
│  └─────┬─────┘   │  └───┬───┘ └───┬────┘ └──┬──┘ │   │
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

**Plugin System:** Each git provider (GitHub, Azure DevOps, GitLab, …) is implemented as an isolated plugin. Plugins share a common interface for repository discovery, cloning, and syncing — making it straightforward to add support for Bitbucket or other providers in the future.

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
| `MASTER_KEY` | **Yes** | 32-byte key (hex or base64) used to encrypt the admin password hash, provider PATs and the SMTP password at rest. Generate with `openssl rand -hex 32`. **The container refuses to start without it, and if you lose it all stored secrets are unrecoverable.** | `7f...` (64 hex chars) |
| `PUBLIC_URL` | Required behind a reverse proxy | Comma-separated list of external URLs under which the UI is reachable (scheme + host + port). Browser requests whose `Origin` matches an entry here are accepted for state-changing operations. Without this, requests through a proxy that rewrites the host (Synology DSM portal, Traefik, nginx, subdomains) may be rejected with **403**. | `https://gitecho.example.com,https://nas.local:5000` |
| `DATA_DIR` | No | Override the data mount path (SQLite database, sync metadata). | `/data` |
| `CONFIG_DIR` | No | Override the config mount path (`repos.txt`, `settings.json`, `secrets.json`). | `/config` |
| `BACKUPS_DIR` | No | Override the backups mount path (cloned repos / ZIPs). | `/backups` |
| `LOG_LEVEL` | No | Default log level (`debug`, `info`, `warn`, `error`). Overridden by the value set in the Settings UI if present. | `info` |
| `LOG_MAX_BYTES` | No | Size threshold in bytes at which `/data/gitecho.log` is rotated. Up to 5 archives (`gitecho.log.1` … `gitecho.log.5`) are kept. | `10485760` (10 MB) |
| `TZ` | No | Container timezone as an IANA zone name. Controls timestamps in logs, emails, the UI, and cron scheduling. Defaults to `UTC`. The entrypoint also writes `/etc/localtime` and `/etc/timezone` so system tools (`git`, `ls -l`, …) stay consistent. | `Europe/Berlin` |

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
| GitLab PAT + expiration date + host (self-hosted only) | `/settings/providers` → GitLab | `GITLAB_PAT`, `GITLAB_PAT_EXPIRES`, `GITLAB_HOST` |
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

**GitLab**

- **Scopes:** `read_api` (list projects the PAT is a member of) and
  `read_repository` (clone over HTTPS). No write scopes needed.
- **Expiry:** GitLab PATs can be created without an expiration date — if
  yours doesn't expire, leave the expiry field empty or set a far-future
  date. When an expiry *is* set, the same warning window controlled by
  `PAT_EXPIRY_WARN_DAYS` applies.
- **Self-hosted GitLab:** set `GITLAB_HOST` (or the Host field on
  `/settings/providers`) to the hostname only (e.g.
  `gitlab.example.com`). Discovery, cloning, and URL classification in
  `repos.txt` then target that host instead of `gitlab.com`.
- **Nested groups:** URLs of the form
  `https://gitlab.com/group/subgroup/…/repo` are fully supported. The
  *owner* column shows the full group path, and the on-disk backup path
  becomes `/backups/gitlab/<group>/<subgroup>…/<repo>`.

Create tokens at <https://gitlab.com/-/user_settings/personal_access_tokens> (or `<host>/-/user_settings/personal_access_tokens` for self-hosted).

**Defaults:** `BACKUP_MODE=option1`, `CRON_SCHEDULE=0 2 * * *` (daily at 2 AM), `PAT_EXPIRY_WARN_DAYS=14`, `NOTIFY_ON_SUCCESS=false`.

## Settings UI

GitEcho ships with a web UI for managing configuration without restarting the container. Visit `/settings` after logging in to:

- **Repositories** — add or remove URLs in `/config/repos.txt` from the browser.
- **Providers** — set or rotate GitHub / Azure DevOps / GitLab PATs, record their expiration dates, toggle auto-discovery, and run a one-click *Test connection* (uses `gh auth status`, `az devops project list`, or a GitLab `/api/v4/user` call).
- **SMTP** — configure host/port/user/password/from/to, toggle "notify on success", set `pat_expiry_warn_days`, and send a test email.
- **General** — change backup mode, edit the cron schedule, and trigger an ad-hoc backup with **Run backup**. The button is disabled while a run is already in progress (the worker process and the web process share a filesystem lock at `/data/.backup.lock`).
- **Per-run details** — `/runs/<id>` lists every repository that was processed in a given run with status, error message, ZIP path, and SHA-256.

UI changes are persisted to:

- `/config/repos.txt` — repository list (preserves your existing comments).
- `/config/settings.json` — non-secret settings (PAT expirations, SMTP host/port, cron, mode, etc.).
- `/config/secrets.json` — AES-256-GCM-encrypted PATs and SMTP password.

Configuration precedence is **builtin defaults < environment variables < `settings.json` < `secrets.json`**, re-read by both processes on every backup cycle. Note: changes to the **cron schedule** only take effect after the worker container restarts.

### Security notes

- **Default credentials are `admin` / `admin`.** On first start GitEcho
  bootstraps an admin account and marks it as *must change password* — you
  are redirected to the change-password screen and cannot navigate away
  until a new password (min. 8 characters, different from the username) is
  set. The bcrypt hash is stored in the encrypted `/config/secrets.json`
  vault, never on disk in plaintext and never in env vars.
- Sessions are cookie-based: `HttpOnly`, `SameSite=Strict`, `Secure` when
  served over HTTPS, HMAC-signed with `MASTER_KEY`, sliding 7-day expiry.
  Restarting the container invalidates all sessions.
- **Always put GitEcho behind a TLS-terminating reverse proxy** (Caddy,
  nginx, Traefik, …) when exposing it beyond `localhost`. The login form
  sends credentials over HTTP otherwise.
- When running behind a reverse proxy that rewrites the host (Synology DSM
  portal, subdomains, etc.), set `PUBLIC_URL` to the external URL(s).
  Otherwise add/remove/save actions from the UI may fail with `403
  Forbidden` because the browser's `Origin` header does not match the
  container's internal host.
- **Forgot your password?** There is no email reset. Stop the container,
  delete the `ui.passwordHash` entry from `/config/secrets.json` (or the
  entire file — you'll lose PATs/SMTP password too), and restart: GitEcho
  will re-bootstrap `admin` / `admin`.
- Losing `MASTER_KEY` means losing every credential stored via the UI
  (admin password included) — back it up alongside your other secrets.
- The container is no longer strictly immutable when you use the Settings
  UI: state lives in `/config` and `/data`, both of which must be
  persistent volumes.

## Docker Setup

### Docker Run

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e MASTER_KEY="$(openssl rand -hex 32)" \
  -v gitecho-data:/data \
  -v gitecho-config:/config \
  -v gitecho-backups:/backups \
  gitecho:latest
```

Then open <http://localhost:3000>, sign in with the default credentials
**`admin` / `admin`** and you will be forced to choose a new password
before anything else loads. After that, configure provider PATs, SMTP,
backup mode, and cron schedule from the Settings UI.

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
      # Encrypts the admin password hash, PATs and SMTP password stored
      # via the Settings UI. Required — the container refuses to start
      # without it. Generate once with: openssl rand -hex 32
      MASTER_KEY: "replace-with-64-hex-chars"

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
| `/data` | Local SQLite database (`gitecho.db`), structured log file (`gitecho.log` + rotated archives), storage-usage cache (`storage-cache.json`, refreshed by the worker after every run), and sync metadata |
| `/config` | `repos.txt` — extras pinned manually for repos auto-discovery can't see; `settings.json` — non-secret settings; `secrets.json` — AES-256-GCM-encrypted PATs and SMTP password |
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
- GitLab: `https://gitlab.com/<group>(/<subgroup>)*/<repo>` (nested groups supported; when `GITLAB_HOST` is set, URLs on that host are accepted instead of gitlab.com)

Example:

```
# GitHub repos
https://github.com/octocat/Hello-World

# Azure DevOps repos
https://dev.azure.com/myorg/MyProject/_git/my-repo

# GitLab repos (nested groups supported)
https://gitlab.com/mygroup/my-repo
https://gitlab.com/mygroup/subgroup/my-repo
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
>> **GitLab auto-discovery:** the GitLab provider discovers all projects the
>   configured `GITLAB_PAT` is a member of via the REST endpoint
>   `GET /api/v4/projects?membership=true` (paginated, up to 5 000 projects).
>   Nested groups are walked automatically — the full namespace path becomes
>   the repo's `owner`.> **Filters & discovery hygiene:** on `/settings/providers` you can additionally:
> - Restrict discovery by **owner/org allow-list** and **deny-list**
>   (case-insensitive, comma-separated; for Azure DevOps either the org or
>   the project segment matches).
> - Restrict by **visibility** (`All` / `Public only` / `Private only`).
> - **Blacklist** repos per provider so auto-discovery never picks them up
>   again on the next cycle.
> - **Auto-clean `/config/repos.txt`** (default on) — every cycle,
>   entries that are already picked up by auto-discovery (and therefore
>   live in the DB) are removed from the file so it only ever contains
>   genuine extras.
> - Optionally **send an email** when previously-unseen repos are
>   discovered (requires SMTP).
>
> To stop backing up an individual repo without removing it, open
> `/settings/repos/<id>` and toggle **Exclude from future backups** — the
> repo stays in the DB (with its history, notes, and last known status)
> but the engine skips it on every cycle until you turn it back on.
>
> ### Diagnosing a single failing repository
>
> When a specific repo keeps failing to clone or fetch (`curl 56 Recv
> failure: Connection reset by peer`, `fatal: early EOF`, `HTTP/2 stream
> CANCEL`, `fetch-pack: unexpected disconnect`, …) — especially for large
> repos or behind a NAS / corporate proxy / firewall — you can turn on
> **verbose git tracing** for just that repository:
>
> 1. Open `/settings/repos/<id>` and enable **Verbose git trace (debug)**.
>    Applies to both GitHub and Azure DevOps repos.
> 2. Trigger a backup (scheduled or manual). The next clone / fetch for
>    the repo runs with `GIT_TRACE`, `GIT_CURL_VERBOSE`,
>    `GIT_TRACE_PACKET`, `GIT_TRACE_PACK_ACCESS`,
>    `GIT_TRACE_PERFORMANCE` and `GIT_TRACE_SETUP` all on.
> 3. Refresh `/settings/repos/<id>` and download the captured log from
>    the **Debug traces** card. The log contains full curl verbose,
>    packet-level git protocol trace, timing information and the exact
>    exit code / signal. Credentials are redacted in both stderr and the
>    stored log.
> 4. Turn the toggle off when done — traces are verbose (tens of MiB on
>    a large clone) and only useful while actively troubleshooting.
>
> Logs are written to `/data/debug-logs/repo-<id>/<clone|pull>-<ts>.log`,
> capped at 250 MiB each, with the last 10 files per repo retained
> automatically.
>
> Newly-discovered repos are always persisted in the local SQLite database
> and appear on `/settings/repos`.

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
