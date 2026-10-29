import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * CORNERSHOP Vite config.
 *
 * - Dev server is pinned to :5173 and preview to :4173 because the Google browser key is
 *   referrer-restricted to exactly those localhost ports (BRIEF.md "Keys").
 * - `/api/*` is proxied to `wrangler dev` (default http://127.0.0.1:8787, override with
 *   CS_API_PROXY) so the Worker (worker/index.ts) can be developed alongside the app.
 *   Client code must treat `/api` failures as "service unavailable" (it is optional in dev).
 */
const apiTarget = process.env.CS_API_PROXY ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    // Fonts stay separate files: inlining the small wordmark subset as base64 would bloat the initial CSS budget.
    assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
  },
});
