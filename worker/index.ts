process.env.GITECHO_PROCESS = 'worker';
import { loadConfig } from '../src/lib/config.js';
import { initDatabase } from '../src/lib/database.js';
import { logger } from '../src/lib/logger.js';
import { registerAllPlugins } from '../src/lib/plugins/register.js';
import { startScheduler, executeBackupCycle } from '../src/lib/scheduler.js';
import { humanizeCron } from '../src/lib/cron-humanize.js';

async function main(): Promise<void> {
  logger.info('[Worker] GitEcho background worker starting...');

  try {
    const config = loadConfig();
    logger.info(`[Worker] Backup mode: ${config.backupMode}`);
    logger.info(`[Worker] Cron schedule: ${config.cronSchedule} (${humanizeCron(config.cronSchedule)})`);

    initDatabase(config.dataDir);
    logger.info('[Worker] Database initialized');

    registerAllPlugins();
    logger.info('[Worker] Plugins registered');

    logger.info('[Worker] Running initial backup...');
    await executeBackupCycle();

    startScheduler();

    process.on('SIGTERM', () => {
      logger.info('[Worker] Received SIGTERM, shutting down...');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      logger.info('[Worker] Received SIGINT, shutting down...');
      process.exit(0);
    });
  } catch (error) {
    logger.error('[Worker] Fatal error:', error);
    process.exit(1);
  }
}

main();
