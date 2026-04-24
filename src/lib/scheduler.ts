import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import { getConfig } from './config.js';
import { runBackup } from './backup/engine.js';
import { notifyBackupCycleReport, collectPatExpiryWarnings } from './smtp.js';
import type { BackupCycleReport, BackupSummary } from './smtp.js';
import { tryAcquireBackupLock } from './backup-lock.js';
import { logger, redactSecrets } from './logger.js';

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Run a full backup cycle and send the consolidated email report.
 *
 * The caller MUST already own the backup lock (filesystem mutex) and is
 * responsible for releasing it. This helper only guards against concurrent
 * invocations inside the current process via `isRunning`.
 *
 * Used both by the cron tick (`executeBackupCycle`) and by the manual trigger
 * endpoint so that UI-initiated runs produce the same reports as scheduled
 * runs.
 */
export async function runBackupCycle(): Promise<void> {
  if (isRunning) {
    logger.info('[Scheduler] Backup already running in this process, skipping cycle');
    return;
  }
  isRunning = true;
  const cycleStartedAt = new Date().toISOString();
  logger.info(`[Scheduler] Starting backup cycle at ${cycleStartedAt}`);

  try {
    const result = await runBackup();

    logger.info(
      `[Scheduler] Backup complete: ${result.successCount}/${result.totalRepos} repos succeeded, ` +
        `${result.unavailableCount} unavailable`,
    );

    const summary: BackupSummary = {
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      totalRepos: result.totalRepos,
      successCount: result.successCount,
      failedCount: result.failedCount,
      skippedCount: 0,
      backupMode: result.backupMode,
      failures: result.failures,
      cancelled: result.cancelled,
    };

    const report: BackupCycleReport = {
      summary,
      unavailable: result.unavailable,
      newRepos: result.newRepos,
      patWarnings: result.patWarnings,
    };

    // Send exactly one consolidated email for the entire cycle.
    await notifyBackupCycleReport(report);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error(`[Scheduler] Backup cycle failed: ${message}`);
    if (stack) logger.error(`[Scheduler] Stack:\n${redactSecrets(stack)}`);

    // Engine crashed before producing a BackupResult — still send a single
    // report so the operator learns about it. Wrap every step defensively so
    // a secondary failure (e.g. config or SMTP helpers throwing) cannot hide
    // the original error.
    try {
      const completedAt = new Date().toISOString();
      let backupMode: string;
      try {
        backupMode = getConfig().backupMode;
      } catch {
        backupMode = 'unknown';
      }
      let patWarnings: BackupCycleReport['patWarnings'] = [];
      try {
        patWarnings = collectPatExpiryWarnings();
      } catch (warnErr) {
        logger.error('[Scheduler] Failed to collect PAT warnings for crash report:', warnErr);
      }
      const crashReport: BackupCycleReport = {
        summary: {
          startedAt: cycleStartedAt,
          completedAt,
          totalRepos: 0,
          successCount: 0,
          failedCount: 0,
          skippedCount: 0,
          backupMode,
          failures: [],
        },
        unavailable: [],
        newRepos: [],
        patWarnings,
        criticalError: {
          message,
          context: stack ? redactSecrets(stack) : 'Backup cycle crashed',
        },
      };
      try {
        await notifyBackupCycleReport(crashReport);
      } catch (notifyErr) {
        logger.error('[Scheduler] Failed to send crash report email:', notifyErr);
      }
    } catch (reportErr) {
      logger.error('[Scheduler] Failed to build crash report:', reportErr);
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Acquire the cross-process backup lock and run a full cycle. Used by the
 * cron tick. Returns without doing anything if another process already holds
 * the lock.
 */
export async function executeBackupCycle(): Promise<void> {
  const handle = tryAcquireBackupLock();
  if (!handle) {
    logger.info('[Scheduler] Another process is already running a backup, skipping cycle');
    return;
  }
  try {
    await runBackupCycle();
  } finally {
    handle.release();
  }
}

export function startScheduler(): void {
  // Idempotent: stop any existing task before creating a new one so callers
  // can safely re-invoke on schedule changes without leaking tasks.
  stopScheduler();

  const config = getConfig();
  const schedule = config.cronSchedule;
  const timezone = config.cronTimezone;

  // `loadConfig` already coerces invalid expressions to the default, so this
  // should only trip if node-cron and our parser disagree. Log loudly and
  // bail out rather than silently running on an unexpected cadence.
  if (!cronValidate(schedule)) {
    logger.error(`[Scheduler] node-cron rejected schedule "${schedule}" — scheduler not started`);
    return;
  }

  logger.info(`[Scheduler] Starting with schedule: ${schedule} (timezone: ${timezone})`);
  if (config.cronEnabled === false) {
    logger.warn('[Scheduler] Cron is currently disabled in settings — only manual triggers will run backups');
  }

  try {
    scheduledTask = cronSchedule(
      schedule,
      () => {
        // Re-read the flag on every tick so UI toggles take effect without a restart.
        if (getConfig().cronEnabled === false) {
          logger.info('[Scheduler] Cron disabled via settings, skipping tick');
          return;
        }
        executeBackupCycle().catch((err) => {
          logger.error('[Scheduler] Unhandled error in backup cycle:', err);
        });
      },
      { timezone },
    );
  } catch (err) {
    logger.error(`[Scheduler] Failed to register cron task (schedule="${schedule}", timezone="${timezone}"):`, err);
    scheduledTask = null;
    return;
  }

  logger.info('[Scheduler] Scheduler started successfully');
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[Scheduler] Scheduler stopped');
  }
}

/**
 * Whether the current process has a backup cycle in flight.
 *
 * NOTE: this flag is per-process. In the web process (manual triggers) it is
 * only accurate for runs started via that same process — use
 * `inspectBackupLock()` for a cross-process view. Currently consumed only by
 * the worker for graceful shutdown, where per-process visibility is exactly
 * what we want.
 */
export function isBackupRunning(): boolean {
  return isRunning;
}
