// Option2: ZIP snapshot strategy with checksum deduplication
// - Every run: clone to temp dir, create ZIP archive
// - Compare checksum with previous ZIP
// - If same checksum: delete new ZIP, keep existing
// - If different: keep new ZIP (timestamped filename)
// - Directory structure: /backups/<provider>/<owner>/<repo>/<repo>_<timestamp>.zip

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import type { ProviderPlugin, RepositoryInfo } from '../plugins/interface';
import { isUpstreamUnavailable } from '../plugins/errors';
import { getRepositoryByUrl } from '../database';

function computeChecksum(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function createZip(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export async function backupOption2(
  plugin: ProviderPlugin,
  repo: RepositoryInfo,
  backupsDir: string,
): Promise<{ success: boolean; error?: string; checksum?: string; zipPath?: string; unavailable?: boolean }> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-'));

  try {
    // Clone to temp directory
    const authenticatedUrl = plugin.getAuthenticatedUrl(repo.url);
    const cloneDir = path.join(tempDir, repo.name);
    await plugin.cloneRepository(authenticatedUrl, cloneDir);

    // Create ZIP in temp location
    const tempZipPath = path.join(tempDir, `${repo.name}.zip`);
    await createZip(cloneDir, tempZipPath);

    // Compute checksum of the new ZIP
    const checksum = computeChecksum(tempZipPath);

    // Compare with previous checksum from database
    const existingRepo = getRepositoryByUrl(repo.url);
    if (existingRepo?.checksum === checksum) {
      // Checksums match — discard new ZIP
      return { success: true, checksum };
    }

    // Different checksum — move ZIP to final location
    const repoBackupDir = path.join(backupsDir, repo.provider, repo.owner, repo.name);
    mkdirSync(repoBackupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalZipName = `${repo.name}_${timestamp}.zip`;
    const finalZipPath = path.join(repoBackupDir, finalZipName);

    // Copy from temp to final destination (rename may fail across filesystems)
    const { copyFileSync } = await import('node:fs');
    copyFileSync(tempZipPath, finalZipPath);

    return { success: true, checksum, zipPath: finalZipPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, unavailable: isUpstreamUnavailable(err) };
  } finally {
    // Always clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
