import type { APIRoute } from 'astro';
import { loadConfig } from '../../lib/config.js';
import { initDatabase, getBackupStats, getRepositories, getLatestBackupRun } from '../../lib/database.js';

export const GET: APIRoute = async () => {
  try {
    const config = loadConfig();
    initDatabase(config.dataDir);
    
    const stats = getBackupStats();
    const repos = getRepositories();
    const latestRun = getLatestBackupRun();
    
    return new Response(JSON.stringify({
      stats,
      totalRepos: repos.length,
      providers: {
        github: repos.filter(r => r.provider === 'github').length,
        azuredevops: repos.filter(r => r.provider === 'azuredevops').length,
        gitlab: repos.filter(r => r.provider === 'gitlab').length
      },
      latestRun,
      backupMode: config.backupMode
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to load stats' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
