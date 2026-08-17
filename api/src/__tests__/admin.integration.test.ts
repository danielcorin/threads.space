import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, makeAdmin, loginUser, authedFetch, json, querySql, sqlLit } from './helpers.js';

// Operator actions are authorized by the caller's admin identity. Destructive
// account operations require an interactive session; narrowly scoped bearer
// tokens are reserved for provisioning automation.
describe('Admin user management (is_admin gated)', () => {
  let adminToken: string;
  let plainToken: string;

  beforeAll(async () => {
    await createTestUser('adm_actor');
    await makeAdmin('adm_actor');
    adminToken = (await loginUser('adm_actor')).sessionToken;

    await createTestUser('adm_plain');
    plainToken = (await loginUser('adm_plain')).sessionToken;
  });

  describe('POST /users', () => {
    it('an admin creates a user and returns 201', async () => {
      const res = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_newuser', password: 'testpass123', email: 'adm_newuser@example.com' }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.id).toBeDefined();
      expect(body.username).toBe('adm_newuser');
      expect(body.email).toBe('adm_newuser@example.com');
      expect(body.emailVerificationSent).toBe(false);
      expect(body.emailVerificationExpiresAt).toBeNull();
    });

    it('supports displayName', async () => {
      const res = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_display', password: 'testpass123', email: 'adm_display@example.com', displayName: 'Display User' }),
      });
      expect(res.status).toBe(201);
      expect((await json(res)).displayName).toBe('Display User');
    });

    it('returns 409 for a duplicate username', async () => {
      const res = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_newuser', password: 'testpass123', email: 'another@example.com' }),
      });
      expect(res.status).toBe(409);
    });

    it('requires a valid email for human users', async () => {
      const missing = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_missing_email', password: 'testpass123' }),
      });
      expect(missing.status).toBe(400);

      const invalid = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_invalid_email', password: 'testpass123', email: 'not-an-email' }),
      });
      expect(invalid.status).toBe(400);
    });

    it('normalizes email for uniqueness', async () => {
      const first = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_email_one', password: 'testpass123', email: 'Person@Example.com' }),
      });
      expect(first.status).toBe(201);

      const duplicate = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_email_two', password: 'testpass123', email: 'person@example.com' }),
      });
      expect(duplicate.status).toBe(409);
      expect((await json(duplicate)).error).toContain('Email');
    });

    it('allows bot users without an email', async () => {
      const res = await authedFetch(adminToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_bot_no_email', password: 'testpass123', role: 'bot' }),
      });
      expect(res.status).toBe(201);
      expect((await json(res)).email).toBeNull();
    });

    it('returns 403 for a non-admin caller', async () => {
      const res = await authedFetch(plainToken, '/users', {
        method: 'POST',
        body: JSON.stringify({ username: 'adm_forbidden', password: 'testpass123' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'adm_noauth', password: 'testpass123' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /users/:id/reset-password', () => {
    let userId: string;

    beforeAll(async () => {
      userId = (await createTestUser('adm_resetpw')).id;
    });

    it('resets the password', async () => {
      const res = await authedFetch(adminToken, `/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: 'newpass456' }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).ok).toBe(true);
    });

    it('lets the user log in with the new password; the old one fails', async () => {
      const login = await loginUser('adm_resetpw', 'newpass456');
      expect(login.user.username).toBe('adm_resetpw');

      const old = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'test-adm_resetpw_old' },
        body: JSON.stringify({ username: 'adm_resetpw', password: 'testpass123' }),
      });
      expect(old.status).toBe(401);
    });

    it('returns 403 for a non-admin caller', async () => {
      const res = await authedFetch(plainToken, `/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: 'anotherpass' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 without a password', async () => {
      const res = await authedFetch(adminToken, `/users/${userId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('rejects even an admin bearer token because password reset is interactive-only', async () => {
      const tokenRes = await authedFetch(adminToken, '/users/me/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'admin-bearer-no-reset' }),
      });
      const bearer = (await json(tokenRes)).token;
      const res = await fetch(`${BASE_URL}/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'must-not-change' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /users/:id', () => {
    it('deletes a user and blocks subsequent login', async () => {
      const user = await createTestUser('adm_todelete');
      const res = await authedFetch(adminToken, `/users/${user.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect((await json(res)).ok).toBe(true);

      const login = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'test-adm_todelete' },
        body: JSON.stringify({ username: 'adm_todelete', password: 'testpass123' }),
      });
      expect(login.status).toBe(401);
    });

    it('returns 403 for a non-admin caller', async () => {
      const user = await createTestUser('adm_deleteforbidden');
      const res = await authedFetch(plainToken, `/users/${user.id}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    // Regression: twelve columns reference users(id) with no ON DELETE clause,
    // so a bare DELETE FROM users raised a D1 FOREIGN KEY error for any account
    // that had actually been used. The existing coverage above only ever deleted
    // a freshly created user with no content, which is why it never caught this.
    it('deletes a user who owns content, transferring it to the admin', async () => {
      const user = await createTestUser('adm_hascontent');
      const userToken = (await loginUser('adm_hascontent')).sessionToken;

      const channelId = (await json(await authedFetch(userToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'adm-hascontent-channel' }),
      }))).id;
      const messageId = (await json(await authedFetch(userToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'authored by a user about to be deleted' }),
      }))).id;

      const res = await authedFetch(adminToken, `/users/${user.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      // Ownership of shared artifacts moves to the deleting admin...
      expect(body.transferred.channels).toBeGreaterThanOrEqual(1);
      // ...while authorship is nulled rather than reattributed.
      expect(body.messagesOrphaned).toBeGreaterThanOrEqual(1);

      // The channel and its history survive the deletion. Asserted against D1
      // rather than over HTTP: transferring created_by is an ownership change,
      // not a membership grant, so the admin still cannot read a channel they
      // were never a member of.
      const channels = querySql<{ created_by: string }>(
        `SELECT created_by FROM channels WHERE id = ${sqlLit(channelId)}`,
      );
      expect(channels).toHaveLength(1);
      expect(channels[0].created_by).toBe((await json(await authedFetch(adminToken, '/users/me'))).id);

      const kept = querySql<{ content: string; user_id: string | null }>(
        `SELECT content, user_id FROM messages WHERE id = ${sqlLit(messageId)}`,
      );
      expect(kept).toHaveLength(1);
      expect(kept[0].content).toBe('authored by a user about to be deleted');
      // Authorless now, NOT credited to the admin who deleted them.
      expect(kept[0].user_id).toBeNull();
    });

    it('refuses to delete the account the caller is signed in as', async () => {
      const me = await json(await authedFetch(adminToken, '/users/me'));
      const res = await authedFetch(adminToken, `/users/${me.id}`, { method: 'DELETE' });
      expect(res.status).toBe(409);
    });
  });

  describe('API tokens for a user', () => {
    let userId: string;

    beforeAll(async () => {
      userId = (await createTestUser('adm_tokenuser')).id;
    });

    it('mints a token (201) that authenticates as the user', async () => {
      const res = await authedFetch(adminToken, `/users/${userId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'test-bot' }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.token).toBeDefined();
      expect(body.name).toBe('test-bot');

      const authed = await fetch(`${BASE_URL}/channels`, { headers: { Authorization: `Bearer ${body.token}` } });
      expect(authed.status).toBe(200);
    });

    it('revokes a token by its hashed id; the bearer stops working', async () => {
      const createRes = await authedFetch(adminToken, `/users/${userId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'to-revoke' }),
      });
      const { token, id } = await json(createRes);

      const revoke = await authedFetch(adminToken, `/users/${userId}/api-tokens/${id}`, { method: 'DELETE' });
      expect(revoke.status).toBe(200);

      const authed = await fetch(`${BASE_URL}/channels`, { headers: { Authorization: `Bearer ${token}` } });
      expect(authed.status).toBe(401);
    });

    it('returns 403 when a non-admin mints a token for a user', async () => {
      const res = await authedFetch(plainToken, `/users/${userId}/api-tokens`, {
        method: 'POST',
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /errors', () => {
    it('returns error-log rows to an admin', async () => {
      const res = await authedFetch(adminToken, '/errors');
      expect(res.status).toBe(200);
      expect(Array.isArray(await json(res))).toBe(true);
    });

    it('returns 403 for a non-admin caller', async () => {
      const res = await authedFetch(plainToken, '/errors');
      expect(res.status).toBe(403);
    });
  });
});
