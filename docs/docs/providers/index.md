# Providers

GitEcho uses a **plugin architecture** for git providers. Each provider implements a common interface for repository discovery, cloning, and syncing — making it straightforward to add support for new providers in the future.

## Supported Providers

| Provider | CLI Tool | Discovery | Self-hosted |
|---|---|---|---|
| [GitHub](github.md) | `gh` (GitHub CLI) | `gh repo list` | :x: |
| [Azure DevOps](azure-devops.md) | `az` (Azure CLI + devops extension) | `az devops project list` + `az repos list` | :x: |
| [GitLab](gitlab.md) | REST API + `git` | `GET /api/v4/projects?membership=true` | :white_check_mark: |

## Common Features

All providers support:

- **Auto-discovery** — automatically finds repositories accessible to the PAT
- **PAT management** — configure via the Settings UI with inline scope guidance
- **Test connection** — one-click verification on the Providers settings page
- **PAT expiration tracking** — email warnings before tokens expire
- **Discovery filters** — allow/deny lists by owner/org, visibility filter, per-repo blacklist

## Provider-Specific Setup

Click a provider above for detailed PAT scope requirements and configuration instructions.
