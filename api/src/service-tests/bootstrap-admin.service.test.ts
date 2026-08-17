import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleLogin } from '../routes/auth.js';
import type { Env } from '../types.js';

const serviceEnv = env as unknown as Env;
const secret = 'test-instance-secret-that-is-at-least-32-bytes';

function login(username: string, password: string): Promise<Response> {
  return handleLogin(new Request('https://instance.example/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }), { ...serviceEnv, INSTANCE_SECRET: secret });
}

beforeEach(async () => {
  await serviceEnv.DB.prepare("DELETE FROM users WHERE role = 'human'").run();
});

describe('first-admin bootstrap', () => {
  it('atomically claims a fresh instance through the normal login route', async () => {
    const [first, second] = await Promise.all([
      login('admin', secret),
      login('admin', secret),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ username: 'admin', is_admin: 1, role: 'human' });

    const count = await serviceEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'human'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('rejects the wrong secret without creating a user', async () => {
    const response = await login('admin', 'not-the-instance-secret');
    expect(response.status).toBe(401);

    const count = await serviceEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'human'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('does not recreate admin after another human account exists', async () => {
    await serviceEnv.DB.prepare(
      `INSERT INTO users (id, username, password_hash, role, is_admin)
       VALUES ('existing-human', 'alice', 'unused', 'human', 1)`,
    ).run();

    const response = await login('admin', secret);
    expect(response.status).toBe(401);
    expect(await serviceEnv.DB.prepare("SELECT id FROM users WHERE username = 'admin'").first()).toBeNull();
  });
});
