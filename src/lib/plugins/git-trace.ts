/**
 * Per-repository verbose git tracing.
 *
 * When enabled on a repository row (see `debug_trace` column), the clone
 * and pull paths run the child `git` process with a set of diagnostic
 * env vars and stream its stderr to a timestamped log file under
 * `{dataDir}/debug-logs/`. This lets the user capture the exact point at
 * which a flaky transfer collapses (HTTP/2 CANCEL, curl 56 RST,
 * sideband disconnect, …) without globally flooding the application log.
 *
 * The capture happens in addition to the normal exec flow — on success
 * the log is kept for download via the API; on failure the same log is
 * what we want to inspect.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';
import { logger, redactSecrets } from '../logger.js';

/** Tail of captured stderr kept in memory to populate the thrown error. */
const TAIL_LINES = 40;

/** Prevent a single runaway trace log from filling the volume. */
const MAX_LOG_BYTES = 250 * 1024 * 1024;

/** How many trace files to retain per repo before pruning the oldest. */
const MAX_LOGS_PER_REPO = 10;

export interface TraceEnvResult {
  env: NodeJS.ProcessEnv;
  logPath: string | null;
}

/**
 * Extra env vars that make `git` emit protocol/curl/perf traces. All
 * channels are routed to stderr (value `"1"`) rather than directly to
 * the log file so that our pipe-side size cap (`MAX_LOG_BYTES`) is
 * actually enforced — otherwise a runaway `GIT_TRACE_PACKET` could fill
 * the data volume before we notice.
 */
export function traceEnv(_logPath: string): NodeJS.ProcessEnv {
  return {
    GIT_TRACE: '1',
    GIT_CURL_VERBOSE: '1',
    GIT_TRACE_PACKET: '1',
    GIT_TRACE_PACK_ACCESS: '1',
    GIT_TRACE_PERFORMANCE: '1',
    GIT_TRACE_SETUP: '1',
  };
}

/** Resolve the directory where trace logs live, creating it on demand. */
export async function ensureDebugLogDir(repoId: number | null): Promise<string> {
  const base = path.join(getConfig().dataDir, 'debug-logs');
  const dir = repoId !== null ? path.join(base, `repo-${repoId}`) : base;
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Build a timestamped log file path for a clone/pull invocation. */
export async function newTraceLogPath(
  repoId: number | null,
  label: 'clone' | 'pull',
): Promise<string> {
  const dir = await ensureDebugLogDir(repoId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${label}-${stamp}.log`);
}

/**
 * Drop the oldest trace logs for a repo so the directory can never grow
 * unbounded. Best-effort — errors here must never abort a backup.
 */
export async function pruneOldLogs(repoId: number): Promise<void> {
  try {
    const dir = await ensureDebugLogDir(repoId);
    const entries = await readdir(dir);
    const files = await Promise.all(
      entries
        .filter((f) => f.endsWith('.log'))
        .map(async (f) => {
          const full = path.join(dir, f);
          try {
            const s = await stat(full);
            return { full, mtime: s.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    const sorted = files
      .filter((x): x is { full: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const extra of sorted.slice(MAX_LOGS_PER_REPO)) {
      try {
        await unlink(extra.full);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Run `git` with tracing enabled, streaming stderr/stdout into
 * `logPath`. Resolves with the captured stdout trimmed; rejects with an
 * Error whose message embeds the tail of the log plus the actual exit
 * code. Safe on non-TTY containers — inherits `nonInteractiveGitEnv`
 * style vars from the caller.
 */
export function execGitWithTrace(
  args: string[],
  logPath: string,
  baseEnv: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stream: WriteStream;
    try {
      stream = createWriteStream(logPath, { flags: 'a' });
    } catch (e) {
      reject(
        new Error(
          `[git-trace] Failed to open log file ${logPath}: ${(e as Error).message}`,
        ),
      );
      return;
    }

    const header =
      `\n===== git trace @ ${new Date().toISOString()} =====\n` +
      `args: ${args.map(redactSecrets).join(' ')}\n\n`;
    stream.write(header);

    const child = spawn('git', args, {
      env: { ...baseEnv, ...traceEnv(logPath) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    const stderrTail: string[] = [];
    let bytesWritten = header.length;
    let truncated = false;

    const writeChunk = (chunk: Buffer): void => {
      if (truncated) return;
      if (bytesWritten + chunk.length > MAX_LOG_BYTES) {
        stream.write(
          `\n[git-trace] log truncated at ${MAX_LOG_BYTES} bytes — capture continues internally\n`,
        );
        truncated = true;
        return;
      }
      stream.write(chunk);
      bytesWritten += chunk.length;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      writeChunk(chunk);
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > TAIL_LINES) stderrTail.shift();
      }
    });

    child.on('error', (err) => {
      stream.end(`\n[git-trace] spawn error: ${err.message}\n`);
      reject(err);
    });

    child.on('close', (code, signal) => {
      stream.end(
        `\n===== exit code=${code} signal=${signal ?? ''} =====\n`,
        () => {
          if (code === 0) {
            resolve(stdoutBuf.trim());
            return;
          }
          const tail = stderrTail.join('\n');
          logger.warn(
            `[git-trace] git exited with code ${code}${signal ? ` (signal ${signal})` : ''}. Full log: ${logPath}`,
          );
          reject(
            new Error(
              `Command failed: git ${args.map(redactSecrets).join(' ')}\n` +
                `Exit code: ${code}${signal ? ` (signal ${signal})` : ''}\n` +
                `Trace log: ${logPath}\n` +
                `stderr tail:\n${redactSecrets(tail)}`,
            ),
          );
        },
      );
    });
  });
}
