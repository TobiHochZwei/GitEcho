# Backup Modes

GitEcho supports three backup strategies, selectable via the `BACKUP_MODE` environment variable or the **Settings → General** page. Each mode trades off between simplicity, storage efficiency, and revision safety.

## Option 1 — Git Pull (Default)

```
BACKUP_MODE=option1
```

The simplest and most storage-efficient mode. GitEcho clones each repository on the first run and performs `git pull` on subsequent runs.

**How it works:**

- First run: `git clone` into `/backups/<provider>/<owner>/<repo>/`
- Subsequent runs: `git pull` to fetch the latest changes
- The Web UI **Browse** feature lets you navigate files and download ZIPs of any file, folder, or the entire repo

**Pros:**

- :white_check_mark: Minimal storage — only one copy of each repo
- :white_check_mark: Fast incremental updates
- :white_check_mark: Full git history preserved
- :white_check_mark: Browse files directly in the Web UI

**Cons:**

- :x: Force-pushes upstream can rewrite history in the local clone
- :x: No point-in-time snapshots

**Best for:** Personal backups where you trust the upstream history and want fast, lightweight backups.

=== "Browse the working tree"

    ![Browse — option1 tree](assets/screenshots/browse-option1-tree.png)

=== "Preview a file"

    ![Browse — option1 file](assets/screenshots/browse-option1-file.png)

---

## Option 2 — Deduplicated ZIP Archives

```
BACKUP_MODE=option2
```

Every backup cycle produces a ZIP archive of the repository. Deduplication via SHA-256 checksum ensures only changed snapshots are kept.

**How it works:**

1. Clone or pull the repo to a temporary location
2. Create a ZIP archive of the repository
3. Compute SHA-256 of the new ZIP
4. If the checksum matches the previous run → discard the new ZIP (no changes)
5. If different → store as `/backups/<provider>/<owner>/<repo>/zips/<repo>_<timestamp>.zip`

**Pros:**

- :white_check_mark: Point-in-time snapshots for every change
- :white_check_mark: Storage-efficient — identical snapshots are deduplicated
- :white_check_mark: Download any snapshot from the Web UI

**Cons:**

- :x: More storage than option1 (accumulates snapshots over time)
- :x: No Browse feature in the Web UI (use ZIP archives page instead)

**Best for:** When you need an audit trail of repository changes over time.

![ZIP archives — option2](assets/screenshots/zips-option2.png)

---

## Option 3 — Mirror + ZIP Snapshots

```
BACKUP_MODE=option3
```

The strongest revision-safety mode. Maintains a bare git mirror **and** produces ZIP snapshots on every cycle.

**How it works:**

- **Bare mirror:** `git clone --mirror` into `/backups/<provider>/<owner>/<repo>/clone/`
    - Auto-GC disabled (`gc.auto = 0`) so unreachable commits survive force-pushes
    - Remote URL refreshed on each cycle (PAT-rotation safe)
    - Updated with `git remote update --prune`
- **ZIP snapshots:** `git archive HEAD` produces a ZIP, deduplicated by SHA-256 (same as option2)
    - Stored at `/backups/<provider>/<owner>/<repo>/zips/<repo>_<timestamp>.zip`

**Pros:**

- :white_check_mark: Maximum revision safety — even force-pushed commits are preserved in the mirror
- :white_check_mark: Every branch, tag, and note backed up
- :white_check_mark: Point-in-time ZIP snapshots for easy restore
- :white_check_mark: PAT rotation safe (URL refreshed each cycle)

**Cons:**

- :x: Approximately double the storage of option1 (mirror + ZIPs)
- :x: No Browse feature in the Web UI (bare mirror has no working tree)

**Best for:** Production and compliance environments where no data loss is acceptable, even after upstream force-pushes.

![ZIP archives — option3](assets/screenshots/zips-option3.png)

---

## Comparison

| Feature | Option 1 | Option 2 | Option 3 |
|---|:---:|:---:|:---:|
| **Storage usage** | :green_circle: Low | :yellow_circle: Medium | :red_circle: High |
| **Incremental updates** | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| **Force-push safe** | :x: | :x: | :white_check_mark: |
| **Point-in-time snapshots** | :x: | :white_check_mark: | :white_check_mark: |
| **Browse in Web UI** | :white_check_mark: | :x: | :x: |
| **ZIP archive downloads** | Via Browse | :white_check_mark: | :white_check_mark: |
| **All branches & tags** | :white_check_mark: | :x: (HEAD only) | :white_check_mark: (mirror) |

## Changing Modes

You can change the backup mode at any time via **Settings → General** or by updating the `BACKUP_MODE` environment variable. The next backup cycle will use the new mode. Existing backups from the previous mode are **not** deleted automatically.

## Snapshot Retention

Modes that accumulate timestamped artifacts — **option2** ZIP archives, **option3** ZIP snapshots (`zips/`) and **TFVC** snapshots (`snapshots/`) — can grow without bound. The optional retention policy applies tiered grandfather-father-son pruning so old snapshots are removed automatically:

- **Daily** — keep all snapshots newer than N days
- **Monthly** — keep the newest snapshot per calendar month, for the most recent N months that contain snapshots
- **Yearly** — keep the newest snapshot per calendar year, for the most recent N years that contain snapshots

A snapshot is kept if it matches **any** enabled tier. The most recent snapshot per repository is always kept (this is the snapshot matching the repository's current checksum, since a new snapshot is only written when content changes). Pruning runs at the end of every backup cycle, including manual runs — note that even a single-repository manual backup performs a **global** sweep across all repositories.

Retention does **not** touch option1 git working trees or the option3 git mirror (`clone/`); only timestamped `.zip` snapshots are eligible.

Retention is **opt-in** and disabled by default (all tiers `0` = keep everything). Configure it under **Settings → General** or via the `BACKUP_RETENTION_DAILY_DAYS`, `BACKUP_RETENTION_MONTHLY_COUNT`, and `BACKUP_RETENTION_YEARLY_COUNT` environment variables. See [Environment Variables](configuration/environment-variables.md) for details.

!!! warning
    Reducing retention values deletes more snapshots on the next run, and deletions are permanent.

