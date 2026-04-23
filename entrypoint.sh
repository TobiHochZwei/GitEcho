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

  echo "Mount point ownership (host view, numeric):" >&2
  ls -ldn /data /config /backups 2>&1 | sed 's/^/  /' >&2 || true
  echo "Container gitecho user: uid=${GITECHO_UID} gid=${GITECHO_GID}" >&2

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

    # Real write probe: actually create + delete a file as the gitecho user.
    # `test -w` (access(W_OK)) is UNRELIABLE on Synology / NFSv4 ACL
    # filesystems because WRITE_DATA and ADD_FILE can be granted
    # separately - `test -w` can pass while `touch` still fails with
    # "Permission denied".
    probe=".gitecho-write-probe.$$"
    probe_err="$(gosu gitecho sh -c "touch '$d/$probe' && rm -f '$d/$probe'" 2>&1)" && probe_rc=0 || probe_rc=$?
    if [ "$probe_rc" != "0" ]; then
      {
        echo ""
        echo "ERROR: $d is not writable by the 'gitecho' user (uid=${GITECHO_UID}, gid=${GITECHO_GID})."
        echo "Probe result: touch '$d/$probe' -> ${probe_err:-(no stderr)}"
        echo ""
        echo "Ownership of all mount points (numeric):"
        ls -ldn /data /config /backups 2>&1 | sed 's/^/  /'
        echo ""
        echo "Listing of $d (a '+' in perms = ACL active):"
        ls -lan "$d" 2>&1 | sed 's/^/  /'
        echo ""
        echo "This usually happens on Synology / QNAP / other NAS systems"
        echo "where the host directory's ownership cannot be changed from"
        echo "inside the container."
        echo ""
        echo "Fix: set PUID and PGID env vars to match the host directory's"
        echo "owner, so the container's 'gitecho' user is remapped to it."
        echo ""
        echo "  1. On the NAS host, check ownership of the mounted folder:"
        echo "       ls -ldn /volume1/docker/gitecho/config"
        echo "     First number after perms = UID, second = GID."
        echo ""
        echo "  2. In docker-compose.yml:"
        echo "       environment:"
        echo "         PUID: \"<that uid>\""
        echo "         PGID: \"<that gid>\""
        echo ""
        echo "  3. Recreate:  docker compose up -d --force-recreate"
        echo ""
        echo "  If the path shows a '+' in the permission bits (Synology"
        echo "  ACL), also grant the host user full rights via DSM ->"
        echo "  Shared Folder -> Permissions, or on the NAS:"
        echo "     synoacltool -add <path> \"user:<user>:allow:rwxpdDaARWcCo:fd--\""
      } >&2
      exit 1
    fi
    unset probe_rc probe_err
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
