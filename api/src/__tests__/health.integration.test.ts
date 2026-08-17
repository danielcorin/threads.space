import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import { BASE_URL } from './helpers.js';

describe('GET /health', () => {
  it('is public and reports instance metadata', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; commit: string; environment: string; latestMigration: string | null };
    expect(body.status).toBe('ok');
    // No GIT_SHA var in the dev server; deploys inject the real SHA.
    expect(body.commit).toBe('dev');
    // setup.ts starts the dev server with --var ENVIRONMENT:development.
    expect(body.environment).toBe('development');
    const latestMigration = readdirSync(resolve(__dirname, '../../migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .at(-1) ?? null;
    expect(body.latestMigration).toBe(latestMigration);
  });
});
