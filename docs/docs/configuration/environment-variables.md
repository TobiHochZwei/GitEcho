# Environment Variables

## Required

| Variable | Description | Example |
|---|---|---|
| `MASTER_KEY` | 32-byte key (hex or base64) for encrypting secrets. The container **refuses to start** without it. Generate with `openssl rand -hex 32`. | `7f3a...` (64 hex chars) |

## Recommended

| Variable | Description | Default |
|---|---|---|
| `PUBLIC_URL` | Comma-separated external URLs (scheme + host + port) for reverse proxy setups. Required when the UI is served under a different hostname than the container listens on. Set to `*` to accept all origins and disable the CSRF origin check (not recommended). | — |
| `TZ` | IANA timezone name. Affects log timestamps, cron schedules, and `Date` values. | `UTC` |
| `PUID` | Override the container user's UID to match host directory ownership. | — |
| `PGID` | Override the container group's GID to match host directory ownership. | — |

## Storage Paths

| Variable | Description | Default |
|---|---|---|
| `DATA_DIR` | SQLite database, log files, and sync metadata | `/data` |
| `CONFIG_DIR` | `repos.txt`, `settings.json`, `secrets.json` | `/config` |
| `BACKUPS_DIR` | Cloned repositories and/or ZIP archives | `/backups` |

## Logging

| Variable | Description | Default |
|---|---|---|
| `LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error`. Overridden by the Settings UI if set there. | `info` |
| `LOG_MAX_BYTES` | Size threshold for log rotation. Up to 5 archives are kept (`gitecho.log.1` … `gitecho.log.5`). | `10485760` (10 MB) |

## Provider Fallbacks

These environment variables are accepted as a **fallback** when the Settings UI hasn't been configured yet. The Settings UI is the preferred way to manage providers.

| Variable | Description |
|---|---|
| `GITHUB_PAT` | GitHub Personal Access Token |
| `GITHUB_PAT_EXPIRES` | Expiration date (ISO format, e.g. `2026-06-01`) |
| `AZUREDEVOPS_PAT` | Azure DevOps Personal Access Token |
| `AZUREDEVOPS_PAT_EXPIRES` | Expiration date |
| `AZUREDEVOPS_ORG` | Azure DevOps organization name |
| `GITLAB_PAT` | GitLab Personal Access Token |
| `GITLAB_PAT_EXPIRES` | Expiration date |
| `GITLAB_HOST` | Hostname for self-hosted GitLab (default: `gitlab.com`) |

## Backup Settings Fallbacks

| Variable | Description | Default |
|---|---|---|
| `BACKUP_MODE` | Backup strategy: `option1`, `option2`, or `option3` | `option1` |
| `CRON_SCHEDULE` | Cron expression for backup timing | `0 2 * * *` (daily at 2 AM) |
| `CRON_TZ` | IANA timezone the cron expression is interpreted in (e.g. `Europe/Berlin`). Falls back to `TZ` env, else `UTC`. | `UTC` |

## SMTP Fallbacks

| Variable | Description | Default |
|---|---|---|
| `SMTP_HOST` | SMTP server hostname | — |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP authentication username | — |
| `SMTP_PASS` | SMTP authentication password | — |
| `SMTP_FROM` | Sender email address | — |
| `SMTP_TO` | Recipient email address | — |
| `NOTIFY_ON_SUCCESS` | Send email on successful backups | `false` |
| `PAT_EXPIRY_WARN_DAYS` | Days before PAT expiration to start warning | `14` |
