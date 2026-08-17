import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Search: filter-only (no text query)', () => {
  let tokenA: string;
  let tokenB: string;
  let userAId: string;
  let userBId: string;
  let channelId1: string;
  let channelId2: string;

  beforeAll(async () => {
    try { await createTestUser('search_fo_a'); } catch {}
    try { await createTestUser('search_fo_b'); } catch {}
    const a = await loginUser('search_fo_a');
    const b = await loginUser('search_fo_b');
    tokenA = a.sessionToken;
    tokenB = b.sessionToken;
    userAId = a.user.id;
    userBId = b.user.id;

    // Create two channels
    const ch1Res = await authedFetch(tokenA, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'fo-channel-one' }),
    });
    channelId1 = ((await ch1Res.json()) as any).id;

    const ch2Res = await authedFetch(tokenA, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'fo-channel-two' }),
    });
    channelId2 = ((await ch2Res.json()) as any).id;

    // User B joins both channels
    await authedFetch(tokenB, `/channels/${channelId1}/join`, { method: 'POST' });
    await authedFetch(tokenB, `/channels/${channelId2}/join`, { method: 'POST' });

    // Seed messages
    // User A posts in channel 1
    await authedFetch(tokenA, `/channels/${channelId1}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Alpha message one' }),
    });
    await authedFetch(tokenA, `/channels/${channelId1}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Alpha message two' }),
    });
    // User B posts in channel 1
    await authedFetch(tokenB, `/channels/${channelId1}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Beta message in ch1' }),
    });
    // User A posts in channel 2
    await authedFetch(tokenA, `/channels/${channelId2}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Alpha in channel two' }),
    });
    // User B posts in channel 2
    await authedFetch(tokenB, `/channels/${channelId2}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Beta in channel two' }),
    });
  });

  it('from filter with empty q returns messages from that user', async () => {
    const res = await authedFetch(tokenA, `/search?q=&from=${userAId}`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r: any) => r.user_id === userAId)).toBe(true);
    expect(total).toBe(results.length);
  });

  it('from + channel filter with empty q returns only that channel messages', async () => {
    const res = await authedFetch(tokenA, `/search?q=&from=${userAId}&channel=${channelId1}`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(results.length).toBe(2); // User A posted 2 messages in channel 1
    expect(results.every((r: any) => r.user_id === userAId && r.channel_id === channelId1)).toBe(true);
    expect(total).toBe(2);
  });

  it('since/until time bounds apply on filter-only path', async () => {
    // Future since → no results
    const future = Math.floor(Date.now() / 1000) + 3600;
    const res = await authedFetch(tokenA, `/search?q=&from=${userAId}&since=${future}`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(results.length).toBe(0);
    expect(total).toBe(0);
  });

  it('until in past returns no results', async () => {
    const res = await authedFetch(tokenA, `/search?q=&from=${userAId}&until=1`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(results.length).toBe(0);
    expect(total).toBe(0);
  });

  it('count matches result count on filter-only path', async () => {
    const res = await authedFetch(tokenA, `/search?q=&from=${userBId}`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(total).toBe(results.length);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('pagination works on filter-only path', async () => {
    const page1Res = await authedFetch(tokenA, `/search?q=&from=${userAId}&limit=2&offset=0`);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as any;
    expect(page1.results.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.offset).toBe(0);

    const page2Res = await authedFetch(tokenA, `/search?q=&from=${userAId}&limit=2&offset=2`);
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as any;
    expect(page2.results.length).toBeGreaterThanOrEqual(1);
    expect(page2.offset).toBe(2);

    // Pages must not overlap
    const page1Ids = new Set(page1.results.map((r: any) => r.id));
    expect(page2.results.every((r: any) => !page1Ids.has(r.id))).toBe(true);
  });

  it('q="" with no filters still returns empty messages (regression guard)', async () => {
    const res = await authedFetch(tokenA, '/search?q=');
    expect(res.status).toBe(200);
    const { results, total, hasMore } = (await res.json()) as any;
    expect(results).toEqual([]);
    expect(total).toBe(0);
    expect(hasMore).toBe(false);
  });

  it('channel-only filter with empty q returns messages from that channel', async () => {
    const res = await authedFetch(tokenA, `/search?q=&channel=${channelId2}`);
    expect(res.status).toBe(200);
    const { results, total } = (await res.json()) as any;
    expect(results.length).toBe(2); // Both users posted 1 message each in channel 2
    expect(results.every((r: any) => r.channel_id === channelId2)).toBe(true);
    expect(total).toBe(2);
  });

  it('filter-only results are ordered by created_at DESC', async () => {
    const res = await authedFetch(tokenA, `/search?q=&from=${userAId}`);
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as any;
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].created_at).toBeGreaterThanOrEqual(results[i].created_at);
    }
  });
});
