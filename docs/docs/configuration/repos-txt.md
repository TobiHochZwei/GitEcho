# Repository List (`repos.txt`)

The file `/config/repos.txt` lets you pin repositories that auto-discovery can't see — repos in other orgs, repos accessible only via read-only tokens, or manual pins.

## Format

One repository URL per line. Blank lines and lines starting with `#` are ignored.

```text
# GitHub repos
https://github.com/octocat/Hello-World

# Azure DevOps repos
https://dev.azure.com/myorg/MyProject/_git/my-repo

# GitLab repos (nested groups supported)
https://gitlab.com/mygroup/my-repo
https://gitlab.com/mygroup/subgroup/my-repo
```

## Supported URL Forms

| Provider | URL Format |
|---|---|
| GitHub | `https://github.com/<owner>/<repo>` (with or without `.git`) |
| Azure DevOps | `https://dev.azure.com/<org>/<project>/_git/<repo>` |
| GitLab | `https://gitlab.com/<group>(/<subgroup>)*/<repo>` |

!!! note "Self-hosted GitLab"
    When `GITLAB_HOST` is set, URLs on that host are accepted instead of `gitlab.com`.

## Auto-Discovery vs. repos.txt

GitEcho's providers **auto-discover** repositories visible to the configured PAT:

| Provider | Discovery Method |
|---|---|
| GitHub | `gh repo list` |
| Azure DevOps | `az devops project list` + `az repos list` |
| GitLab | `GET /api/v4/projects?membership=true` (up to 5,000 projects) |

Discovered repos are merged with `repos.txt` entries (deduplicated by URL). The `repos.txt` file is only needed for repos that auto-discovery **can't** find.

### Auto-Clean

By default, GitEcho automatically removes `repos.txt` entries that are already discovered and present in the database. This keeps the file as a list of genuine extras. You can toggle this behavior under **Settings → Providers**.

## Managing via the UI

You can also add and remove repositories through the **Settings → Repositories** page (`/settings/repos`) without editing the file directly.
