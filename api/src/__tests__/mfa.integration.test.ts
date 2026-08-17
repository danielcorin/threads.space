import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode, TOTP_PERIOD_SECONDS } from '../lib/mfa.js';
import {
  authedFetch,
  BASE_URL,
  createTestUser,
  execSql,
  json,
  loginUser,
  makeAdmin,
  querySql,
  sqlLit,
} from './helpers.js';

function currentStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const value = header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;]+)`))?.[1];
  if (!value) throw new Error(`${name} cookie missing from ${header}`);
  return value;
}

async function passwordLogin(username: string, password = 'testpass123'): Promise<Response> {
  const request = () => fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `mfa-${username}-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ username, password }),
  });

  try {
    return await request();
  } catch {
    // Direct `wrangler d1 execute --local` calls can make the shared Miniflare
    // process reload between the socket being accepted and the response being
    // written. Login is safe to retry and no MFA assertion is relaxed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return request();
  }
}

async function enrollWithSession(
  username: string,
  sessionToken: string,
): Promise<{ userId: string; secret: string; code: string }> {
  const start = await authedFetch(sessionToken, '/users/me/mfa/enrollment', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'testpass123' }),
  });
  expect(start.status).toBe(200);
  const setup = await json(start);
  expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
  expect(setup.otpauthUri).toContain('otpauth://totp/');
  const provisioningUri = new URL(setup.otpauthUri);
  expect(provisioningUri.searchParams.get('issuer')).toBe('test-instance.example');
  expect(decodeURIComponent(provisioningUri.pathname)).toBe(
    `/test-instance.example:${username}@example.com`,
  );

  const code = await generateTotpCode(setup.secret, currentStep());
  const confirm = await authedFetch(sessionToken, '/users/me/mfa/enrollment/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  expect(confirm.status).toBe(200);

  const [user] = querySql<{ id: string }>(
    `SELECT id FROM users WHERE username = ${sqlLit(username)}`,
  );
  return { userId: user.id, secret: setup.secret, code };
}

describe('Authenticator MFA', () => {
  beforeAll(async () => {
    await createTestUser('mfa_voluntary');
    await createTestUser('mfa_policy_admin');
    await makeAdmin('mfa_policy_admin');
    await createTestUser('mfa_policy_user');
    await createTestUser('mfa_policy_bot', 'testpass123', undefined, 'bot');
    await createTestUser('mfa_unverified');
    execSql(`UPDATE users SET email_verified_at = unixepoch()
             WHERE username IN ('mfa_voluntary', 'mfa_policy_admin')`);
  });

  it('requires a verified recovery email for voluntary enrollment', async () => {
    const { sessionToken } = await loginUser('mfa_unverified');
    const start = await authedFetch(sessionToken, '/users/me/mfa/enrollment', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'testpass123' }),
    });
    expect(start.status).toBe(409);
    expect(await json(start)).toEqual({
      error: 'Verify your recovery email before setting up authenticator MFA',
    });
  });

  afterAll(() => {
    execSql('UPDATE workspace_security SET require_mfa_for_humans = 0, updated_by = NULL');
  });

  it('supports voluntary enrollment, requires TOTP at login, and rejects replay', async () => {
    const { sessionToken } = await loginUser('mfa_voluntary');
    const enrolled = await enrollWithSession('mfa_voluntary', sessionToken);

    const security = await authedFetch(sessionToken, '/users/me/security');
    expect(security.status).toBe(200);
    expect(await json(security)).toMatchObject({ mfaEnabled: true, mfaRequired: false });

    const login = await passwordLogin('mfa_voluntary');
    expect(login.status).toBe(200);
    expect(await json(login)).toEqual({ next: 'verify_mfa' });
    expect(login.headers.get('set-cookie')).not.toMatch(/__Host-session=[^;]/);
    const challenge = cookieValue(login, '__Host-mfa_challenge');

    // Enrollment consumed its code. Clear the replay watermark and generate a
    // fresh code so this test is independent of a 30-second boundary crossing.
    execSql(
      `UPDATE mfa_credentials SET last_used_step = -1
       WHERE user_id = ${sqlLit(enrolled.userId)}`,
    );
    const loginCode = await generateTotpCode(enrolled.secret, currentStep());
    const complete = await fetch(`${BASE_URL}/auth/mfa/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__Host-mfa_challenge=${challenge}`,
      },
      body: JSON.stringify({ code: loginCode }),
    });
    expect(complete.status).toBe(200);
    expect(await json(complete)).toMatchObject({ username: 'mfa_voluntary', next: 'complete' });
    expect(complete.headers.get('set-cookie')).toContain('__Host-session=');

    const replayLogin = await passwordLogin('mfa_voluntary');
    const replayChallenge = cookieValue(replayLogin, '__Host-mfa_challenge');
    const replay = await fetch(`${BASE_URL}/auth/mfa/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__Host-mfa_challenge=${replayChallenge}`,
      },
      body: JSON.stringify({ code: loginCode }),
    });
    expect(replay.status).toBe(401);

    execSql(
      `UPDATE mfa_credentials SET last_used_step = -1
       WHERE user_id = ${sqlLit(enrolled.userId)}`,
    );
    const disableCode = await generateTotpCode(enrolled.secret, currentStep());
    const disable = await authedFetch(sessionToken, '/users/me/mfa', {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword: 'testpass123', code: disableCode }),
    });
    expect(disable.status).toBe(200);
    expect(await json(disable)).toMatchObject({ mfaEnabled: false });

    const normalLogin = await passwordLogin('mfa_voluntary');
    expect(await json(normalLogin)).toMatchObject({ username: 'mfa_voluntary', next: 'complete' });
    expect(normalLogin.headers.get('set-cookie')).toContain('__Host-session=');
  });

  it('blocks enforcement until recovery emails are verified, then forces enrollment', async () => {
    const { sessionToken } = await loginUser('mfa_policy_admin');
    const admin = await enrollWithSession('mfa_policy_admin', sessionToken);

    // Isolate the intended precondition: all existing fixtures are marked
    // verified except the policy target.
    execSql(`UPDATE users SET email_verified_at = unixepoch()
             WHERE username != 'mfa_policy_user' AND COALESCE(role, 'human') != 'bot'`);
    const blocked = await authedFetch(sessionToken, '/workspace/security', {
      method: 'PATCH',
      body: JSON.stringify({
        requireMfaForHumans: true,
        currentPassword: 'testpass123',
        code: admin.code,
      }),
    });
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({
      unverifiedUsers: [{ username: 'mfa_policy_user' }],
    });

    execSql("UPDATE users SET email_verified_at = unixepoch() WHERE username = 'mfa_policy_user'");
    execSql(
      `UPDATE mfa_credentials SET last_used_step = -1
       WHERE user_id = ${sqlLit(admin.userId)}`,
    );
    const enableCode = await generateTotpCode(admin.secret, currentStep());
    const enabled = await authedFetch(sessionToken, '/workspace/security', {
      method: 'PATCH',
      body: JSON.stringify({
        requireMfaForHumans: true,
        currentPassword: 'testpass123',
        code: enableCode,
      }),
    });
    expect(enabled.status).toBe(200);
    expect(await json(enabled)).toMatchObject({ requireMfaForHumans: true });

    const botLogin = await passwordLogin('mfa_policy_bot');
    expect(await json(botLogin)).toMatchObject({ username: 'mfa_policy_bot', next: 'complete' });

    // Keep the invariant true after enforcement: a newly-created or newly
    // unverified account cannot use forced enrollment until the email is proven.
    execSql("UPDATE users SET email_verified_at = NULL WHERE username = 'mfa_policy_user'");
    const unverifiedLogin = await passwordLogin('mfa_policy_user');
    expect(unverifiedLogin.status).toBe(403);
    expect(await json(unverifiedLogin)).toEqual({
      error: 'Verify your recovery email before setting up authenticator MFA',
    });

    execSql("UPDATE users SET email_verified_at = unixepoch() WHERE username = 'mfa_policy_user'");
    const login = await passwordLogin('mfa_policy_user');
    expect(login.status).toBe(200);
    const body = await json(login);
    expect(body.next).toBe('enroll_mfa');
    expect(body.setup.secret).toMatch(/^[A-Z2-7]+$/);
    const forcedProvisioningUri = new URL(body.setup.otpauthUri);
    expect(forcedProvisioningUri.searchParams.get('issuer')).toBe('test-instance.example');
    expect(decodeURIComponent(forcedProvisioningUri.pathname)).toBe(
      '/test-instance.example:mfa_policy_user@example.com',
    );
    const challenge = cookieValue(login, '__Host-mfa_challenge');
    const code = await generateTotpCode(body.setup.secret, currentStep());
    const complete = await fetch(`${BASE_URL}/auth/mfa/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__Host-mfa_challenge=${challenge}`,
      },
      body: JSON.stringify({ code }),
    });
    expect(complete.status).toBe(200);
    const completedUser = await json(complete);
    expect(completedUser).toMatchObject({ username: 'mfa_policy_user', next: 'complete' });
    expect(complete.headers.get('set-cookie')).toContain('__Host-session=');

    execSql(
      `UPDATE mfa_credentials SET last_used_step = -1
       WHERE user_id = ${sqlLit(admin.userId)}`,
    );
    const resetCode = await generateTotpCode(admin.secret, currentStep());
    const reset = await authedFetch(sessionToken, `/users/${completedUser.id}/mfa`, {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword: 'testpass123', code: resetCode }),
    });
    expect(reset.status).toBe(200);
    expect(querySql(`SELECT 1 FROM mfa_credentials WHERE user_id = ${sqlLit(completedUser.id)}`)).toEqual([]);
    expect(querySql(`SELECT 1 FROM sessions WHERE user_id = ${sqlLit(completedUser.id)}`)).toEqual([]);

    const reenrollLogin = await passwordLogin('mfa_policy_user');
    expect(await json(reenrollLogin)).toMatchObject({ next: 'enroll_mfa' });
  });
});
