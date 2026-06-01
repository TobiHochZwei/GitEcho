import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfig } from '../config.js';
import { getLatestSuccessfulRevisionByUrl, getRepositoryByUrl } from '../database.js';
import { logger, redactSecrets } from '../logger.js';
import { parseTfvcIdentifier, safeTfvcName } from '../tfvc-identifier.js';

interface TfvcChangeset {
  changesetId?: number;
  author?: { displayName?: string };
  comment?: string;
  createdDate?: string;
}

interface TfvcChangesetResponse {
  value?: TfvcChangeset[];
}

/** Metadata for the latest changeset that touched a TFVC server path. */
interface LatestChangeset {
  id: string;
  author?: string;
  comment?: string;
  createdDate?: string;
}

/** A single changeset entry stored in a snapshot's `source_metadata`. */
interface ChangesetMeta {
  id: string;
  author?: string;
  comment?: string;
  date?: string;
}

/** Changeset history captured alongside a TFVC snapshot. Serialized to the
 *  `backup_items.source_metadata` JSON column. */
interface TfvcSourceMetadata {
  latest: ChangesetMeta;
  changesets: ChangesetMeta[];
  count: number;
}

function computeChecksum(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`, 'utf-8').toString('base64')}`;
}

async function fetchLatestChangeset(
  org: string,
  project: string,
  serverPath: string,
  pat: string,
): Promise<LatestChangeset | undefined> {
  try {
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
    const url =
      `${base}/_apis/tfvc/changesets?` +
      `searchCriteria.itemPath=${encodeURIComponent(serverPath)}&$top=1&api-version=7.1-preview.1`;

    const res = await fetch(url, {
      headers: {
        Authorization: authHeader(pat),
        Accept: 'application/json',
      },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as TfvcChangesetResponse;
    const latest = body.value?.[0];
    const id = latest?.changesetId;
    if (typeof id !== 'number') return undefined;
    return {
      id: String(id),
      author: latest?.author?.displayName,
      comment: latest?.comment,
      createdDate: latest?.createdDate,
    };
  } catch {
    return undefined;
  }
}

/**
 * Fetch the changesets that touched a server path within an (inclusive)
 * changeset id range. Used to record the history a snapshot captures since the
 * previous successful backup. Best-effort: returns `[]` on any error so a
 * metadata lookup never fails a backup. Capped via `$top` to avoid pulling an
 * unbounded history.
 */
async function fetchChangesetsInRange(
  org: string,
  project: string,
  serverPath: string,
  fromId: number | undefined,
  toId: number | undefined,
  pat: string,
): Promise<ChangesetMeta[]> {
  try {
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
    const params = new URLSearchParams();
    params.set('searchCriteria.itemPath', serverPath);
    if (fromId !== undefined) params.set('searchCriteria.fromId', String(fromId));
    if (toId !== undefined) params.set('searchCriteria.toId', String(toId));
    params.set('$top', '100');
    params.set('api-version', '7.1-preview.1');

    const res = await fetch(`${base}/_apis/tfvc/changesets?${params.toString()}`, {
      headers: {
        Authorization: authHeader(pat),
        Accept: 'application/json',
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as TfvcChangesetResponse;
    return (body.value ?? [])
      .filter((c) => typeof c.changesetId === 'number')
      .map((c) => ({
        id: String(c.changesetId),
        author: c.author?.displayName,
        comment: c.comment,
        date: c.createdDate,
      }));
  } catch {
    return [];
  }
}

/**
 * Build the changeset history metadata for a snapshot. On the first backup (no
 * previous revision) or when the range lookup yields nothing, falls back to the
 * single latest changeset.
 */
async function buildSourceMetadata(
  org: string,
  project: string,
  serverPath: string,
  latest: LatestChangeset,
  lastRevision: string | undefined,
  pat: string,
): Promise<TfvcSourceMetadata> {
  const latestMeta: ChangesetMeta = {
    id: latest.id,
    author: latest.author,
    comment: latest.comment,
    date: latest.createdDate,
  };

  let changesets: ChangesetMeta[] = [latestMeta];
  const fromNum = lastRevision !== undefined ? Number(lastRevision) : NaN;
  const toNum = Number(latest.id);
  if (Number.isFinite(fromNum) && Number.isFinite(toNum) && toNum > fromNum) {
    const range = await fetchChangesetsInRange(
      org,
      project,
      serverPath,
      fromNum + 1,
      toNum,
      pat,
    );
    if (range.length > 0) changesets = range;
  }

  return { latest: latestMeta, changesets, count: changesets.length };
}

export async function backupTfvcSnapshot(
  repo: { url: string; provider: string; owner: string; name: string; remotePath?: string },
  backupsDir: string,
): Promise<{ success: boolean; error?: string; unavailable?: boolean; checksum?: string; zipPath?: string; sourceRevision?: string; artifactKind?: 'snapshot'; sourceMetadata?: string }> {
  const parsed = parseTfvcIdentifier(repo.url);
  if (!parsed) {
    return {
      success: false,
      error: 'Invalid TFVC repository identifier. Expected tfvc://dev.azure.com/<org>/<project>?path=$/<project>/<path>',
    };
  }

  const cfg = getConfig().azureDevOps;
  if (!cfg?.pat) {
    return { success: false, error: 'Azure DevOps PAT is required for TFVC backup.' };
  }

  const serverPath = repo.remotePath?.trim() || parsed.path;

  // ── Phase 2: changeset-aware short-circuit ──────────────────────────
  // Ask the server for the latest changeset that touched this path BEFORE
  // downloading anything. When it matches the changeset recorded by the last
  // successful backup, the content cannot have changed, so we skip the
  // (potentially large) export entirely.
  const latest = await fetchLatestChangeset(parsed.org, parsed.project, serverPath, cfg.pat);
  const sourceRevision = latest?.id;
  const lastRevision = sourceRevision ? getLatestSuccessfulRevisionByUrl(repo.url) : undefined;
  if (sourceRevision) {
    const existingRepo = getRepositoryByUrl(repo.url);
    if (lastRevision && lastRevision === sourceRevision && existingRepo?.checksum) {
      logger.info(
        `[tfvc] ${repo.url} unchanged since changeset ${sourceRevision} — skipping export`,
      );
      return {
        success: true,
        checksum: existingRepo.checksum,
        sourceRevision,
        artifactKind: 'snapshot',
      };
    }
  }

  // ── Phase 2: capture the changeset history this snapshot includes ────
  // Best-effort; never fails the backup. Recorded on the backup item as JSON.
  const sourceMetadata = latest
    ? JSON.stringify(
        await buildSourceMetadata(
          parsed.org,
          parsed.project,
          serverPath,
          latest,
          lastRevision,
          cfg.pat,
        ),
      )
    : undefined;

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gitecho-tfvc-'));

  try {
    const base = `https://dev.azure.com/${encodeURIComponent(parsed.org)}/${encodeURIComponent(parsed.project)}`;
    const downloadUrl =
      `${base}/_apis/tfvc/items?` +
      `path=${encodeURIComponent(serverPath)}&recursionLevel=Full&download=true&api-version=7.1-preview.1`;

    const res = await fetch(downloadUrl, {
      headers: {
        Authorization: authHeader(cfg.pat),
        Accept: 'application/octet-stream, application/zip, application/json',
      },
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const unavailable = res.status === 401 || res.status === 403 || res.status === 404;
      return {
        success: false,
        unavailable,
        error: `TFVC export failed (${res.status}): ${redactSecrets(detail).slice(0, 400)}`,
        sourceRevision,
      };
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const detail = await res.text().catch(() => '');
      return {
        success: false,
        error:
          'TFVC export returned JSON instead of an archive. Check TFVC path permissions and server capabilities. ' +
          redactSecrets(detail).slice(0, 300),
        sourceRevision,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const tmpZip = path.join(tempDir, `${safeTfvcName(repo.name)}.zip`);
    writeFileSync(tmpZip, buf);
    const checksum = computeChecksum(tmpZip);

    const existing = getRepositoryByUrl(repo.url);
    if (existing?.checksum === checksum) {
      return { success: true, checksum, sourceRevision, artifactKind: 'snapshot', sourceMetadata };
    }

    const repoDir = path.join(backupsDir, repo.provider, repo.owner, repo.name);
    const snapshotsDir = path.join(repoDir, 'snapshots');
    mkdirSync(snapshotsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalZip = path.join(snapshotsDir, `${safeTfvcName(repo.name)}_${timestamp}.zip`);
    copyFileSync(tmpZip, finalZip);

    return {
      success: true,
      checksum,
      zipPath: finalZip,
      sourceRevision,
      artifactKind: 'snapshot',
      sourceMetadata,
    };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    logger.warn(`[tfvc] Snapshot backup failed for ${repo.url}: ${message}`);
    return { success: false, error: message, sourceRevision };
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
