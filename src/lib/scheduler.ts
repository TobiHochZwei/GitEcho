import { schedule as cronSchedule, validate as cronValidate, type ScheduledTask } from 'node-cron';
import { getConfig } from './config.js';
import { runBackup } from './backup/engine.js';
import {
  notifyBackupSuccess,
  notifyCriticalError,
  notifyUnavailableRepos,
  checkAndNotifyPatExpiry,
} from './smtp.js';
import type { BackupSummary } from './smtp.js';
import { tryAcquireBackupLock } from './backup-lock.js';
import { logger } from './logger.js';

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
  logger.info(`[Scheduler] Starting backup cycle at ${new Date().toISOString()}`);

  try {
    await checkAndNotifyPatExpiry();

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
    };

    // Always emit a single summary email when any upstream repos became
    // unreachable during this run — independent of NOTIFY_ON_SUCCESS.
    if (result.unavailable.length > 0) {
      await notifyUnavailableRepos(result.unavailable);
    }

    if (result.failedCount > 0 && result.successCount === 0) {
      await notifyCriticalError(
        `All ${result.failedCount} repositories failed to backup`,
        JSON.stringify(result.failures, null, 2),
      );
    } else if (result.failedCount > 0) {
      await notifyCriticalError(
        `${result.failedCount} of ${result.totalRepos} repositories failed to backup`,
        JSON.stringify(result.failures, null, 2),
      );
      await notifyBackupSuccess(summary);
    } else {
      await notifyBackupSuccess(summary);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error(`[Scheduler] Backup cycle failed: ${message}`);
    if (stack) logger.error(`[Scheduler] Stack:\n${stack}`);
    await notifyCriticalError(message, stack ?? 'Backup cycle crashed');
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

  scheduledTask = cronSchedule(schedule, () => {
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
