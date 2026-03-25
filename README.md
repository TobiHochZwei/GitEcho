# GitHub Backup / Azure DevOps Backup

## Technical Stack
This is a node.js application built with Astro.js and background tasks in node.js

## Purpose
This app helps you back up the code on GitHub.com. It creates offline backups of certain repositories. The URLs to repositories are stored in the file system in a text file. The statistics about last backup, etc. are also stored in a text file.

## App flow
The app starts in red or green. The background is light red when there was no backup in the last 24h (read from statistics.csv). The background is green when there was a backup in the last 24h.

Container:
- Environment PAT for Github / AzureDevOps
- User needs to specify per Token the ExpireTime
- Mount Points for the Targets
- GH Cli should be used for all actions (Github)
- Azure DevOps CLI (AzureDevOps)
- The tool should store all available repositories and the last sync time in a local database (Mount Point for the data files)
- The tool should run in configurable cycles via environment variable — the user can specify a cron syntax to schedule
- Everything should be configurable via environment variables + mount points
- It should be an immutable container so that the data lives outside via mount points
- Add SMTP functionality for notifying about critical issues or optionally successful runs with a short summary — warning about PAT expirations per email

Option1:
- Think about a bulletproof mechanism for backing up the repository. Data should not be lost. Having a repo and full history is okay. But make it in a way that history cannot get lost. Mechanism for a backup is git pull (download in the WebUI via ZIP)

Option2:
- every run creates a zip of the Repo - checksum will decide if we keep that zip. when checksum is same you can delete and keep the existing last version

User can decide which mode via environment variable: option1 or option2

WebApp features
- Status of all backup repositories and source (GitHub / Azure DevOps)
- In case of strategy option1, show a read-only view of the latest state of the repo with possibility to navigate the repo (download files / folder / repo via ZIP)
- In case of option2, show the repos and the list of ZIPs

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
     │ (DB, CSV) │ │ (repos    │ │ (cloned    │
     │           │ │  list)    │ │  repos/ZIPs│
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
| `BACKUP_MODE` | No | Backup strategy: `option1` (git pull) or `option2` (ZIP snapshots) | `option1` |
| `CRON_SCHEDULE` | No | Cron expression for backup cycle | `0 */6 * * *` |
| `SMTP_HOST` | No | SMTP server hostname for email notifications | `smtp.example.com` |
| `SMTP_PORT` | No | SMTP server port | `587` |
| `SMTP_USER` | No | SMTP authentication username | `alerts@example.com` |
| `SMTP_PASS` | No | SMTP authentication password | `secret` |
| `SMTP_FROM` | No | Sender address for notification emails | `gitecho@example.com` |
| `SMTP_TO` | No | Recipient address(es) for notifications | `admin@example.com` |
| `NOTIFY_ON_SUCCESS` | No | Send email on successful backup runs | `false` |
| `PAT_EXPIRY_WARN_DAYS` | No | Days before PAT expiry to start warning | `14` |

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
      - gitecho-data:/data       # Database and statistics
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
| `/data` | Local database, `statistics.csv`, and sync metadata |
| `/config` | Text file containing repository URLs to back up |
| `/backups` | Cloned repositories (option1) or ZIP archives (option2) |

> **Note:** The container is designed to be immutable — all persistent state lives in the mount points. You can safely recreate the container without losing data.

## License

This project is licensed under the [MIT License](LICENSE).
