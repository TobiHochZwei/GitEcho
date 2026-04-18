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

User can decide which mode via environment variable: option1 or option2

WebApp features
- Dashboard (`/`) — overall status, total repos, last backup time, current mode, and the most recent backup runs. Background turns green/red based on whether a successful backup occurred in the last 24h.
- Repositories (`/repos`) — list of all known repos with provider, last sync time, last status, and a per-repo action (Browse for option1, ZIP archives for option2).
- Backup runs (`/runs`) — chronological history of backup runs with totals, success/failure counts, and error summaries.
- Browse (`/browse/<provider>/<owner>/<repo>/...`, option1 only) — read-only file/folder navigation of the cloned repo, with download as ZIP for files, folders, or the whole repo.
- ZIP archives (`/zips/<provider>/<owner>/<repo>`, option2 only) — list of stored ZIP snapshots for a repo with size, date, and download link.

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

| Variable | Required | Description | Example |
|---|---|---|---|
| `GITHUB_PAT` | Yes* | Personal Access Token for GitHub | `ghp_xxxxxxxxxxxx` |
| `AZUREDEVOPS_PAT` | Yes* | Personal Access Token for Azure DevOps | `xxxxxxxxxxxxxxxx` |
| `GITHUB_PAT_EXPIRES` | Yes* | Expiration date of the GitHub PAT (ISO 8601) | `2026-06-01` |
| `AZUREDEVOPS_PAT_EXPIRES` | Yes* | Expiration date of the Azure DevOps PAT (ISO 8601) | `2026-06-01` |
| `AZUREDEVOPS_ORG` | No | Azure DevOps organization (bare name or full URL). If unset, the org is inferred from the first Azure DevOps URL in `repos.txt`. | `myorg` or `https://dev.azure.com/myorg` |
| `BACKUP_MODE` | No | Backup strategy: `option1` (git pull) or `option2` (ZIP snapshots) | `option1` |
| `CRON_SCHEDULE` | No | Cron expression for backup cycle | `0 2 * * *` |
| `SMTP_HOST` | No | SMTP server hostname for email notifications | `smtp.example.com` |
| `SMTP_PORT` | No | SMTP server port | `587` |
| `SMTP_USER` | No | SMTP authentication username | `alerts@example.com` |
| `SMTP_PASS` | No | SMTP authentication password | `secret` |
| `SMTP_FROM` | No | Sender address for notification emails | `gitecho@example.com` |
| `SMTP_TO` | No | Recipient address(es) for notifications | `admin@example.com` |
| `NOTIFY_ON_SUCCESS` | No | Send email on successful backup runs | `false` |
| `PAT_EXPIRY_WARN_DAYS` | No | Days before PAT expiry to start warning | `14` |
| `DATA_DIR` | No | Override the data mount path (SQLite database, sync metadata) | `/data` |
| `CONFIG_DIR` | No | Override the config mount path (`repos.txt`) | `/config` |
| `BACKUPS_DIR` | No | Override the backups mount path (cloned repos / ZIPs) | `/backups` |

\* At least one provider PAT and its corresponding expiration date are required.

**Defaults:** `BACKUP_MODE=option1`, `CRON_SCHEDULE=0 2 * * *` (daily at 2 AM), `PAT_EXPIRY_WARN_DAYS=14`, `NOTIFY_ON_SUCCESS=false`.

## Docker Setup

### Docker Run

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e GITHUB_PAT=ghp_xxxxxxxxxxxx \
  -e GITHUB_PAT_EXPIRES=2026-06-01 \
  -e BACKUP_MODE=option1 \
  -e CRON_SCHEDULE="0 2 * * *" \
  -v gitecho-data:/data \
  -v gitecho-config:/config \
  -v gitecho-backups:/backups \
  gitecho:latest
```

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
      # Provider tokens
      GITHUB_PAT: ghp_xxxxxxxxxxxx
      GITHUB_PAT_EXPIRES: "2026-06-01"
      AZUREDEVOPS_PAT: xxxxxxxxxxxxxxxx
      AZUREDEVOPS_PAT_EXPIRES: "2026-06-01"

      # Backup settings
      BACKUP_MODE: option1
      CRON_SCHEDULE: "0 2 * * *"

      # Email notifications (optional)
      SMTP_HOST: smtp.example.com
      SMTP_PORT: 587
      SMTP_USER: alerts@example.com
      SMTP_PASS: secret
      SMTP_FROM: gitecho@example.com
      SMTP_TO: admin@example.com
      NOTIFY_ON_SUCCESS: false
      PAT_EXPIRY_WARN_DAYS: 14
    volumes:
      - gitecho-data:/data       # SQLite database
      - gitecho-config:/config   # Repository list
      - gitecho-backups:/backups # Cloned repos or ZIP archives

volumes:
  gitecho-data:
  gitecho-config:
  gitecho-backups:
```

### Mount Points

| Path | Purpose |
|---|---|
| `/data` | Local SQLite database (`gitecho.db`) with repos, backup runs, items, and sync metadata |
| `/config` | `repos.txt` — text file containing repository URLs to back up |
| `/backups` | Cloned repositories (option1) or ZIP archives (option2) |

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
