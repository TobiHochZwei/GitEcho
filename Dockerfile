FROM node:22-bookworm-slim AS base

# Install git and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    gosu \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Azure DevOps CLI (via azure-cli + devops extension)
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && az extension add --name azure-devops \
    && rm -rf /var/lib/apt/lists/*

# Install GitLab CLI (glab). The project publishes .deb packages per release
# on gitlab.com/gitlab-org/cli/-/releases. We pull the latest stable via the
# official install script so upgrades happen at image-build time.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) glab_arch='amd64' ;; \
        arm64) glab_arch='arm64' ;; \
        *) echo "Unsupported arch for glab: $arch" >&2; exit 1 ;; \
    esac; \
    glab_ver="$(curl -fsSL https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1 | sed -n 's/.*"tag_name":"v\([^"]*\)".*/\1/p' | head -n1)"; \
    if [ -z "$glab_ver" ]; then \
        glab_ver='1.70.0'; \
    fi; \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${glab_ver}/downloads/glab_${glab_ver}_linux_${glab_arch}.tar.gz" \
        -o /tmp/glab.tgz; \
    tar -xzf /tmp/glab.tgz -C /tmp; \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab; \
    rm -rf /tmp/glab.tgz /tmp/bin /tmp/LICENSE /tmp/README.md 2>/dev/null || true; \
    glab --version

WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Build
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production
FROM base AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY entrypoint.sh ./

# Create mount point directories
RUN mkdir -p /data /config /backups && \
    chmod +x /app/entrypoint.sh

# Create non-root user (entrypoint drops privileges via gosu after fixing
# mount-point ownership, so we intentionally do NOT set USER here).
RUN groupadd -r gitecho && useradd -r -g gitecho -d /app gitecho && \
    chown -R gitecho:gitecho /app /data /config /backups

EXPOSE 3000

VOLUME ["/data", "/config", "/backups"]

ENTRYPOINT ["/app/entrypoint.sh"]
