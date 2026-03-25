import type { APIRoute } from 'astro';
import { loadConfig } from '../../lib/config.js';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import archiver from 'archiver';

export const GET: APIRoute = async ({ url }) => {
  const config = loadConfig();
  const pathParam = url.searchParams.get('path');
  const isFile = url.searchParams.get('file') === 'true';

  if (!pathParam) {
    return new Response('Missing path parameter', { status: 400 });
  }

  // Prevent path traversal: resolve to absolute path, then verify it's within backupsDir
  const resolvedBase = resolve(config.backupsDir);
  const fullPath = resolve(resolvedBase, pathParam);

  if (fullPath !== resolvedBase && !fullPath.startsWith(resolvedBase + '/')) {
    return new Response('Invalid path', { status: 403 });
  }

  if (!existsSync(fullPath)) {
    return new Response('Not found', { status: 404 });
  }

  const stat = statSync(fullPath);

  if (isFile || stat.isFile()) {
    // Serve file directly
    const stream = createReadStream(fullPath);
    const readableStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      }
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${basename(fullPath)}"`,
        'Content-Length': stat.size.toString()
      }
    });
  }

  // Directory: create ZIP on-the-fly
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Uint8Array[] = [];

  return new Promise<Response>((resolve, reject) => {
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(new Response(buffer, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${basename(fullPath)}.zip"`,
          'Content-Length': buffer.length.toString()
        }
      }));
    });
    archive.on('error', (err) => reject(new Response(`Archive error: ${err.message}`, { status: 500 })));

    archive.directory(fullPath, basename(fullPath));
    archive.finalize();
  });
};
