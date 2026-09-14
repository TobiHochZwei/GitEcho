#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" || "$1" == -* ]]; then
  echo "Usage: EXPECTED_ARCH=amd64|arm64 $0 IMAGE" >&2
  exit 2
fi

image="$1"
expected_arch="${EXPECTED_ARCH:-}"
case "$expected_arch" in
  ''|amd64|arm64) ;;
  *) echo "EXPECTED_ARCH must be amd64 or arm64" >&2; exit 2 ;;
esac

command -v docker >/dev/null || { echo "Docker is required for container smoke tests" >&2; exit 1; }
docker info >/dev/null

image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
case "$image_platform" in
  linux/amd64|linux/arm64) ;;
  *) echo "Unsupported image platform: $image_platform" >&2; exit 1 ;;
esac
if [[ -n "$expected_arch" && "$image_platform" != "linux/$expected_arch" ]]; then
  echo "Expected linux/$expected_arch image, got $image_platform" >&2
  exit 1
fi
expected_arch="${image_platform#linux/}"

container_id=''
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$container_id" ]]; then
    if [[ "$status" -ne 0 ]]; then
      echo "Container smoke failed (exit $status): $container_id" >&2
      docker inspect --format '{{json .State}}' "$container_id" >&2 || true
      docker logs --tail 200 "$container_id" >&2 || true
    fi
    if ! docker rm --force --volumes "$container_id" >/dev/null; then
      echo "Failed to remove smoke container $container_id" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Seed only disposable settings, then let the unchanged entrypoint fix ownership
# and drop privileges before launching the application.
container_id="$(docker create \
  --network none \
  --tmpfs /data:rw,nosuid,nodev,size=64m \
  --tmpfs /config:rw,nosuid,nodev,size=16m \
  --tmpfs /backups:rw,nosuid,nodev,size=64m \
  --env MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --env RUN_BACKUP_ON_START=false \
  --env TZ=UTC \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --entrypoint /bin/sh \
  "$image" -ec 'printf "%s\n" "{\"cronEnabled\":false,\"runBackupOnStart\":false}" > /config/settings.json; exec /app/entrypoint.sh')"
docker start "$container_id" >/dev/null
echo "Checking $image ($image_platform), container $container_id"

docker exec -i --user gitecho --workdir /app "$container_id" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:3000/login', {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `Unexpected /login status: ${response.status}`);
    assert.match(body, /<title>Sign in[^<]*GitEcho<\/title>/);
    assert.match(body, /<form\b[^>]*\bid="login-form"/);
    console.log('/login returned 200 with the GitEcho sign-in form');
    break;
  } catch (error) {
    console.error(`Readiness attempt ${attempt}/30: ${error.message}`);
    if (attempt === 30) throw error;
    await sleep(1000);
  }
}
NODE

docker exec -i --user gitecho --workdir /app \
  --env "EXPECTED_ARCH=$expected_arch" "$container_id" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';

const deadline = setTimeout(() => {
  console.error('Production dependency smoke timed out');
  process.exit(1);
}, 30000);
deadline.unref();

assert.equal(process.platform, 'linux');
assert.equal(process.versions.node.split('.')[0], '24');
assert.equal(process.arch, process.env.EXPECTED_ARCH === 'amd64' ? 'x64' : 'arm64');
assert.notEqual(process.getuid(), 0, 'Dependency smoke must run as gitecho, not root');

function checkProcess(pid, expectedParent) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const uids = status.match(/^Uid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
  assert.deepEqual(uids, Array(4).fill(process.getuid()), `PID ${pid} must run as gitecho`);
  assert.doesNotMatch(status, /^State:\s+[ZX]/m, `PID ${pid} is not alive`);
  if (expectedParent !== undefined) {
    assert.equal(Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]), expectedParent);
  }
}

function checkAppProcesses() {
  checkProcess(1);
  assert.ok(readFileSync('/proc/1/cmdline', 'utf8').split('\0').includes('/app/entrypoint.sh'));
  const children = new Map();
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let args;
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    for (const entry of ['/app/dist/server/entry.mjs', '/app/dist/worker/index.mjs']) {
      if (args.includes(entry)) {
        checkProcess(pid, 1);
        children.set(entry, pid);
      }
    }
  }
  assert.equal(children.size, 2, 'Both the web server and worker must be live PID 1 children');
  console.log(`Non-root entrypoint, server, and worker verified (UID ${process.getuid()})`);
}
checkAppProcesses();

const path = '/data/container-smoke.sqlite';
const database = new Database(path);
try {
  database.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
  database.prepare('INSERT INTO smoke (value) VALUES (?)').run('native persistence');
} finally {
  database.close();
}
const reopened = new Database(path, { readonly: true, fileMustExist: true });
try {
  assert.deepEqual(reopened.prepare('SELECT value FROM smoke').all(), [{ value: 'native persistence' }]);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
} finally {
  reopened.close();
}
console.log('Native better-sqlite3 write, close, reopen, read, and integrity check passed');

const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
try {
  const result = await transport.sendMail({
    from: 'smoke@example.invalid',
    to: 'sink@example.invalid',
    subject: 'GitEcho container smoke',
    text: 'Generated in memory; never sent.',
  });
  assert.ok(Buffer.isBuffer(result.message));
  const message = result.message.toString('utf8');
  assert.match(message, /Subject: GitEcho container smoke/);
  assert.match(message, /Generated in memory; never sent\./);
} finally {
  transport.close();
}
console.log('Production Nodemailer import and in-memory message generation passed');
checkAppProcesses();
clearTimeout(deadline);
NODE

test "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true
echo "Container smoke passed: $image ($image_platform)"
