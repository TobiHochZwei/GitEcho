FROM node:22-bookworm-slim AS base

# Install git and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    gosu \
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
