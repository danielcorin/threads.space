import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser, authedFetch } from './helpers.js';

describe('GET /drafts', () => {
  let token1: string;
  let token2: string;
  let channelId1: string;
  let channelId2: string;

  beforeAll(async () => {
    await createTestUser('dftlst_user1');
    await createTestUser('dftlst_user2');
    const login1 = await loginUser('dftlst_user1');
    const login2 = await loginUser('dftlst_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create two channels
    const ch1Res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'dftlst-chan1' }),
    });
    channelId1 = (await ch1Res.json() as any).id;

    const ch2Res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'dftlst-chan2' }),
    });
    channelId2 = (await ch2Res.json() as any).id;

    // user2 joins both channels
    await authedFetch(token2, `/channels/${channelId1}/join`, { method: 'POST' });
    await authedFetch(token2, `/channels/${channelId2}/join`, { method: 'POST' });
  });

  it('returns empty array when no drafts exist', async () => {
    const res = await authedFetch(token1, '/drafts');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel_ids).toEqual([]);
  });

  it('returns channel IDs after saving drafts to multiple channels', async () => {
    await authedFetch(token1, `/channels/${channelId1}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'draft in chan1' }),
    });
    await authedFetch(token1, `/channels/${channelId2}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'draft in chan2' }),
    });

    const res = await authedFetch(token1, '/drafts');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel_ids).toContain(channelId1);
    expect(body.channel_ids).toContain(channelId2);
    expect(body.channel_ids.length).toBe(2);
  });

  it('only returns channels with non-empty drafts after clearing one', async () => {
    // Clear draft in channel 1
    await authedFetch(token1, `/channels/${channelId1}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: '' }),
    });

    const res = await authedFetch(token1, '/drafts');
    const body = await res.json() as any;
    expect(body.channel_ids).toContain(channelId2);
    expect(body.channel_ids).not.toContain(channelId1);
    expect(body.channel_ids.length).toBe(1);
  });

  it('drafts are per-user (user2 drafts do not appear for user1)', async () => {
    // user2 saves a draft
    await authedFetch(token2, `/channels/${channelId1}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'user2 draft' }),
    });

    // user1 should not see user2's draft
    const res1 = await authedFetch(token1, '/drafts');
    const body1 = await res1.json() as any;
    // user1 only has draft in channelId2 (from previous test)
    expect(body1.channel_ids).not.toContain(channelId1);

    // user2 should see their own draft
    const res2 = await authedFetch(token2, '/drafts');
    const body2 = await res2.json() as any;
    expect(body2.channel_ids).toContain(channelId1);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE_URL}/drafts`);
    expect(res.status).toBe(401);
  });
});
