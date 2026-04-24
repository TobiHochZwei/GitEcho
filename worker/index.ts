process.env.GITECHO_PROCESS = 'worker';
import { loadConfig } from '../src/lib/config.js';
import { initDatabase, markStuckRunsFailed } from '../src/lib/database.js';
import { logger } from '../src/lib/logger.js';
import { registerAllPlugins } from '../src/lib/plugins/register.js';
import {
  startScheduler,
  stopScheduler,
  executeBackupCycle,
  isBackupRunning,
} from '../src/lib/scheduler.js';
import { humanizeCron } from '../src/lib/cron-humanize.js';

const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '30000', 10);

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn(`[Worker] Received ${signal} during shutdown, forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  logger.info(`[Worker] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new cron ticks first.
  try {
    stopScheduler();
  } catch (err) {
    logger.error('[Worker] Failed to stop scheduler cleanly:', err);
  }

  // Wait for an in-flight backup cycle to finish, up to SHUTDOWN_TIMEOUT_MS.
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  if (isBackupRunning()) {
    logger.info(
      `[Worker] Waiting up to ${Math.round(SHUTDOWN_TIMEOUT_MS / 1000)}s for the active backup cycle to finish...`,
    );
  }
  while (isBackupRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (isBackupRunning()) {
    logger.warn('[Worker] Backup still running after shutdown timeout — exiting anyway');
    process.exit(1);
  }

  logger.info('[Worker] Shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  logger.info('[Worker] GitEcho background worker starting...');

  try {
    const config = loadConfig();
    logger.info(`[Worker] Backup mode: ${config.backupMode}`);
    logger.info(`[Worker] Cron schedule: ${config.cronSchedule} (${humanizeCron(config.cronSchedule)})`);

    initDatabase(config.dataDir);
    logger.info('[Worker] Database initialized');

    // Reconcile runs orphaned by a previous crash/restart. The worker is the
    // single source of backup execution and both processes restart together,
    // so any row still marked `running` at boot cannot have a live writer.
    const reconciled = markStuckRunsFailed('Run interrupted by process restart');
    if (reconciled > 0) {
      logger.warn(`[Worker] Marked ${reconciled} stuck run(s) as failed`);
    }

    registerAllPlugins();
    logger.info('[Worker] Plugins registered');

    // Register shutdown handlers before any long-running work so signals that
    // arrive during the initial backup are handled gracefully.
    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });

    if (config.runBackupOnStart) {
      logger.info('[Worker] runBackupOnStart is enabled — running initial backup...');
      await executeBackupCycle();
    } else {
      logger.info('[Worker] runBackupOnStart is disabled — waiting for cron schedule.');
    }

    startScheduler();
  } catch (error) {
    logger.error('[Worker] Fatal error:', error);
    process.exit(1);
  }
}

main();
