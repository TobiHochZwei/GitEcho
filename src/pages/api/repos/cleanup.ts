// Manual one-shot cleanup of redundant URLs from /config/repos.txt.
// A URL in repos.txt is "redundant" when the SQLite database already knows
// about the same repo, i.e. auto-discovery would pick it up on its own.
//
// GET  → preview: returns the list of URLs that would be removed.
// POST → actually performs the removal.

import type { APIRoute } from 'astro';
import { getRepositories } from '../../../lib/database.js';
import { cleanupReposFile, previewCleanupReposFile } from '../../../lib/repos-file.js';

function coveredUrls(): string[] {
  return getRepositories().map((r) => r.url);
}

export const GET: APIRoute = async () => {
  const removable = previewCleanupReposFile(coveredUrls());
  return new Response(JSON.stringify({ removable }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async () => {
  const { removed } = cleanupReposFile(coveredUrls());
  return new Response(JSON.stringify({ removed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
