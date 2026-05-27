# TFVC Support Draft

This document proposes a phased implementation to support Azure DevOps TFVC sources in GitEcho.

## Goal

Add backup support for TFVC repositories (Team Foundation Version Control) while preserving existing Git behavior and data model compatibility.

## Current State

GitEcho only discovers and backs up Git repositories from Azure DevOps.

- Discovery uses `az devops project list` and `az repos list`.
- Repository URLs are expected in Git format (`.../_git/...`).
- Backup engine executes `clone` and `pull` flows through provider plugins.

Result: TFVC-only projects are currently invisible to discovery and cannot be backed up.

## Proposed Scope

### Phase 1 (MVP): TFVC Snapshot Backups

Support latest-state snapshot backups for TFVC paths.

- Discover TFVC roots per project.
- Export workspace contents for each root into backup storage.
- Record backup metadata in existing run/item tables.
- Mark entries as TFVC in repository metadata so UI and APIs can differentiate from Git repos.

Out of scope for Phase 1:

- Full changeset history mirror.
- Label-aware restore workflows.
- Branch mapping semantics beyond root-path snapshots.

### Phase 2: Changeset-Aware Incremental Mode

- Track last exported changeset.
- Export only changed server paths since previous success.
- Optional periodic full snapshot compaction.

### Phase 3: Restore and UX Enhancements

- Restore guidance and helper operations.
- TFVC-focused run details (changesets included, server path, workspace mapping).
- Advanced include/exclude path filters.

## Discovery Design

### New Azure DevOps Discovery Strategy

Keep existing Git discovery as-is and add TFVC discovery in parallel.

1. List projects using current Azure org target.
2. For each project:
   - Keep `az repos list` for Git repos.
   - Add TFVC root discovery using Azure DevOps API/CLI calls that enumerate TFVC roots and folders.
3. Emit a normalized `RepositoryInfo`-like record for TFVC entries:
   - provider: `azuredevops`
   - owner: `<org>/<project>`
   - name: normalized TFVC root name
   - url: canonical TFVC identifier string (not `_git` URL)
   - extra metadata: source type `tfvc`, server path, project

### Canonical TFVC Identifier

Introduce a canonical identifier for TFVC rows to preserve uniqueness and avoid collisions with Git URLs.

Recommended format:

`tfvc://dev.azure.com/<org>/<project>?path=$/<teamProject>/<rootPath>`

This identifier is internal to GitEcho and should not be treated as a clone URL.

## Data Model Changes

### Repositories Table

Add fields:

- `vcs_type` (`git` | `tfvc`), default `git`
- `remote_path` (nullable): TFVC server path such as `$/Project/Main`

Migration notes:

- Append-only migration.
- Backfill existing rows with `vcs_type='git'`.

### Backup Items

Reuse existing status fields. Optional metadata additions for TFVC:

- `source_revision` (changeset id string/number)
- `artifact_kind` (`snapshot`, `incremental`)

## Provider Interface Evolution

Current interface is Git-centric (`cloneRepository`, `pullRepository`).

Proposed direction:

1. Keep current methods for Git providers.
2. Add an optional generic backup method:
   - `backupRepository(repo, targetDir, options): Promise<BackupProviderResult>`
3. Backup engine dispatch:
   - If plugin has generic method, use it.
   - Otherwise keep current Git path (clone/pull).

This avoids breaking existing providers and allows TFVC-specific operations.

## Backup Storage Layout

For TFVC Phase 1, store snapshots under:

`/backups/azuredevops/<org>/<project>/tfvc/<normalized-root>/snapshots/<timestamp>.zip`

Optional convenience pointer:

- `latest.zip` symlink/copy

## UI/API Impact

### Repository List

- Add badge for `vcs_type` (`Git` / `TFVC`).
- Display TFVC server path.
- Disable Git-specific actions where not applicable (for example branch-centric assumptions).

### Settings and Discovery

- Azure provider panel: add TFVC discovery toggle.
- Show discovery totals split by type:
  - Git discovered
  - TFVC discovered
  - filtered out

### Run Detail

- Show TFVC artifact path and (when available) changeset.

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

## Implementation Plan

1. Add schema migration for `vcs_type` and `remote_path`.
2. Extend repository model and API serialization.
3. Add TFVC discovery in Azure DevOps plugin.
4. Add provider generic backup method and engine dispatch.
5. Implement TFVC snapshot backup command flow.
6. Add UI badges/details for TFVC entries.
7. Add docs and troubleshooting guidance.
8. Add tests and fixture coverage.

## Test Plan

### Unit

- TFVC identifier normalization.
- Discovery parsing for TFVC roots.
- Engine dispatch for git vs tfvc rows.

### Integration

- Azure discovery returns mixed Git + TFVC projects.
- Backup run with TFVC entries creates snapshot artifacts and updates statuses.

### Regression

- Existing GitHub/GitLab/Azure Git flows unchanged.
- Existing backup modes still pass with Git-only data.

## Acceptance Criteria (Phase 1)

- TFVC projects are discovered and listed in repository UI.
- TFVC entries are backed up as snapshots on scheduled and manual runs.
- Run detail shows success/failure and artifact path for TFVC entries.
- No regression for existing Git backup behavior.