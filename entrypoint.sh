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
    if [ ! -d "$d" ]; then
      echo "ERROR: $d is not a directory" >&2
      exit 1
    fi

    current_uid="$(stat -c '%u' "$d" 2>/dev/null || echo "")"
    current_gid="$(stat -c '%g' "$d" 2>/dev/null || echo "")"

    if [ "$current_uid" != "$GITECHO_UID" ] || [ "$current_gid" != "$GITECHO_GID" ]; then
      # Try recursive chown. Some NAS filesystems (Synology shared folders
      # with ACLs, SMB/NFS mounts) block chown even for root inside the
      # container - do NOT suppress the error, we want to see it.
      if ! chown -R "${GITECHO_UID}:${GITECHO_GID}" "$d"; then
        echo "Warning: chown of $d failed (filesystem likely blocks chown, common on Synology/SMB/NFS)." >&2
      fi
    fi

    # Verify the target directory is actually writable by the gitecho user.
    # Catches the case where chown failed silently AND the host UID/GID
    # don't match, which would otherwise blow up later inside the app.
    if ! gosu gitecho test -w "$d"; then
      cat >&2 <<EOF
ERROR: $d is not writable by the 'gitecho' user (uid=${GITECHO_UID}, gid=${GITECHO_GID}).

This usually happens on Synology / QNAP / other NAS systems where the
host directory's ownership cannot be changed from inside the container.

Fix: set PUID and PGID environment variables to match the host
directory's owner, so the container's 'gitecho' user is remapped to it.

  1. On the NAS host, check ownership of the mounted folder, e.g.:
       ls -ldn /volume1/docker/gitecho/config
     The first number after the permission bits is the UID, the second is the GID.

  2. Pass them into the container (docker-compose.yml):
       environment:
         PUID: "<that uid>"
         PGID: "<that gid>"

  3. Recreate the container:  docker compose up -d --force-recreate

Current directory ownership: uid=${current_uid} gid=${current_gid}
EOF
      exit 1
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
