import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/*.test.ts', 'src/__tests__/*.integration.test.ts'],
    globalSetup: ['src/__tests__/setup.ts'],
    setupFiles: ['src/__tests__/http-setup.ts'],
    testTimeout: 15000,
    hookTimeout: 30000,
    // Integration files share one Wrangler dev server and one local D1 database.
    // Cron-style tests claim due rows globally, so running files in parallel can
    // make one file consume another file's fixture rows.
    fileParallelism: false,
  },
});
