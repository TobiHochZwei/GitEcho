import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import { getConfig } from './config.js';
import { runBackup } from './backup/engine.js';
import { notifyBackupCycleReport, collectPatExpiryWarnings } from './smtp.js';
import type { BackupCycleReport, BackupSummary } from './smtp.js';
import { tryAcquireBackupLock } from './backup-lock.js';
import { logger, redactSecrets } from './logger.js';

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

export async function executeBackupCycle(): Promise<void> {
  if (isRunning) {
    logger.info('[Scheduler] Backup already running in this process, skipping cycle');
    return;
  }
  const handle = tryAcquireBackupLock();
  if (!handle) {
    logger.info('[Scheduler] Another process is already running a backup, skipping cycle');
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
    // report so the operator learns about it.
    const completedAt = new Date().toISOString();
    const crashReport: BackupCycleReport = {
      summary: {
        startedAt: cycleStartedAt,
        completedAt,
        totalRepos: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        backupMode: getConfig().backupMode,
        failures: [],
      },
      unavailable: [],
      newRepos: [],
      patWarnings: collectPatExpiryWarnings(),
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
  } finally {
    isRunning = false;
    handle.release();
  }
}

export function startScheduler(): void {
  const config = getConfig();
  const schedule = config.cronSchedule;

  if (!cronValidate(schedule)) {
    logger.error(`[Scheduler] Invalid cron schedule: ${schedule}`);
    return;
  }

  logger.info(`[Scheduler] Starting with schedule: ${schedule}`);
  if (config.cronEnabled === false) {
    logger.warn('[Scheduler] Cron is currently disabled in settings — only manual triggers will run backups');
  }

  scheduledTask = cronSchedule(schedule, () => {
    // Re-read the flag on every tick so UI toggles take effect without a restart.
    if (getConfig().cronEnabled === false) {
      logger.info('[Scheduler] Cron disabled via settings, skipping tick');
      return;
    }
    executeBackupCycle().catch((err) => {
      logger.error('[Scheduler] Unhandled error in backup cycle:', err);
    });
  });

  logger.info('[Scheduler] Scheduler started successfully');
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('[Scheduler] Scheduler stopped');
  }
}

export function isBackupRunning(): boolean {
  return isRunning;
}
