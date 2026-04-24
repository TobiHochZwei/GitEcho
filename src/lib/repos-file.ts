// Read/write helper for /config/repos.txt with comment preservation.
// The file is parsed into a list of typed lines (url / comment / blank).
// CRUD operations work on URL entries; comment and blank lines are kept
// in their original positions so user-authored notes survive a round-trip.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getConfig } from './config.js';

export type RepoLineKind = 'url' | 'comment' | 'blank';

export interface RepoLine {
  kind: RepoLineKind;
  text: string;
  url?: string;
  provider?: 'github' | 'azuredevops';
}

const GITHUB_RE = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/i;
const AZDO_RE = /^https?:\/\/dev\.azure\.com\/[^/\s]+\/[^/\s]+\/_git\/[^/\s]+$/i;

function reposPath(): string {
  return join(getConfig().configDir, 'repos.txt');
}

export function classifyUrl(url: string): 'github' | 'azuredevops' | undefined {
  if (GITHUB_RE.test(url)) return 'github';
  if (AZDO_RE.test(url)) return 'azuredevops';
  return undefined;
}

export function parseRepos(content: string): RepoLine[] {
  const lines: RepoLine[] = [];
  for (const raw of content.split('\n')) {
    const trimmed = raw.replace(/\r$/, '');
    if (trimmed.trim() === '') {
      lines.push({ kind: 'blank', text: '' });
      continue;
    }
    if (trimmed.trim().startsWith('#')) {
      lines.push({ kind: 'comment', text: trimmed });
      continue;
    }
    const url = trimmed.trim();
    const provider = classifyUrl(url);
    lines.push({ kind: 'url', text: trimmed, url, provider });
  }
  // The split on '\n' produces a trailing empty string for files ending in
  // newline; drop one trailing blank to avoid growing the file each save.
  if (lines.length > 0 && lines[lines.length - 1].kind === 'blank' && lines[lines.length - 1].text === '') {
    lines.pop();
  }
  return lines;
}

export function readReposFile(): RepoLine[] {
  const path = reposPath();
  if (!existsSync(path)) return [];
  return parseRepos(readFileSync(path, 'utf-8'));
}

export function writeReposFile(lines: RepoLine[]): void {
  const path = reposPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = lines.map((l) => (l.kind === 'url' ? l.url ?? l.text : l.text)).join('\n') + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o644 });
  renameSync(tmp, path);
}

/** Convenience: list only the URL entries. */
export function listRepoUrls(): { url: string; provider?: 'github' | 'azuredevops' }[] {
  return readReposFile()
    .filter((l): l is RepoLine & { url: string } => l.kind === 'url' && Boolean(l.url))
    .map((l) => ({ url: l.url, provider: l.provider }));
}

/** Add a URL if not already present. Returns true if added, false if duplicate. */
export function addRepoUrl(url: string): { added: boolean; reason?: string } {
  const normalized = url.trim().replace(/\/+$/, '');
  if (!normalized) return { added: false, reason: 'URL cannot be empty' };
  const provider = classifyUrl(normalized);
  if (!provider) {
    return {
      added: false,
      reason:
        'URL does not match a supported provider. Expected https://github.com/<owner>/<repo> or https://dev.azure.com/<org>/<project>/_git/<repo>',
    };
  }

  const lines = readReposFile();
  const exists = lines.some(
    (l) => l.kind === 'url' && (l.url ?? '').replace(/\.git$/, '').toLowerCase() === normalized.replace(/\.git$/, '').toLowerCase(),
  );
  if (exists) return { added: false, reason: 'URL already in repos.txt' };

  lines.push({ kind: 'url', text: normalized, url: normalized, provider });
  writeReposFile(lines);
  return { added: true };
}

/** Remove a URL by exact match (case-insensitive, .git suffix tolerant). */
export function removeRepoUrl(url: string): boolean {
  const normalized = url.trim().replace(/\.git$/, '').toLowerCase();
  const lines = readReposFile();
  const next: RepoLine[] = [];
  let removed = false;
  for (const line of lines) {
    if (
      !removed &&
      line.kind === 'url' &&
      (line.url ?? '').replace(/\.git$/, '').toLowerCase() === normalized
    ) {
      removed = true;
      continue;
    }
    next.push(line);
  }
  if (removed) writeReposFile(next);
  return removed;
}

/**
 * Remove URL entries from repos.txt that are already covered by the given
 * set of URLs (typically every repo the database knows about). Comment and
 * blank lines are preserved in their original positions — only URL lines
 * are considered. Comparison is case-insensitive and tolerant of `.git`.
 *
 * Returns the list of URLs that were actually removed.
 */
export function cleanupReposFile(coveredUrls: Iterable<string>): { removed: string[] } {
  const coverSet = new Set<string>();
  for (const url of coveredUrls) {
    coverSet.add(url.trim().replace(/\.git$/, '').toLowerCase());
  }
  if (coverSet.size === 0) return { removed: [] };

  const lines = readReposFile();
  const next: RepoLine[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    if (line.kind === 'url' && line.url) {
      const key = line.url.replace(/\.git$/, '').toLowerCase();
      if (coverSet.has(key)) {
        removed.push(line.url);
        continue;
      }
    }
    next.push(line);
  }
  if (removed.length > 0) writeReposFile(next);
  return { removed };
}

/**
 * Preview what `cleanupReposFile` would remove without writing any changes.
 */
export function previewCleanupReposFile(coveredUrls: Iterable<string>): string[] {
  const coverSet = new Set<string>();
  for (const url of coveredUrls) {
    coverSet.add(url.trim().replace(/\.git$/, '').toLowerCase());
  }
  if (coverSet.size === 0) return [];
  return readReposFile()
    .filter(
      (line): line is RepoLine & { url: string } =>
        line.kind === 'url' &&
        !!line.url &&
        coverSet.has(line.url.replace(/\.git$/, '').toLowerCase()),
    )
    .map((line) => line.url);
}
