#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# Root phase: fix mount-point ownership, optionally remap UID/GID, then
# re-exec ourselves as the unprivileged `gitecho` user via gosu.
#
# This is required because Docker bind mounts inherit host ownership and
# ignore the image-time chown, which previously caused:
#   /app/entrypoint.sh: line 21: /config/repos.txt: Permission denied
# ---------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  # Optional PUID/PGID remap (LinuxServer.io convention) so bind-mounted
  # host directories stay accessible from the host as the invoking user.
  if [ -n "${PGID:-}" ] && [ "${PGID}" != "$(id -g gitecho)" ]; then
    groupmod -o -g "${PGID}" gitecho
  fi
  if [ -n "${PUID:-}" ] && [ "${PUID}" != "$(id -u gitecho)" ]; then
    usermod -o -u "${PUID}" gitecho
  fi

  GITECHO_UID="$(id -u gitecho)"
  GITECHO_GID="$(id -g gitecho)"

  for d in /data /config /backups; do
    mkdir -p "$d" 2>/dev/null || true
    if [ -d "$d" ]; then
      current_uid="$(stat -c '%u' "$d" 2>/dev/null || echo "")"
      if [ "$current_uid" != "$GITECHO_UID" ]; then
        if ! chown -R "${GITECHO_UID}:${GITECHO_GID}" "$d" 2>/dev/null; then
          if [ "$d" = "/data" ]; then
            echo "ERROR: cannot chown $d and the SQLite database lives there. Aborting." >&2
            exit 1
          else
            echo "Warning: could not chown $d (read-only mount?). Continuing." >&2
          fi
        fi
      fi
    fi
  done

  # Re-exec as gitecho. `exec` replaces this shell so gosu's child becomes
  # PID 1's direct successor, preserving signal delivery to the trap below.
  exec gosu gitecho:gitecho "$0" "$@"
fi

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
