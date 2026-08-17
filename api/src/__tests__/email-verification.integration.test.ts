import { beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../utils.js';
import { authedFetch, BASE_URL, createTestUser, execSql, loginUser, querySql, sqlLit } from './helpers.js';

const USERNAME = 'email_verification_user';
const PASSWORD = 'testpass123';
const APP_ORIGIN = 'https://test-instance.example';
let userId: string;
let sessionToken: string;

async function seedPending(email: string, token: string, expiresAt: number): Promise<void> {
  const normalized = email.toLowerCase();
  const tokenHash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000) - 120;
  execSql(
    `INSERT INTO user_email_verifications
      (user_id, pending_email, pending_email_normalized, token_hash, expires_at,
       last_sent_at, send_count, window_started_at, created_at, updated_at)
     VALUES (${sqlLit(userId)}, ${sqlLit(email)}, ${sqlLit(normalized)}, ${sqlLit(tokenHash)},
       ${expiresAt}, ${now}, 1, ${now}, ${now}, ${now})
     ON CONFLICT(user_id) DO UPDATE SET
       pending_email = excluded.pending_email,
       pending_email_normalized = excluded.pending_email_normalized,
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       last_sent_at = excluded.last_sent_at,
       send_count = excluded.send_count,
       window_started_at = excluded.window_started_at,
       updated_at = excluded.updated_at`,
  );
}

describe('user recovery email verification', () => {
  beforeAll(async () => {
    const created = await createTestUser(USERNAME, PASSWORD);
    userId = created.id;
    ({ sessionToken } = await loginUser(USERNAME, PASSWORD));
  });

  it('exposes the unverified account email and pending state on /users/me', async () => {
    const response = await authedFetch(sessionToken, '/users/me');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: `${USERNAME}@example.com`,
      email_verified_at: null,
      pending_email: null,
      email_verification_expires_at: null,
    });
  });

  it('requires a valid email and the current password', async () => {
    const invalidEmail = await authedFetch(sessionToken, '/users/me/email/change', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email', currentPassword: PASSWORD }),
    });
    expect(invalidEmail.status).toBe(400);

    const wrongPassword = await authedFetch(sessionToken, '/users/me/email/change', {
      method: 'POST',
      body: JSON.stringify({ email: 'new-email@example.com', currentPassword: 'wrong-password' }),
    });
    expect(wrongPassword.status).toBe(401);
  });

  it('does not retain a token when delivery is unavailable', async () => {
    const response = await authedFetch(sessionToken, '/users/me/email/change', {
      method: 'POST',
      body: JSON.stringify({ email: 'undeliverable@example.com', currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(503);
    expect(querySql(`SELECT user_id FROM user_email_verifications WHERE user_id = ${sqlLit(userId)}`)).toHaveLength(0);
  });

  it('confirms a single-use token and updates the verified address', async () => {
    const token = 'a'.repeat(64);
    await seedPending('Confirmed.Address@Example.com', token, Math.floor(Date.now() / 1000) + 3600);

    const before = await authedFetch(sessionToken, '/users/me');
    expect(await before.json()).toMatchObject({
      email: `${USERNAME}@example.com`,
      email_verified_at: null,
      pending_email: 'Confirmed.Address@Example.com',
    });

    const response = await fetch(`${BASE_URL}/auth/email/confirm?token=${token}`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${APP_ORIGIN}/?email_verified=1`);

    const [user] = querySql<{ email: string; email_normalized: string; email_verified_at: number | null }>(
      `SELECT email, email_normalized, email_verified_at FROM users WHERE id = ${sqlLit(userId)}`,
    );
    expect(user.email).toBe('Confirmed.Address@Example.com');
    expect(user.email_normalized).toBe('confirmed.address@example.com');
    expect(user.email_verified_at).toBeTypeOf('number');
    expect(querySql(`SELECT user_id FROM user_email_verifications WHERE user_id = ${sqlLit(userId)}`)).toHaveLength(0);

    const reused = await fetch(`${BASE_URL}/auth/email/confirm?token=${token}`, { redirect: 'manual' });
    expect(reused.status).toBe(400);
  });

  it('keeps the verified address active until a replacement is confirmed', async () => {
    const token = 'b'.repeat(64);
    await seedPending('replacement@example.com', token, Math.floor(Date.now() / 1000) + 3600);

    const before = await authedFetch(sessionToken, '/users/me');
    expect(await before.json()).toMatchObject({
      email: 'Confirmed.Address@Example.com',
      pending_email: 'replacement@example.com',
    });

    const response = await fetch(`${BASE_URL}/auth/email/confirm?token=${token}`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    const [user] = querySql<{ email: string; email_verified_at: number | null }>(
      `SELECT email, email_verified_at FROM users WHERE id = ${sqlLit(userId)}`,
    );
    expect(user.email).toBe('replacement@example.com');
    expect(user.email_verified_at).toBeTypeOf('number');
  });

  it('rejects and removes an expired token', async () => {
    const token = 'c'.repeat(64);
    await seedPending('expired@example.com', token, Math.floor(Date.now() / 1000) - 1);

    const response = await fetch(`${BASE_URL}/auth/email/confirm?token=${token}`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(querySql(`SELECT user_id FROM user_email_verifications WHERE user_id = ${sqlLit(userId)}`)).toHaveLength(0);
    const [user] = querySql<{ email: string }>(`SELECT email FROM users WHERE id = ${sqlLit(userId)}`);
    expect(user.email).toBe('replacement@example.com');
  });

  it('cancels a pending replacement when the user chooses the verified address', async () => {
    await seedPending('no-longer-wanted@example.com', 'd'.repeat(64), Math.floor(Date.now() / 1000) + 3600);

    const response = await authedFetch(sessionToken, '/users/me/email/change', {
      method: 'POST',
      body: JSON.stringify({ email: 'replacement@example.com', currentPassword: PASSWORD }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      verified: true,
      email: 'replacement@example.com',
      pendingEmail: null,
      expiresAt: null,
    });
    expect(querySql(`SELECT user_id FROM user_email_verifications WHERE user_id = ${sqlLit(userId)}`)).toHaveLength(0);
  });
});
