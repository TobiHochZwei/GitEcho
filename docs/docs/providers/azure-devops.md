# Azure DevOps

## Required PAT Scopes

- **Code** → *Read* (clone and list repos per project)
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

Discovery can be disabled per provider via the **Auto-discover** checkbox on **Settings → Providers**.

## Configuration

Configure via **Settings → Providers → Azure DevOps**:

1. Enter your PAT
2. Set the organization name (if not using auto-discovery from repos.txt)
3. Set the expiration date
4. Click **Test connection** to verify
5. Optionally configure discovery filters
