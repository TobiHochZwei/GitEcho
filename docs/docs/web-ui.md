# Web UI

GitEcho ships with a full-featured web interface built on **AdminLTE 4** (Bootstrap 5). It supports light and dark mode (toggle in the top bar, persisted in `localStorage`).

## Dashboard (`/`)

The main landing page shows an at-a-glance overview:

![Dashboard](assets/screenshots/dashboard.png)

- **Total repositories** being backed up
- **Last backup time** and current backup mode
- **Storage usage** (cached, refreshed after each backup run)
- **Most recent backup runs** with status summaries
- **Background color**: green when a successful backup occurred within the last 24 hours, light red otherwise
- **Unavailable Upstream** count and warning banner when any repository can't be reached

## Repositories (`/repos`)

Lists all known repositories with provider badge, last sync, status and per-repo actions.

![Repositories list](assets/screenshots/repos-list.png)

- Provider icon (GitHub, Azure DevOps, GitLab)
- Last sync time and status
- Per-repo actions:
    - **Browse** (option1) — navigate files in the Web UI
    - **ZIP archives** (option2 and option3) — list stored snapshots

### Repository detail (`/settings/repos/<id>`)

Per-repo configuration, notes, danger zone (archive / delete), and the most recent backup attempts.

![Repository detail](assets/screenshots/repo-detail.png)

## Backup Runs (`/runs`)

Chronological history of all backup runs.

![Runs list](assets/screenshots/runs-list.png)

Click a run to see the **per-run detail** (`/runs/<id>`) with every repository that was processed, including status, error messages, ZIP paths, and SHA-256 checksums.

=== "Successful run"

    ![Successful run](assets/screenshots/run-detail-success.png)

=== "Partial failure"

    ![Partial failure](assets/screenshots/run-detail-partial.png)

=== "Cancelled run"

    ![Cancelled run](assets/screenshots/run-detail-cancelled.png)

## Browse (`/browse/...`)

!!! note
    Only available for repositories using **option1** (git pull).

Read-only file and folder navigation of cloned repositories.

=== "Tree view"

    ![Browse — tree view](assets/screenshots/browse-option1-tree.png)

=== "File preview"

    ![Browse — file preview](assets/screenshots/browse-option1-file.png)

Features:

- Directory listing with file sizes and last-modified dates
- File content preview
- **Download as ZIP** — for individual files, folders, or the entire repository

## ZIP Archives (`/zips/...`)

!!! note
    Only available for repositories using **option2** or **option3**.

Lists all stored ZIP snapshots for a repository with file size, creation date and direct download links.

=== "option2"

    ![ZIPs — option2](assets/screenshots/zips-option2.png)

=== "option3"

    ![ZIPs — option3](assets/screenshots/zips-option3.png)

## Logs (`/logs`)

Live view of GitEcho's structured JSONL log (`/data/gitecho.log`).

![Log viewer](assets/screenshots/logs.png)

- **Filtering** by level (debug, info, warn, error), source (server, worker), and free-text search
- **Download** button for rotated log files

### Per-repo debug trace

When a repository's verbose `GIT_TRACE` toggle is enabled, every backup attempt produces a downloadable trace file under the repo detail page.

![Debug log viewer](assets/screenshots/debug-log-viewer.png)

## Settings

The Settings section (`/settings`) provides full configuration management:

| Page | Description |
|---|---|
| **Repositories** (`/settings/repos`) | Add/remove URLs, view source badges (discovered vs. extra), manage extras from `repos.txt` |
| **Repository Detail** (`/settings/repos/<id>`) | Per-repo status, notes, exclude toggle, verbose git trace toggle, debug trace downloads, last 20 backup attempts |
| **Providers** (`/settings/providers`) | Configure PATs, test connections, toggle auto-discovery, set allow/deny lists, manage blacklists |
| **SMTP** (`/settings/smtp`) | Configure email notifications, send test emails |
| **General** (`/settings/general`) | Change backup mode, edit cron schedule, trigger manual backup |
| **Account** (`/settings/account`) | Change admin password |

See [Settings UI reference](configuration/settings-ui.md) for a screenshot of every tab.
