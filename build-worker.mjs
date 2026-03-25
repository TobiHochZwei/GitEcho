import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('dist/worker', { recursive: true });

execSync(
  'npx esbuild worker/index.ts --bundle --platform=node --format=esm --outfile=dist/worker/index.mjs --external:better-sqlite3 --external:node-cron --external:nodemailer --external:archiver',
  { stdio: 'inherit' },
);

console.log('Worker built successfully');
