import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch } from './helpers.js';

describe('PATCH /users/me', () => {
  let token: string;

  beforeAll(async () => {
    await createTestUser('usrme_user1');
    const login = await loginUser('usrme_user1');
    token = login.sessionToken;
  });

  it('updates display name successfully', async () => {
    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'New Display Name' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.displayName).toBe('New Display Name');
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE_URL}/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Sneaky' }),
    });

    expect(res.status).toBe(401);
  });

  it('trims long display names to 100 chars', async () => {
    const longName = 'A'.repeat(150);
    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: longName }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.displayName).toBe('A'.repeat(100));
  });

  it('returns updated displayName in response', async () => {
    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: '  Trimmed Spaces  ' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.displayName).toBe('Trimmed Spaces');
  });

  it('accepts a valid code theme', async () => {
    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ codeTheme: 'dracula' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.codeTheme).toBe('dracula');
  });

  it('clears the code theme when null is passed', async () => {
    // First set it to a non-default value.
    await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ codeTheme: 'github-dark' }),
    });

    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ codeTheme: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.codeTheme).toBeNull();
  });

  it('rejects an unknown code theme with 400', async () => {
    const res = await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ codeTheme: 'made-up-theme' }),
    });

    expect(res.status).toBe(400);
  });

  it('GET /users/me returns code_theme field', async () => {
    // Set a known value first so we can assert on it.
    await authedFetch(token, '/users/me', {
      method: 'PATCH',
      body: JSON.stringify({ codeTheme: 'nord' }),
    });

    const res = await authedFetch(token, '/users/me');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.code_theme).toBe('nord');
  });
});
