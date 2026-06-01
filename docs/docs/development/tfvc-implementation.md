# TFVC Support

This document describes GitEcho's support for Azure DevOps TFVC sources. **Phases
1–3 are implemented and shipped:** latest-state snapshot backups (Phase 1),
changeset history metadata capture (Phase 2), and restore guidance plus
TFVC-focused run details (Phase 3).

## Goal

Add backup support for TFVC repositories (Team Foundation Version Control) while
preserving existing Git behavior and data model compatibility.

## Background

Before Phase 1, GitEcho only discovered and backed up Git repositories from
Azure DevOps.

- Discovery uses `az devops project list` and `az repos list`.
- Git repository URLs are expected in Git format (`.../_git/...`).
- The backup engine executes `clone` and `pull` flows through provider plugins.

That left TFVC-only projects invisible to discovery and impossible to back up.

> **Why snapshots, not `tf.exe`?** The official TFVC CLI (`tf.exe`) is
> Windows/Visual Studio bound and requires a workspace mapped to a local
> folder, which does not fit a containerized Linux backup tool. GitEcho instead
> uses the Azure DevOps **REST API** (`_apis/tfvc/items` for content,
> `_apis/tfvc/changesets` for revision tracking), which works headless with a
> PAT. The trade-off: a snapshot captures current content only, not full
> server-side history. See **Fidelity & Limitations** below.

## Scope

### Phase 1 (shipped): TFVC Snapshot Backups

Latest-state snapshot backups for TFVC paths.

- Discover TFVC roots per project (for projects with no Git repos; opt-in for
  all projects via `AZUREDEVOPS_TFVC_DISCOVER_ALL`).
- Export server-path contents for each root into backup storage as a `.zip`.
- Record backup metadata in the existing run/item tables (`source_revision`,
  `artifact_kind`).
- Mark entries as TFVC in repository metadata (`vcs_type`) so UI and APIs can
  differentiate from Git repos.
- Skip re-export when the latest changeset is unchanged since the last success.

Not included in Phase 1:

- Full changeset history mirror.
- Label-aware restore workflows.
- Branch mapping semantics beyond root-path snapshots.

## Fidelity & Limitations

A Git backup in GitEcho is a full mirror (complete history). A TFVC Phase 1
backup is a **latest-state snapshot** and therefore does **not** capture:

- Changeset history (prior versions of files).
- Labels (the TFVC equivalent of tags / named restore points).
- Branch structure and branch relationships.
- Changeset metadata beyond the latest revision id.

It is suitable for recovering current source. Phase 2 narrows part of this gap
by recording the changeset history *metadata* alongside each snapshot.

### Phase 2 (shipped): Changeset Metadata Capture

Phase 2 keeps the full-tree snapshot model but enriches each backup with the
**changeset history that produced it**, so operators can see *what changed*
without parsing the archive.

- For every real export, query the changesets between the previously recorded
  `source_revision` and the current latest changeset for the server path.
- Store that history as JSON on the backup item: the latest changeset (id,
  author, comment, date) plus the list of changesets since the last successful
  snapshot and their count.
- Surface this metadata in the UI (see Phase 3 run detail).

> **How it builds on Phase 1:** each successful snapshot records the latest
> changeset id (`source_revision`). Before downloading, a backup compares the
> current latest changeset against the last successful one and skips the export
> when unchanged. Phase 2 adds the per-snapshot changeset *history* on top of
> that single-revision marker.

The full-tree download (`recursionLevel=Full`) and the `snapshot` artifact kind
are retained — Phase 2 does **not** change how content is stored.

> **Not planned:** true per-path *incremental* export (downloading only the
> changed paths into a separate `incremental` artifact) was considered but is
> intentionally out of scope. It complicates restore semantics (a backup would
> no longer be self-contained) for little benefit given the changeset-aware
> skip already avoids redundant full exports. The `artifact_kind` column still
> reserves `incremental` should this be revisited.

### Phase 3 (shipped): Restore and UX Enhancements

- **Restore guidance** — documented steps for extracting a TFVC snapshot and
  returning it to a TFVC workspace (see the
  [Azure DevOps provider page](../providers/azure-devops.md#restoring-a-tfvc-snapshot)).
- **TFVC-focused run details** — the run detail page renders the Phase 2
  changeset metadata: how many changesets the snapshot includes, the latest
  changeset's author/comment/date, and a collapsible list of the included
  changesets alongside the server path.

> **Not planned:** advanced include/exclude path filters for TFVC exports. The
> snapshot always captures the full server path; scoping is done by pinning a
> narrower `$/Project/Path` in `repos.txt` instead.

## Discovery Design

### Azure DevOps Discovery Strategy (as built)

Git discovery is unchanged; TFVC discovery runs alongside it.

1. List projects using the current Azure org target.
2. For each project:
   - Keep `az repos list` for Git repos.
   - Probe for TFVC content via `az devops invoke --area tfvc --resource items`
     (`recursionLevel=None` on `$/<project>`). By default this runs only when
     the project has **no Git repositories**; set
     `AZUREDEVOPS_TFVC_DISCOVER_ALL=true` to probe every project.
   - TFVC sources can also be pinned explicitly in `repos.txt`.
3. Emit a normalized `RepositoryInfo` record for TFVC entries:
   - provider: `azuredevops`
   - owner: `<org>/<project>`
   - name: last segment of the server path (falls back to project name)
   - url: canonical TFVC identifier string (not a `_git` URL)
   - `vcsType: 'tfvc'`, `remotePath: $/<project>/<path>`

### Canonical TFVC Identifier

TFVC rows use a canonical, GitEcho-internal identifier to preserve uniqueness
and avoid collisions with Git URLs:

`tfvc://dev.azure.com/<org>/<project>?path=$/<project>/<rootPath>`

The server path is URL-encoded in the stored identifier. This identifier is
internal to GitEcho and must not be treated as a clone URL. Parsing and building
are centralized in `src/lib/tfvc-identifier.ts`.

## Data Model Changes

### Repositories Table

Add fields:

- `vcs_type` (`git` | `tfvc`), default `git`
- `remote_path` (nullable): TFVC server path such as `$/Project/Main`

Migration notes:

- Append-only migration.
- Backfill existing rows with `vcs_type='git'`.

### Backup Items

TFVC metadata stored on each backup item:

- `source_revision` (latest changeset id captured for the snapshot)
- `artifact_kind` (`snapshot`; `incremental` reserved, see Phase 2 note)
- `source_metadata` (nullable JSON): the changeset history for the snapshot,
  captured in Phase 2. Shape:

```json
{
  "latest": { "id": "47", "author": "Jane Dev", "comment": "Fix build", "date": "2026-05-31T10:12:00Z" },
  "changesets": [
    { "id": "47", "author": "Jane Dev", "comment": "Fix build", "date": "2026-05-31T10:12:00Z" },
    { "id": "46", "author": "Sam Ops", "comment": "Bump deps", "date": "2026-05-30T18:03:00Z" }
  ],
  "count": 2
}
```

  `changesets` lists the changesets between the previously recorded
  `source_revision` and the current latest changeset (newest first); `count` is
  their number. The column is `git`-agnostic and stays `NULL` for Git backups.

Migration notes:

- Append-only migration (add `source_metadata TEXT`).
- Existing rows remain `NULL`; no backfill required.

## Engine Dispatch (as built)

The backup engine branches on `vcsType` rather than introducing a generic
plugin method. When a repository row has `vcsType === 'tfvc'`, the engine calls
`backupTfvcSnapshot(...)` directly and records the result; otherwise it follows
the existing Git clone/pull path. The provider plugin interface gained only two
optional fields — `vcsType` and `remotePath` on `RepositoryInfo` — so existing
Git providers are unaffected.

> A generic `backupRepository(repo, targetDir, options)` plugin method was
> considered but not adopted for Phase 1; the single TFVC branch was simpler.
> It remains an option if more non-Git source types are added later.

## Backup Storage Layout (as built)

TFVC snapshots are stored under the same per-repository tree as other artifacts:

`<backupsDir>/azuredevops/<owner>/<name>/snapshots/<name>_<timestamp>.zip`

where `<owner>` is `<org>/<project>`. There is no separate `tfvc/` path segment
and no `latest.zip` pointer; the most recent snapshot is determined by
timestamp. The web UI exposes these via the repository's **Snapshots** action.

TFVC snapshots are produced on every backup cycle regardless of the configured
`BACKUP_MODE` (that setting only governs how Git repositories are stored). To
keep snapshot storage bounded, these `snapshots/` directories are subject to the
[tiered retention policy](../backup-modes.md#snapshot-retention) — the same GFS
pruning applied to option2/option3 ZIP snapshots. Retention is opt-in and
disabled by default. The single newest snapshot per repository is always kept
(it is the one matching the repository's current checksum, since a new snapshot
is only written when content changes).

## UI/API Impact

### Repository List

- Add badge for `vcs_type` (`Git` / `TFVC`).
- Display TFVC server path.
- Disable Git-specific actions where not applicable (for example branch-centric assumptions).

### Settings and Discovery

- TFVC discovery for non-Git projects is on by default; the
  `AZUREDEVOPS_TFVC_DISCOVER_ALL` env flag extends probing to all projects.
- A per-type discovery breakdown in the UI (Git vs TFVC vs filtered) is not yet
  implemented — planned.

### Run Detail

- Show the TFVC artifact path and latest changeset (`source_revision`) — shipped.
- Render the `source_metadata` changeset history — how many changesets the
  snapshot includes, the latest changeset's author/comment/date, and a
  collapsible list of the included changesets — shipped.

## Filtering Behavior

Keep existing owner/visibility filters for Git entries.

For TFVC entries:

- Owner filters still apply (`<org>/<project>`).
- Visibility filter should not drop TFVC entries by default, because TFVC visibility mapping is not equivalent to Git private/public.

## Security and Permissions

Azure PAT requirements for TFVC must include read access to version control paths and project metadata.

Implementation requirements:

- Continue secret redaction in logs.
- Never log PATs or raw auth headers.
- Return actionable, non-secret errors for permission failures.

## Compatibility and Risks

### Compatibility

- Existing Git providers and backups remain unchanged.
- Existing database rows remain valid.

### Risks

- TFVC API/CLI behavior may vary across Azure DevOps Server vs Azure DevOps Services.
- Large TFVC trees can create heavy snapshot artifacts.
- Path encoding and special characters need normalization rules.

Mitigations:

- Feature flag for TFVC discovery and backup path.
- Size/time telemetry in run logs.
- Conservative defaults (snapshot-only first).

## Implementation Status (Phase 1)

- [x] Schema migration for `vcs_type` and `remote_path` (and
      `source_revision` / `artifact_kind` on backup items).
- [x] Repository model and API serialization extended.
- [x] TFVC discovery in the Azure DevOps plugin.
- [x] Engine dispatch on `vcsType` to the TFVC snapshot flow.
- [x] TFVC snapshot backup implementation (`src/lib/backup/tfvc.ts`).
- [x] UI badges/details for TFVC entries (repo list, run detail, settings).
- [x] Docs and provider guidance.
- [x] Unit and integration tests (`tests/unit/tfvc-*.test.ts`).

Deferred to later phases: per-path incremental export, label/branch capture,
restore tooling, per-type discovery breakdown in the UI.

## Test Plan

### Unit (implemented)

- TFVC identifier parse / build / normalization round-trips.
- `tfvcDisplayName` and `safeTfvcName` edge cases.

### Integration (implemented)

- Snapshot download writes a `.zip` and records the changeset revision.
- Checksum/changeset dedup skips re-export when unchanged.
- `401/403/404` responses map to `unavailable`.
- A JSON response instead of an archive is reported as a failure.

### Regression

- Existing GitHub/GitLab/Azure Git flows unchanged.
- Existing backup modes still pass with Git-only data.

Run the suite with `npm test`.

## Acceptance Criteria (Phase 1) — met

- [x] TFVC projects are discovered and listed in the repository UI.
- [x] TFVC entries are backed up as snapshots on scheduled and manual runs.
- [x] Run detail shows success/failure and artifact path for TFVC entries.
- [x] No regression for existing Git backup behavior.