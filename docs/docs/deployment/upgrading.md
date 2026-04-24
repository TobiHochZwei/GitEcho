# Upgrading

GitEcho ships its database schema inside the image and reconciles it on every container start, so upgrading is a single command.

## Standard Upgrade

```bash
docker compose pull && docker compose up -d
```

## What Happens on Boot

1. **Schema creation** — `CREATE TABLE IF NOT EXISTS …` for every table. Fresh installs get the current shape directly.
2. **Legacy helpers** — idempotent `ALTER TABLE … ADD COLUMN` calls for pre-versioned installs.
3. **Versioned migrations** — an append-only `MIGRATIONS` array is applied in order, each in a transaction, tracked by `PRAGMA user_version`.

## Automatic Database Snapshots

`entrypoint.sh` snapshots `/data/gitecho.db` to `/data/gitecho.db.bak.<timestamp>` on every container start (best-effort, last 5 retained).

### Rolling Back

If an upgrade goes wrong:

```bash
docker compose down

# Inside the data volume, restore the most recent good snapshot:
cp /data/gitecho.db.bak.<timestamp> /data/gitecho.db

# Re-pin to the previous image tag in docker-compose.yml, then:
docker compose up -d
```

## Recommendations

!!! tip "Pin image tags"
    Use specific version tags (e.g., `ghcr.io/tobihochzwei/gitecho:0.2.1`) instead of `:latest` so upgrades and rollbacks are deliberate.

- **Back up the `/data` volume** off-host before major upgrades — the built-in snapshot is a safety net, not a substitute
- Watch the container logs for `[db] migrating vN → vN+1` lines on the first boot of a new image; absence means no migration ran
- The `/data` volume persists across upgrades, so all history, repos, and metadata survive
