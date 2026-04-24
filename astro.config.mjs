import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone'
  }),
  server: {
    port: 3000,
    host: '0.0.0.0'
  },
  // Astro's built-in Origin check (enabled by default for server output)
  // rejects cross-site form POSTs with "Cross-site POST form submissions are
  // forbidden" before our middleware runs — and it has no knowledge of the
  // PUBLIC_URL env var or the `*` wildcard. Disable it here; the CSRF origin
  // check lives in src/middleware.ts and honours PUBLIC_URL.
  security: {
    checkOrigin: false
  }
});
