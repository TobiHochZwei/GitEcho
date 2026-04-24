# Docker Run

The simplest way to get GitEcho running with a single command.

## Basic Setup

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e MASTER_KEY="$(openssl rand -hex 32)" \
  -v gitecho-data:/data \
  -v gitecho-config:/config \
  -v gitecho-backups:/backups \
  ghcr.io/tobihochzwei/gitecho:latest
```

Then open <http://localhost:3000>, sign in with `admin` / `admin`, and configure providers via the Settings UI.

## With Environment Variable Fallbacks

If you prefer a fully declarative deployment without using the Settings UI:

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e MASTER_KEY="$(openssl rand -hex 32)" \
  -e GITHUB_PAT="ghp_xxxxxxxxxxxx" \
  -e GITHUB_PAT_EXPIRES="2026-06-01" \
  -e BACKUP_MODE="option1" \
  -e CRON_SCHEDULE="0 2 * * *" \
  -e TZ="Europe/Berlin" \
  -v gitecho-data:/data \
  -v gitecho-config:/config \
  -v gitecho-backups:/backups \
  ghcr.io/tobihochzwei/gitecho:latest
```

## With Bind Mounts

To use host directories instead of Docker volumes:

```bash
docker run -d \
  --name gitecho \
  -p 3000:3000 \
  -e MASTER_KEY="your-64-hex-char-key" \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  -v /path/to/data:/data \
  -v /path/to/config:/config \
  -v /path/to/backups:/backups \
  ghcr.io/tobihochzwei/gitecho:latest
```

!!! tip
    Set `PUID` and `PGID` to your host user's UID/GID when using bind mounts so the container can read and write the mounted directories.

## Mount Points

| Path | Purpose |
|---|---|
| `/data` | SQLite database (`gitecho.db`), structured log file (`gitecho.log` + rotated archives), storage-usage cache, sync metadata |
| `/config` | `repos.txt` (repository list), `settings.json` (non-secret settings), `secrets.json` (AES-256-GCM-encrypted PATs and SMTP password) |
| `/backups` | Cloned repositories (option1), ZIP archives (option2), or bare mirror + ZIP snapshots (option3) |

## Container Image

GitEcho is published as a multi-arch image (amd64 + arm64) on GitHub Container Registry:

```
ghcr.io/tobihochzwei/gitecho:latest
```

!!! warning "Pin your image tags"
    For production use, pin to a specific version tag (e.g., `ghcr.io/tobihochzwei/gitecho:0.2.1`) instead of `:latest`.
