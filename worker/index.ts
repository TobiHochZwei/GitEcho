import { loadConfig } from '../src/lib/config.js';
import { initDatabase } from '../src/lib/database.js';
import { registerAllPlugins } from '../src/lib/plugins/register.js';
import { startScheduler, executeBackupCycle } from '../src/lib/scheduler.js';

async function main(): Promise<void> {
  console.log('[Worker] GitEcho background worker starting...');

  try {
    const config = loadConfig();
    console.log(`[Worker] Backup mode: ${config.backupMode}`);
    console.log(`[Worker] Cron schedule: ${config.cronSchedule}`);

    initDatabase(config.dataDir);
    console.log('[Worker] Database initialized');

    registerAllPlugins();
    console.log('[Worker] Plugins registered');

    console.log('[Worker] Running initial backup...');
    await executeBackupCycle();

    startScheduler();

    process.on('SIGTERM', () => {
      console.log('[Worker] Received SIGTERM, shutting down...');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[Worker] Received SIGINT, shutting down...');
      process.exit(0);
    });
  } catch (error) {
    console.error('[Worker] Fatal error:', error);
    process.exit(1);
  }
}

main();
