import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { Env as ThreadsEnv } from '../types.js';

const testEnv = env as unknown as ThreadsEnv & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
