import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, type AuthPrincipal } from '../auth.js';
import { handleRequestEmailChange } from '../routes/email-verification.js';
import { handleCreateUser } from '../routes/users.js';
import type { Env, User } from '../types.js';

const serviceEnv = env as unknown as Env;
const user: User = {
  id: 'email-workflow-user',
  username: 'email-workflow-user',
  email: 'old@example.com',
  email_normalized: 'old@example.com',
  email_verified_at: 1,
  display_name: 'Email Workflow User',
  name_color: null,
  code_theme: null,
  is_admin: 0,
  avatar_url: null,
  role: 'human',
  bot_capabilities_json: null,
  ephemeral_bot_id: null,
  created_at: 1,
};
const principal: AuthPrincipal = {
  user,
  credential: {
    kind: 'session',
    id: 'test-session',
    scopes: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
};

beforeEach(async () => {
  const passwordHash = await hashPassword('current-password');
  await serviceEnv.DB.batch([
    serviceEnv.DB.prepare("DELETE FROM users WHERE id = 'initial-created-user' OR username = 'initial-created-user'"),
    serviceEnv.DB.prepare('DELETE FROM user_email_verifications WHERE user_id = ?').bind(user.id),
    serviceEnv.DB.prepare(
      `INSERT INTO users
        (id, username, password_hash, email, email_normalized, email_verified_at,
         display_name, role, is_admin)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'human', 0)
       ON CONFLICT(id) DO UPDATE SET
         password_hash = excluded.password_hash,
         email = excluded.email,
         email_normalized = excluded.email_normalized,
         email_verified_at = excluded.email_verified_at`,
    ).bind(user.id, user.username, passwordHash, user.email, user.email_normalized, user.display_name),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('email verification service workflow', () => {
  it('automatically sends verification when an admin creates a human user', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://instance.example/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'initial-created-user',
        password: 'initial-password',
        email: 'Initial.User@Example.com',
      }),
    });

    const response = await handleCreateUser(request, {
      ...serviceEnv,
      DB: serviceEnv.DB,
      RESEND_API_KEY: 'test-resend-key',
      AUTH_EMAIL_FROM: 'accounts@example.com',
      APP_ORIGIN: 'https://instance.example',
    }, { ...principal, user: { ...user, is_admin: 1 } });

    expect(response.status).toBe(201);
    const created = await response.json() as {
      id: string;
      emailVerificationSent: boolean;
      emailVerificationExpiresAt: number;
    };
    expect(created).toMatchObject({ emailVerificationSent: true });
    expect(created.emailVerificationExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const stored = await serviceEnv.DB.prepare(
      `SELECT u.email, u.email_normalized, u.email_verified_at, v.pending_email
       FROM users u JOIN user_email_verifications v ON v.user_id = u.id
       WHERE u.id = ?`,
    ).bind(created.id).first<{
      email: string;
      email_normalized: string;
      email_verified_at: number | null;
      pending_email: string;
    }>();
    expect(stored).toEqual({
      email: 'Initial.User@Example.com',
      email_normalized: 'initial.user@example.com',
      email_verified_at: null,
      pending_email: 'Initial.User@Example.com',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).to).toEqual(['Initial.User@Example.com']);
  });

  it('persists only a token hash and sends the raw token to the pending address', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://instance.example/users/me/email/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'New.Address@Example.com', currentPassword: 'current-password' }),
    });

    const response = await handleRequestEmailChange(request, {
      ...serviceEnv,
      DB: serviceEnv.DB,
      RESEND_API_KEY: 'test-resend-key',
      AUTH_EMAIL_FROM: 'accounts@example.com',
      APP_ORIGIN: 'https://instance.example',
    }, principal);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      verified: false,
      pendingEmail: 'New.Address@Example.com',
    });
    const pending = await serviceEnv.DB.prepare(
      `SELECT pending_email, pending_email_normalized, token_hash, expires_at
       FROM user_email_verifications WHERE user_id = ?`,
    ).bind(user.id).first<{
      pending_email: string;
      pending_email_normalized: string;
      token_hash: string;
      expires_at: number;
    }>();
    expect(pending).toMatchObject({
      pending_email: 'New.Address@Example.com',
      pending_email_normalized: 'new.address@example.com',
    });
    expect(pending?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(pending?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const payload = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(payload.to).toEqual(['New.Address@Example.com']);
    expect(payload.text).toMatch(/https:\/\/instance\.example\/auth\/email\/confirm\?token=[a-f0-9]{64}/);
    expect(payload.text).not.toContain(pending?.token_hash);
  });

  it('retains the cooldown state when the email provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider error', { status: 500 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = new Request('https://instance.example/users/me/email/change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'retry-later@example.com', currentPassword: 'current-password' }),
    });

    const rejection = await handleRequestEmailChange(request, {
      ...serviceEnv,
      DB: serviceEnv.DB,
      RESEND_API_KEY: 'test-resend-key',
      AUTH_EMAIL_FROM: 'accounts@example.com',
    }, principal).catch((error) => error);

    expect(rejection).toBeInstanceOf(Response);
    expect((rejection as Response).status).toBe(502);
    const pending = await serviceEnv.DB.prepare(
      'SELECT pending_email, last_sent_at FROM user_email_verifications WHERE user_id = ?',
    ).bind(user.id).first<{ pending_email: string; last_sent_at: number }>();
    expect(pending?.pending_email).toBe('retry-later@example.com');
    expect(pending?.last_sent_at).toBeGreaterThan(0);
  });
});
