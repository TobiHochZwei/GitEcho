# Azure DevOps

![Providers settings](../assets/screenshots/settings-providers.png)

## Required PAT Scopes

- **Code** → *Read* (clone and list Git repos; also covers reading TFVC items and changesets)
- **Project and Team** → *Read* (list all projects in the org)

Set **Organization** to *All accessible organizations* (or the specific one) when creating the PAT.

Create at: `https://dev.azure.com/<your-org>/_usersSettings/tokens`

## Multiple Organizations

Azure DevOps PATs are scoped to one organization at creation time. To back up repos from **additional orgs**:

- List them in `repos.txt` with their full URL:
  ```
  https://dev.azure.com/<other-org>/<project>/_git/<repo>
  ```
- The same PAT authenticates as long as it was issued with *All accessible organizations*

!!! note "Cross-tenant limitation"
    If the orgs live in different Entra tenants, create one PAT per tenant and run separate GitEcho instances.

## Auto-Discovery

The Azure DevOps provider discovers all repositories via `az devops project list` + `az repos list` and merges them with `repos.txt` entries.

Both **Git** and **TFVC** (Team Foundation Version Control) sources are supported. During discovery, any project that has **no Git repositories** is probed for TFVC content and, if found, registered as a TFVC root. Projects that already contain Git repos are not probed for TFVC by default — set `AZUREDEVOPS_TFVC_DISCOVER_ALL=true` to probe every project (one extra API call per project) for mixed Git + TFVC projects. You can also pin a TFVC source explicitly in `repos.txt` (see below).

Discovery can be disabled per provider via the **Auto-discover** checkbox on **Settings → Providers**.

## TFVC Support

TFVC sources are backed up as **latest-state snapshots**: GitEcho exports the current contents of a server path as a `.zip` into backup storage. This is a point-in-time content backup — it does **not** capture changeset history, labels, branch structure, or changeset metadata. The changeset id of the latest export is recorded as the snapshot's revision, and unchanged paths are skipped on subsequent runs.

TFVC sources use a GitEcho-internal identifier instead of a clone URL:

```
tfvc://dev.azure.com/<org>/<project>?path=$/<project>/<path>
```

Add one to `repos.txt` to back up a specific TFVC path (the `$/...` server path is URL-encoded automatically when discovered; when adding manually, a plain `$/Project/Main` path is accepted):

```
tfvc://dev.azure.com/contoso/PaymentsApp?path=$/PaymentsApp/Main
```

Snapshots are stored under `<provider>/<owner>/<name>/snapshots/` and are browsable from the repository's **Snapshots** action in the web UI. TFVC snapshots are always produced this way regardless of the configured `BACKUP_MODE` (which only governs Git repositories). Over time these accumulate — enable [snapshot retention](../backup-modes.md#snapshot-retention) to prune old TFVC snapshots automatically.

For the full design and roadmap (changeset-aware incremental mode, restore guidance), see [TFVC Support](../development/tfvc-implementation.md).

## Configuration

Configure via **Settings → Providers → Azure DevOps**:

1. Enter your PAT
2. Set the organization name (if not using auto-discovery from repos.txt)
3. Set the expiration date
4. Click **Test connection** to verify
5. Optionally configure discovery filters
