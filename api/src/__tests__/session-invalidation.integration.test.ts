import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Session invalidation on logout', () => {
  beforeAll(async () => {
    await createTestUser('sess_user1');
    await createTestUser('sess_user2');
  });

  it('after logout, session token no longer works', async () => {
    const { sessionToken } = await loginUser('sess_user1');

    // Verify the token works before logout
    const beforeRes = await authedFetch(sessionToken, '/channels');
    expect(beforeRes.status).toBe(200);

    // Logout using the session token
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${sessionToken}`,
      },
    });

    // The token should now be invalidated in the database
    const afterRes = await authedFetch(sessionToken, '/channels');
    expect(afterRes.status).toBe(401);
  });

  it('logout clears the cookie with Max-Age=0', async () => {
    const { sessionToken } = await loginUser('sess_user1');

    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${sessionToken}`,
      },
    });

    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain('Max-Age=0');
  });

  it('other sessions remain valid after one session logs out', async () => {
    // Login twice to create two sessions
    const login1 = await loginUser('sess_user2');
    const login2 = await loginUser('sess_user2');

    // Verify both work
    const res1 = await authedFetch(login1.sessionToken, '/channels');
    expect(res1.status).toBe(200);
    const res2 = await authedFetch(login2.sessionToken, '/channels');
    expect(res2.status).toBe(200);

    // Logout session 1
    await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${login1.sessionToken}`,
      },
    });

    // Session 1 is invalidated
    const afterRes1 = await authedFetch(login1.sessionToken, '/channels');
    expect(afterRes1.status).toBe(401);

    // Session 2 still works
    const afterRes2 = await authedFetch(login2.sessionToken, '/channels');
    expect(afterRes2.status).toBe(200);
  });

  it('logout without session token is a no-op', async () => {
    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
  });
});
