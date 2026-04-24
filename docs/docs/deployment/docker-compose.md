# Docker Compose

The recommended way to deploy GitEcho for production use.

## Minimal Setup

```yaml
services:
  gitecho:
    image: ghcr.io/tobihochzwei/gitecho:latest
    container_name: gitecho
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      MASTER_KEY: "replace-with-64-hex-chars"
    volumes:
      - gitecho-data:/data
      - gitecho-config:/config
      - gitecho-backups:/backups

volumes:
  gitecho-data:
  gitecho-config:
  gitecho-backups:
```

Generate the `MASTER_KEY`:

```bash
openssl rand -hex 32
```

Start:

```bash
docker compose up -d
```

## Full Configuration

```yaml
services:
  gitecho:
    image: ghcr.io/tobihochzwei/gitecho:latest
    container_name: gitecho
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      MASTER_KEY: "${MASTER_KEY:?Generate with: openssl rand -hex 32}"

      # Optional: match ownership of bind-mounted host directories
      PUID: ${PUID:-}
      PGID: ${PGID:-}

      # Container timezone
      TZ: ${TZ:-UTC}

      # Reverse proxy origin(s)
      PUBLIC_URL: ${PUBLIC_URL:-}

      # Provider tokens (prefer the Settings UI instead)
      GITHUB_PAT: ${GITHUB_PAT:-}
      GITHUB_PAT_EXPIRES: ${GITHUB_PAT_EXPIRES:-}
      AZUREDEVOPS_PAT: ${AZUREDEVOPS_PAT:-}
      AZUREDEVOPS_PAT_EXPIRES: ${AZUREDEVOPS_PAT_EXPIRES:-}
      GITLAB_PAT: ${GITLAB_PAT:-}
      GITLAB_PAT_EXPIRES: ${GITLAB_PAT_EXPIRES:-}
      GITLAB_HOST: ${GITLAB_HOST:-}

      # Backup settings
      BACKUP_MODE: ${BACKUP_MODE:-option1}
      CRON_SCHEDULE: ${CRON_SCHEDULE:-0 2 * * *}

      # SMTP notifications (optional)
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASS: ${SMTP_PASS:-}
      SMTP_FROM: ${SMTP_FROM:-}
      SMTP_TO: ${SMTP_TO:-}
      NOTIFY_ON_SUCCESS: ${NOTIFY_ON_SUCCESS:-false}
      PAT_EXPIRY_WARN_DAYS: ${PAT_EXPIRY_WARN_DAYS:-14}
    volumes:
      - gitecho-data:/data
      - gitecho-config:/config
      - gitecho-backups:/backups

volumes:
  gitecho-data:
  gitecho-config:
  gitecho-backups:
```

Create a `.env` file alongside `docker-compose.yml`:

```bash
MASTER_KEY=your-64-hex-char-key
TZ=Europe/Berlin
# Add other variables as needed
```

## Using Bind Mounts

Replace the named volumes with host paths:

```yaml
volumes:
  - /srv/gitecho/data:/data
  - /srv/gitecho/config:/config
  - /srv/gitecho/backups:/backups
```

Set `PUID` and `PGID` to match the host directory ownership:

```bash
# Check host directory ownership
ls -ldn /srv/gitecho/data
# Use the UID and GID shown
```

## Common Operations

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f gitecho

# Restart (e.g., after cron schedule change)
docker compose restart gitecho

# Stop
docker compose down

# Upgrade
docker compose pull && docker compose up -d
```
