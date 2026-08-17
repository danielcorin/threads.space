import { defineConfig } from 'vitest/config';

// Post-deploy smoke suite. Unlike vitest.config.ts there is NO globalSetup: this
// hits a REMOTE deployed instance (SMOKE_BASE_URL), it does not start a local
// wrangler dev server. The suite shares state across ordered `it`s in one file,
// so keep it single-threaded and non-parallel.
export default defineConfig({
  test: {
    include: ['src/__tests__/smoke/**/*.smoke.test.ts'],
    testTimeout: 30000,
    // beforeAll polls /health until the just-deployed commit is live across PoPs,
    // so the setup hook needs headroom beyond a single request.
    hookTimeout: 90000,
    fileParallelism: false,
    // Network round-trips against a deployed Worker; no point retrying flakes
    // silently — a real failure should gate the deploy.
    retry: 0,
  },
});
