# Configuration

GitEcho is configured through two mechanisms:

1. **Environment variables** — container-level bootstrap settings
2. **Settings UI** (`/settings`) — runtime configuration stored in config files

## Configuration Precedence

```
Builtin defaults  <  Environment variables  <  settings.json  <  secrets.json
```

Values set in the Settings UI **always win** over environment variables. This means you can bootstrap with env vars and then refine everything through the UI without restarting the container.

## What Goes Where

### Environment Variables

Use environment variables for things the UI **cannot** change:

- `MASTER_KEY` — encryption key (required)
- `PUBLIC_URL` — reverse proxy origins
- `DATA_DIR`, `CONFIG_DIR`, `BACKUPS_DIR` — mount point overrides
- `LOG_LEVEL`, `LOG_MAX_BYTES` — logging configuration
- `PUID`, `PGID` — container user remapping
- `TZ` — container timezone

See [Environment Variables](environment-variables.md) for the full reference.

### Settings UI

Use the Settings UI for everything else — it's the **recommended** approach:

- Provider PATs and expiration dates
- SMTP credentials and notification settings
- Backup mode and cron schedule
- Discovery filters and blacklists

See [Settings UI](settings-ui.md) for details.

### Config Files

The Settings UI persists its data to two files on the `/config` volume:

| File | Contents | Encryption |
|---|---|---|
| `settings.json` | Non-secret settings (PAT expirations, SMTP host/port, cron, mode, filters) | Plaintext |
| `secrets.json` | PATs, SMTP password, admin password hash | AES-256-GCM |

Both files are re-read by the web server and worker on every backup cycle, so changes take effect without a restart (except cron schedule changes, which require a worker restart).

### repos.txt

The repository list at `/config/repos.txt` is a separate concern — see [Repository List](repos-txt.md).
