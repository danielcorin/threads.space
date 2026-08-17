import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch } from './helpers.js';

// Tests for the sync-state KV routes. Keys are user-scoped server-side
// (docs/improvement-plan.md #9): each user sees only their own keys.
describe('sync-state', () => {
  let token: string;
  let token2: string;

  beforeAll(async () => {
    await createTestUser('syncst_user1');
    const login = await loginUser('syncst_user1');
    token = login.sessionToken;
    await createTestUser('syncst_user2');
    const login2 = await loginUser('syncst_user2');
    token2 = login2.sessionToken;
  });

  it('requires auth', async () => {
    const res = await fetch(`${BASE_URL}/sync-state/syncst-test-noauth`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a missing key', async () => {
    const res = await authedFetch(token, '/sync-state/syncst-test-missing');
    expect(res.status).toBe(404);
  });

  it('round-trips a value via PUT then GET', async () => {
    const put = await authedFetch(token, '/sync-state/syncst-test-rt', {
      method: 'PUT',
      body: JSON.stringify({ value: 'cursor-123' }),
    });
    expect(put.status).toBe(200);

    const get = await authedFetch(token, '/sync-state/syncst-test-rt');
    expect(get.status).toBe(200);
    const body = (await get.json()) as any;
    expect(body.key).toBe('syncst-test-rt');
    expect(body.value).toBe('cursor-123');
    expect(typeof body.updated_at).toBe('number');
  });

  it('upserts on repeated PUT to the same key', async () => {
    await authedFetch(token, '/sync-state/syncst-test-upsert', {
      method: 'PUT',
      body: JSON.stringify({ value: 'v1' }),
    });
    await authedFetch(token, '/sync-state/syncst-test-upsert', {
      method: 'PUT',
      body: JSON.stringify({ value: 'v2' }),
    });
    const get = await authedFetch(token, '/sync-state/syncst-test-upsert');
    const body = (await get.json()) as any;
    expect(body.value).toBe('v2');
  });

  it('rejects a PUT without a value', async () => {
    const res = await authedFetch(token, '/sync-state/syncst-test-novalue', {
      method: 'PUT',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('lists keys by prefix', async () => {
    await authedFetch(token, '/sync-state/syncst-pfx:a', {
      method: 'PUT',
      body: JSON.stringify({ value: '1' }),
    });
    await authedFetch(token, '/sync-state/syncst-pfx:b', {
      method: 'PUT',
      body: JSON.stringify({ value: '2' }),
    });
    const res = await authedFetch(token, '/sync-state?prefix=syncst-pfx:');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as any[];
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['syncst-pfx:a', 'syncst-pfx:b']);
  });

  it('isolates keys between users', async () => {
    await authedFetch(token, '/sync-state/syncst-iso', {
      method: 'PUT',
      body: JSON.stringify({ value: 'user1-cursor' }),
    });

    // user2 cannot read user1's key
    const res = await authedFetch(token2, '/sync-state/syncst-iso');
    expect(res.status).toBe(404);

    // user2 cannot enumerate user1's keys by prefix
    const list = await authedFetch(token2, '/sync-state?prefix=syncst-iso');
    const rows = (await list.json()) as any[];
    expect(rows.length).toBe(0);

    // user2 writing the same key does not clobber user1's value
    await authedFetch(token2, '/sync-state/syncst-iso', {
      method: 'PUT',
      body: JSON.stringify({ value: 'user2-cursor' }),
    });
    const get1 = await authedFetch(token, '/sync-state/syncst-iso');
    const body1 = (await get1.json()) as any;
    expect(body1.value).toBe('user1-cursor');
    const get2 = await authedFetch(token2, '/sync-state/syncst-iso');
    const body2 = (await get2.json()) as any;
    expect(body2.value).toBe('user2-cursor');
  });

  it('escapes LIKE wildcards in the prefix', async () => {
    await authedFetch(token, '/sync-state/syncst-wild_x', {
      method: 'PUT',
      body: JSON.stringify({ value: '1' }),
    });
    await authedFetch(token, '/sync-state/syncst-wildax', {
      method: 'PUT',
      body: JSON.stringify({ value: '2' }),
    });
    // '_' must match literally, not as a single-char wildcard
    const res = await authedFetch(token, '/sync-state?prefix=syncst-wild_');
    const rows = (await res.json()) as any[];
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('syncst-wild_x');
    expect(keys).not.toContain('syncst-wildax');
  });
});
