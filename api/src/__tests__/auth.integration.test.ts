import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch, makeAdmin, execSql, querySql, sqlLit } from './helpers.js';

describe('Auth', () => {
  beforeAll(async () => {
    await createTestUser('auth_user1');
  });

  describe('POST /auth/login', () => {
    it('returns user and session cookie with valid credentials', async () => {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auth_user1', password: 'testpass123' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.username).toBe('auth_user1');
      expect(body.id).toBeDefined();
      // Should not expose password_hash
      expect(body.password_hash).toBeUndefined();

      const cookie = res.headers.get('set-cookie');
      expect(cookie).toBeTruthy();
      expect(cookie).toContain('session=');
      expect(cookie).toContain('__Host-session=');

      const rawSession = cookie!.match(/session=([^;]+)/)![1];
      const [stored] = querySql<{
        token: string;
        credential_id: string;
        token_verifier: string;
      }>(`SELECT token, credential_id, token_verifier FROM sessions
          WHERE user_id = ${sqlLit(body.id)} ORDER BY created_at DESC LIMIT 1`);
      expect(stored.token).not.toBe(rawSession);
      expect(stored.token).toBe(`id:${stored.credential_id}`);
      expect(stored.token_verifier).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns 401 with wrong password', async () => {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auth_user1', password: 'wrongpass' }),
      });

      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.error).toBeDefined();
    });

    it('returns 401 with nonexistent user', async () => {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'noexist_user', password: 'testpass123' }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the session cookie', async () => {
      const res = await fetch(`${BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toContain('Max-Age=0');
    });
  });

  describe('POST /auth/change-password', () => {
    beforeAll(async () => {
      await createTestUser('auth_changepw');
    });

    it('changes password, old password fails, new password works', async () => {
      const { sessionToken } = await loginUser('auth_changepw');

      // Change the password
      const changeRes = await authedFetch(sessionToken, '/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'testpass123', newPassword: 'newpass456' }),
      });
      expect(changeRes.status).toBe(200);

      const oldSessionRes = await authedFetch(sessionToken, '/users/me');
      expect(oldSessionRes.status).toBe(401);
      const rotatedSession = changeRes.headers.get('set-cookie')?.match(/session=([^;]+)/)?.[1];
      expect(rotatedSession).toBeTruthy();
      const rotatedSessionRes = await authedFetch(rotatedSession!, '/users/me');
      expect(rotatedSessionRes.status).toBe(200);

      // Old password should fail
      const oldRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auth_changepw', password: 'testpass123' }),
      });
      expect(oldRes.status).toBe(401);

      // New password should work
      const newRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auth_changepw', password: 'newpass456' }),
      });
      expect(newRes.status).toBe(200);
    });

    it('returns 401 with wrong current password', async () => {
      const { sessionToken } = await loginUser('auth_changepw', 'newpass456');

      const res = await authedFetch(sessionToken, '/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'wrongpassword', newPassword: 'doesntmatter' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 without authentication', async () => {
      const res = await fetch(`${BASE_URL}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'testpass123', newPassword: 'newpass' }),
      });
      expect(res.status).toBe(401);
    });

  });

  describe('POST /users', () => {
    beforeAll(async () => {
      await createTestUser('auth_admin');
      await makeAdmin('auth_admin');
      await createTestUser('auth_nonadmin');
    });

    it('lets an admin create a user, who can then log in', async () => {
      // Re-login so the session reflects the is_admin promotion
      const { sessionToken } = await loginUser('auth_admin');

      const res = await authedFetch(sessionToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'auth_created', password: 'createdpass1', email: 'auth_created@example.com', displayName: 'Created User' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.username).toBe('auth_created');
      expect(body.email).toBe('auth_created@example.com');
      expect(body.id).toBeTruthy();

      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'test-auth_created' },
        body: JSON.stringify({ username: 'auth_created', password: 'createdpass1' }),
      });
      expect(loginRes.status).toBe(200);
    });

    it('returns 409 on duplicate username', async () => {
      const { sessionToken } = await loginUser('auth_admin');
      const res = await authedFetch(sessionToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'auth_admin', password: 'whatever1', email: 'auth_duplicate@example.com' }),
      });
      expect(res.status).toBe(409);
    });

    it('returns 403 for a non-admin user', async () => {
      const { sessionToken } = await loginUser('auth_nonadmin');
      const res = await authedFetch(sessionToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'should_not_exist', password: 'whatever1' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const res = await fetch(`${BASE_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'should_not_exist2', password: 'whatever1' }),
      });
      expect(res.status).toBe(401);
    });

    it('does not let an ordinary admin bearer token provision users', async () => {
      const { sessionToken } = await loginUser('auth_admin');
      const tokenRes = await authedFetch(sessionToken, '/users/me/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'ordinary-admin-token' }),
      });
      expect(tokenRes.status).toBe(201);
      const token = (await tokenRes.json() as any).token;

      const res = await fetch(`${BASE_URL}/users`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ordinary_token_cannot_create', password: 'whatever1' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // Admin-flag-gated minting of a token FOR ANOTHER user (e.g. a bot the admin
  // just created via POST /users), authorized by an interactive session or an
  // explicitly-scoped provisioning bearer (no server secret).
  describe('POST /users/:id/api-tokens', () => {
    let adminToken: string;
    let botId: string;

    beforeAll(async () => {
      await createTestUser('tok_admin');
      await makeAdmin('tok_admin');
      await createTestUser('tok_nonadmin');
      const { sessionToken } = await loginUser('tok_admin');
      adminToken = sessionToken;
      // Admin creates a bot user to mint a token for.
      const res = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'tok_bot', password: 'botpass12', role: 'bot' }),
      });
      botId = (await res.json() as any).id;
    });

    it('lets an admin mint a token for another user, usable as that user', async () => {
      const res = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'bot-runtime' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.token).toBeTruthy();
      expect(body.name).toBe('bot-runtime');
      expect(body.scopes).toEqual(['threads:read', 'threads:write']);
      expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

      const [stored] = querySql<{
        token: string;
        credential_id: string;
        token_verifier: string;
        token_hint: string;
      }>(`SELECT token, credential_id, token_verifier, token_hint FROM api_tokens
          WHERE credential_id = ${sqlLit(body.id)}`);
      expect(stored.token).toBe(`id:${body.id}`);
      expect(stored.token).not.toBe(body.token);
      expect(stored.token_verifier).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.token_hint).toBe(body.token.slice(-6));

      // The minted token authenticates as the BOT, not the admin.
      const meRes = await fetch(`${BASE_URL}/users/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(meRes.status).toBe(200);
      const me = await meRes.json() as any;
      expect(me.id).toBe(botId);
      expect(me.username).toBe('tok_bot');
      expect(me.role).toBe('bot');
    });

    it('enforces read-only token scope on REST requests', async () => {
      const res = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'read-only',
          scopes: ['threads:read'],
          expires_in_days: 30,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.scopes).toEqual(['threads:read']);

      const read = await fetch(`${BASE_URL}/users/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(read.status).toBe(200);

      const write = await fetch(`${BASE_URL}/channels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${body.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'scope-should-block-before-handler' }),
      });
      expect(write.status).toBe(403);
      await expect(write.json()).resolves.toEqual({
        error: 'API token lacks required scope: threads:write',
      });
    });

    it('rejects expired bearer tokens', async () => {
      const res = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'expires', expires_in_days: 1 }),
      });
      const body = await res.json() as any;
      execSql(`UPDATE api_tokens SET expires_at = 1 WHERE credential_id = ${sqlLit(body.id)}`);

      const me = await fetch(`${BASE_URL}/users/me`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(me.status).toBe(401);
    });

    it('validates token scopes and expiry policy', async () => {
      const invalidScopes = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'invalid-scopes', scopes: [] }),
      });
      expect(invalidScopes.status).toBe(400);

      const invalidExpiry = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'invalid-expiry', expires_in_days: 0 }),
      });
      expect(invalidExpiry.status).toBe(400);
    });

    it('prevents a provisioning bearer from delegating scopes it does not have', async () => {
      const parentRes = await authedFetch(adminToken, '/users/me/api-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: 'limited-token-manager',
          scopes: ['threads:read', 'threads:write', 'tokens:manage'],
        }),
      });
      const parent = await parentRes.json() as any;
      const childRes = await fetch(`${BASE_URL}/users/${botId}/api-tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${parent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'scope-escalation-attempt',
          scopes: ['threads:read', 'users:provision'],
        }),
      });
      expect(childRes.status).toBe(403);
    });

    it('returns 400 when name is missing', async () => {
      const res = await authedFetch(adminToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-existent target user', async () => {
      const res = await authedFetch(adminToken, '/users/does-not-exist/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 403 for a non-admin caller', async () => {
      const { sessionToken } = await loginUser('tok_nonadmin');
      const res = await authedFetch(sessionToken, `/users/${botId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'sneaky' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 401 without authentication', async () => {
      const res = await fetch(`${BASE_URL}/users/${botId}/api-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'anon' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
