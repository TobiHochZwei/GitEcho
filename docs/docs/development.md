# Development

This guide covers local development setup, project structure, and contribution guidelines.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Match the Docker image (`node:22-bookworm-slim`) |
| npm | ≥ 10 | Ships with Node 22 |
| `git` | any recent | Used at runtime for cloning/pulling repos |
| GitHub CLI (`gh`) | ≥ 2.40 | Only needed for GitHub backups |
| Azure CLI (`az`) + `azure-devops` ext. | ≥ 2.50 | Only needed for Azure DevOps backups |
| `openssl` | any | To generate `MASTER_KEY` |

Optional:

- GitLab CLI (`glab`) — only used for boot probe and debugging; the REST API handles discovery
- A throwaway PAT for your target provider
- A test SMTP account (e.g., Mailtrap, Mailpit)

## First-Time Setup

```bash
git clone https://github.com/TobiHochZwei/GitEcho.git
cd GitEcho
npm install

# Create local mount points
mkdir -p .dev/{config,data,backups}
```

Create `.env.local` (loaded automatically by Astro, ignored by git):

```bash
cat > .env.local <<'EOF'
DATA_DIR=./.dev/data
CONFIG_DIR=./.dev/config
BACKUPS_DIR=./.dev/backups
BACKUP_MODE=option1
CRON_SCHEDULE=0 2 * * *
MASTER_KEY=
EOF

echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env.local
```

## Running in Development

GitEcho has **two processes** — run them in separate terminals:

### Terminal 1 — Web UI

```bash
npm run dev
```

Serves the UI at <http://localhost:3000> with hot module replacement.

On first boot, GitEcho bootstraps an `admin` / `admin` account. To reset during development, delete `.dev/config/secrets.json` and reload.

### Terminal 2 — Background Worker

```bash
npm run worker:dev
```

Runs `worker/index.ts` directly through `tsx`. To trigger an immediate backup:

```bash
CRON_SCHEDULE='*/1 * * * *' npm run worker:dev   # every minute
```

Or use the **Settings → General → Run backup** button in the UI.

### Production-Style Local Build

```bash
npm run build
npm start         # web server on port 3000
npm run worker    # background scheduler
```

## Static Checks

```bash
npx astro check       # TypeScript + Astro template diagnostics
npm run build         # full production build (Astro + worker via esbuild)
```

There are currently **no automated tests**. The `check` + `build` combo is the canonical "did I break anything" gate before opening a PR.

## Project Layout

```
src/
  layouts/Layout.astro          AdminLTE 4 shell (sidebar + topbar + dark mode)
  middleware.ts                 Session-cookie auth + Origin-based CSRF
  components/                   Reusable Astro components
  scripts/                      Client-side TS bundled by Astro
    theme.ts                    Dark-mode toggle
    sidebar.ts                  Sidebar collapse + treeview
    toasts.ts                   Bootstrap toast helper
    format.ts                   Shared formatters
  lib/
    config.ts                   Layered loader (env < settings < secrets)
    secrets.ts                  AES-256-GCM helpers
    settings.ts                 settings.json + secrets.json read/write
    backup-lock.ts              Cross-process file mutex
    database.ts                 SQLite schema + CRUD
    stats.ts                    Extended dashboard stats + storage usage
    scheduler.ts                node-cron entry point
    logger.ts                   Structured JSONL logger
    backup/engine.ts            The actual backup runner
    plugins/
      register.ts               Plugin registration
      interface.ts              ProviderPlugin interface
      github.ts                 GitHub provider
      azuredevops.ts            Azure DevOps provider
      gitlab.ts                 GitLab provider
    repos-file.ts               repos.txt parser/writer
  pages/
    index.astro                 Dashboard
    repos.astro                 Repository list
    runs.astro                  Backup runs
    logs.astro                  Log viewer
    runs/[id].astro             Per-run detail
    browse/[...path].astro      File browser (option1)
    zips/[...path].astro        ZIP archive list (option2/3)
    settings/                   Settings UI pages
    api/                        JSON endpoints
worker/index.ts                 Worker process entry
build-worker.mjs                esbuild bundle for the worker
```

## Plugin Architecture

Each provider implements the `ProviderPlugin` interface:

```typescript
interface ProviderPlugin {
  readonly name: string;
  readonly displayName: string;
  isConfigured(): boolean;
  authenticate(): Promise<boolean>;
  listRepositories(): Promise<RepositoryInfo[]>;
  cloneRepository(repoUrl: string, targetDir: string): Promise<void>;
  pullRepository(repoDir: string): Promise<void>;
  getAuthenticatedUrl(repoUrl: string): string;
}
```

Plugins are registered in `src/lib/plugins/register.ts` and accessed via the singleton `PluginRegistry`.

## Database Migrations

GitEcho uses SQLite with a versioned migration system tracked by `PRAGMA user_version`.

### Adding a Migration

Append a function to the `MIGRATIONS` array in `src/lib/database.ts`:

```typescript
const MIGRATIONS: ReadonlyArray<(instance: DatabaseInstance) => void> = [
  // v0 → v1
  (instance) => instance.exec(`CREATE INDEX idx_items_run ON backup_items(run_id)`),
  // v1 → v2
  (instance) => instance.exec(`ALTER TABLE repositories ADD COLUMN labels TEXT`),
];
```

**Rules:**

- **Append-only** — never edit, reorder, or delete a shipped migration
- **Don't duplicate** what `SCHEMA` or legacy helpers already do
- **One concern per migration** — keep rollbacks meaningful
- **Update `SCHEMA`** in the same PR so fresh installs get the new shape directly

### Destructive Changes

SQLite can't `DROP COLUMN` portably. Use the 4-step recipe:

```typescript
(instance) => instance.exec(`
  CREATE TABLE backup_items_new (...new shape...);
  INSERT INTO backup_items_new (...) SELECT ... FROM backup_items;
  DROP TABLE backup_items;
  ALTER TABLE backup_items_new RENAME TO backup_items;
`);
```

## UI / Theme Notes

- Built on **AdminLTE 4** (Bootstrap 5)
- **Dark mode** via Bootstrap 5's `data-bs-theme` on `<html>`, persisted in `localStorage`
- **Toasts** via `window.gitechoToast(message, variant)` — variants: `success | danger | warning | info`
- **Adding a sidebar item**: edit `src/components/Sidebar.astro`
- **Adding a dashboard widget**: extend `src/lib/stats.ts`, add a `<SmallBox>` or `<Card>` to `index.astro`
- **AdminLTE version**: pinned to `admin-lte@4.0.0-rc7`
