/**
 * Vitest config for the chain e2e only (NOT part of `npm test`: the root config includes `*.test.ts`, this file's
 * suite is `*.e2e.ts`). VITE_CLUSTER=devnet makes src/mode.ts report real mode on devnet, as in a devnet build.
 *
 *   CHAIN_E2E=devnet npx vitest run --config src/chain/__e2e__/vitest.config.ts
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/chain/__e2e__/**/*.e2e.ts'],
    env: { VITE_CLUSTER: 'devnet' },
    testTimeout: 20 * 60_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
