# GitHub

![GitHub provider settings](../assets/screenshots/settings-providers-github.png)

## Creating the Token

GitEcho authenticates to GitHub with a **Personal Access Token (PAT)**. You can use a classic or a fine-grained PAT.

=== "Classic PAT (recommended)"

    1. Go to <https://github.com/settings/tokens> → **Generate new token** → **Generate new token (classic)**.
    2. Give it a name (e.g. `gitecho-backup`) and an expiration date.
    3. Select these scopes:
        - **`repo`** (full) — clone private repositories
        - **`read:org`** — read org membership (used when accessing org-owned repos)
    4. Click **Generate token** and copy the value (shown only once).
    5. Paste it into **Settings → Providers → GitHub** in GitEcho and click **Test connection**.

    Auto-discovery runs `gh repo list`, which returns the repositories **owned by the authenticated user** (including private ones). To back up repos owned by an organization or other users you collaborate with, pin them in [`repos.txt`](../configuration/repos-txt.md) — the `repo` scope still lets the PAT clone them.

=== "Fine-grained PAT"

    1. Go to <https://github.com/settings/tokens?type=beta> → **Generate new token**.
    2. Set a name, expiration, and the **Resource owner** (your account or the org).
    3. Under **Repository access**, choose **All repositories** (or select the specific repos you want backed up).
    4. Under **Permissions → Repository permissions**, set:
        - **Contents: Read**
        - **Metadata: Read** (granted automatically)
    5. Click **Generate token**, copy it, and paste it into **Settings → Providers → GitHub**.

    !!! warning
        Fine-grained PATs are scoped to a **single resource owner** and don't support cross-account collaborator access. Use a classic PAT if you need to back up repos from multiple owners.

## Required PAT Scopes

=== "Classic PAT"

    - **`repo`** (full) — needed to clone private repos
    - **`read:org`** — read org membership when accessing org-owned repos

    Create at: <https://github.com/settings/tokens>

=== "Fine-grained PAT"

    - Repository permissions → **Contents: Read** and **Metadata: Read**
    - Grant access to **all repositories** (or all in the target org) you want backed up

    Create at: <https://github.com/settings/tokens?type=beta>

## SAML SSO

If an organization enforces SAML SSO:

1. Open your token at <https://github.com/settings/tokens>
2. Click **Configure SSO** → **Authorize** for each org
3. Without this, the org's repos stay invisible to the PAT even though you personally have access

## Auto-Discovery

The GitHub provider discovers the repositories owned by the configured PAT's account via `gh repo list` and merges them with `repos.txt` entries (deduplicated by URL). Repos owned by organizations or other accounts can be added via `repos.txt`.

To back up only a curated subset, use a fine-grained PAT scoped to those specific repos, or use the allow/deny list filters on the **Settings → Providers** page.

## Configuration

Configure via **Settings → Providers → GitHub**:

1. Enter your PAT
2. Set the expiration date
3. Click **Test connection** to verify
4. Optionally configure discovery filters (allow/deny lists, visibility)
