# GitHub

## Required PAT Scopes

=== "Classic PAT"

    - **`repo`** (full) — needed to clone private repos
    - **`read:org`** — to list org-owned repos via `gh repo list`

    A single classic PAT sees every private repo your GitHub account has access to — your own repos, repos in orgs you belong to, and repos in other users' accounts where you're a collaborator.

    Create at: <https://github.com/settings/tokens>

=== "Fine-grained PAT"

    - Repository permissions → **Contents: Read** and **Metadata: Read**
    - Grant access to **all repositories** (or all in the target org) you want backed up

    !!! warning
        Fine-grained PATs are scoped to a **single resource owner** and don't support cross-account collaborator access. Use a classic PAT if you need to back up repos from multiple owners.

    Create at: <https://github.com/settings/tokens?type=beta>

## SAML SSO

If an organization enforces SAML SSO:

1. Open your token at <https://github.com/settings/tokens>
2. Click **Configure SSO** → **Authorize** for each org
3. Without this, the org's repos stay invisible to the PAT even though you personally have access

## Auto-Discovery

The GitHub provider discovers all repositories visible to the configured PAT via `gh repo list` and merges them with `repos.txt` entries (deduplicated by URL).

To back up only a curated subset, use a fine-grained PAT scoped to those specific repos, or use the allow/deny list filters on the **Settings → Providers** page.

## Configuration

Configure via **Settings → Providers → GitHub**:

1. Enter your PAT
2. Set the expiration date
3. Click **Test connection** to verify
4. Optionally configure discovery filters (allow/deny lists, visibility)
