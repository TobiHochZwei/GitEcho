#!/bin/bash
set -e

echo "GitEcho starting..."

# Ensure directories exist
mkdir -p /data /config /backups

# Snapshot the SQLite database before launching, so a botched migration
# (or any other startup failure that corrupts state) is recoverable from
# the previous boot. Best-effort: a permission glitch must never block
# startup. Retains the 5 most recent snapshots.
if [ -f /data/gitecho.db ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp /data/gitecho.db "/data/gitecho.db.bak.${ts}" 2>/dev/null || true
  ls -1t /data/gitecho.db.bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

# Create default repos.txt if not exists
if [ ! -f /config/repos.txt ]; then
  echo "# Add repository URLs here, one per line" > /config/repos.txt
  echo "# Example: https://github.com/owner/repo" >> /config/repos.txt
fi

# Configure git for GH CLI auth
if [ -n "$GITHUB_PAT" ]; then
  echo "$GITHUB_PAT" | gh auth login --with-token 2>/dev/null || echo "Warning: GH CLI auth failed"
fi

# Configure Azure DevOps CLI auth
if [ -n "$AZUREDEVOPS_PAT" ]; then
  export AZURE_DEVOPS_EXT_PAT="$AZUREDEVOPS_PAT"
fi

echo "Starting background worker..."
node /app/dist/worker/index.mjs &
WORKER_PID=$!

echo "Starting web server on port 3000..."
node /app/dist/server/entry.mjs &
SERVER_PID=$!

# Handle shutdown
trap "echo 'Shutting down...'; kill $WORKER_PID $SERVER_PID 2>/dev/null; exit 0" SIGTERM SIGINT

echo "GitEcho is running."
wait -n
exit $?
