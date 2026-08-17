import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch } from './helpers.js';

describe('GET /users/search', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    // Create several users with different names
    await createTestUser('usearch_alice', 'testpass123', 'Alice Anderson');
    await createTestUser('usearch_bob', 'testpass123', 'Bob Baker');
    await createTestUser('usearch_carol', 'testpass123', 'Carol Clark');
    await createTestUser('usearch_dave', 'testpass123');

    const login = await loginUser('usearch_alice');
    token = login.sessionToken;

    // Create a channel (alice auto-joins as creator)
    const chRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'usearch-test-channel' }),
    });
    const ch = (await chRes.json() as any) as any;
    channelId = ch.id;

    // Bob joins the channel
    const bobLogin = await loginUser('usearch_bob');
    await authedFetch(bobLogin.sessionToken, `/channels/${channelId}/join`, {
      method: 'POST',
    });
  });

  it('returns matching users by username', async () => {
    const res = await authedFetch(token, '/users/search?q=usearch_al');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((u: any) => u.username === 'usearch_alice')).toBe(true);
  });

  it('returns matching users by display_name', async () => {
    const res = await authedFetch(token, '/users/search?q=Baker');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results.some((u: any) => u.username === 'usearch_bob')).toBe(true);
  });

  it('is case-insensitive', async () => {
    const res = await authedFetch(token, '/users/search?q=ALICE');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results.some((u: any) => u.username === 'usearch_alice')).toBe(true);
  });

  it('excludes existing channel members when channelId is provided', async () => {
    // alice and bob are members of the channel
    const res = await authedFetch(token, `/users/search?q=usearch_&channel=${channelId}`);
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    const usernames = results.map((u: any) => u.username);
    // alice and bob should be excluded (they are members)
    expect(usernames).not.toContain('usearch_alice');
    expect(usernames).not.toContain('usearch_bob');
    // carol and dave should be included
    expect(usernames).toContain('usearch_carol');
    expect(usernames).toContain('usearch_dave');
  });

  it('returns empty for no matches', async () => {
    const res = await authedFetch(token, '/users/search?q=zzzznonexistent');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results).toHaveLength(0);
  });

  it('returns all users without query parameter', async () => {
    const res = await authedFetch(token, '/users/search');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results.length).toBeGreaterThan(0);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${BASE_URL}/users/search?q=alice`);
    expect(res.status).toBe(401);
  });

  it('returns expected fields', async () => {
    const res = await authedFetch(token, '/users/search?q=usearch_alice');
    expect(res.status).toBe(200);
    const results = (await res.json() as any) as any[];
    expect(results.length).toBeGreaterThanOrEqual(1);
    const alice = results.find((u: any) => u.username === 'usearch_alice');
    expect(alice).toBeDefined();
    expect(alice.id).toBeDefined();
    expect(alice.username).toBe('usearch_alice');
    expect(alice.display_name).toBe('Alice Anderson');
    // Should not expose password_hash or other sensitive fields
    expect(alice.password_hash).toBeUndefined();
  });
});
