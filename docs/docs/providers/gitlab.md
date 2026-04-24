# GitLab

## Required PAT Scopes

- **`read_api`** — list projects the PAT is a member of
- **`read_repository`** — clone over HTTPS

No write scopes are needed.

Create at: <https://gitlab.com/-/user_settings/personal_access_tokens>

For self-hosted instances: `https://<your-host>/-/user_settings/personal_access_tokens`

## PAT Expiration

GitLab PATs can be created **without an expiration date**. If yours doesn't expire, leave the expiry field empty or set a far-future date. When an expiry is set, the same warning window controlled by `PAT_EXPIRY_WARN_DAYS` applies.

## Self-Hosted GitLab

Set `GITLAB_HOST` (or the **Host** field on Settings → Providers) to the hostname only:

```
GITLAB_HOST=gitlab.example.com
```

Discovery, cloning, and URL classification in `repos.txt` then target that host instead of `gitlab.com`.

## Nested Groups

URLs of the form `https://gitlab.com/group/subgroup/…/repo` are fully supported:

- The **owner** column shows the full group path
- The on-disk backup path becomes `/backups/gitlab/<group>/<subgroup>…/<repo>`

## Auto-Discovery

The GitLab provider discovers all projects the PAT is a member of via:

```
GET /api/v4/projects?membership=true
```

Paginated, supporting up to 5,000 projects. Nested groups are walked automatically — the full namespace path becomes the repo's owner.

## Configuration

Configure via **Settings → Providers → GitLab**:

1. Enter your PAT
2. Set the host (only for self-hosted instances, leave empty for gitlab.com)
3. Set the expiration date (optional)
4. Click **Test connection** to verify
5. Optionally configure discovery filters
