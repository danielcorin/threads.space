import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Channel update broadcasts', () => {
  let token1: string;
  let _token2: string;
  let user2Id: string;

  beforeAll(async () => {
    await createTestUser('cupd_user1');
    const u2 = await createTestUser('cupd_user2', 'testpass123', 'User Two Display');
    user2Id = u2.id;
    const login1 = await loginUser('cupd_user1');
    const login2 = await loginUser('cupd_user2');
    token1 = login1.sessionToken;
    _token2 = login2.sessionToken;
  });

  describe('POST /channels/:id/members - member_added response', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'cupd-member-add', isPrivate: false }),
      });
      const body = await res.json() as any;
      channelId = body.id;
    });

    it('returns 201 when adding a member', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      expect(res.status).toBe(201);
    });

    it('added member appears in the member list with username and display_name', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/members`);
      expect(res.status).toBe(200);
      const members = await res.json() as any[];

      const addedMember = members.find((m: any) => m.id === user2Id);
      expect(addedMember).toBeDefined();
      expect(addedMember.username).toBe('cupd_user2');
      expect(addedMember.display_name).toBe('User Two Display');
    });

    it('adding the same member again is idempotent', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      // Already a member, should return 200 (not error)
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /channels/:id - auto_respond_bot_id update', () => {
    let channelId: string;
    let botUserId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'cupd-auto-respond' }),
      });
      const body = await res.json() as any;
      channelId = body.id;

      // Create a bot and add as member
      const botBody = await createTestUser('cupd_testbot', 'testpass123', undefined, 'bot');
      botUserId = botBody.id;

      await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: botUserId }),
      });
    });

    it('PATCH response includes ok when setting auto_respond_bot_id', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: botUserId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('GET confirms auto_respond_bot_id is persisted', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await res.json() as any;
      expect(channel.auto_respond_bot_id).toBe(botUserId);
    });

    it('clearing auto_respond_bot_id with null works', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: null }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.auto_respond_bot_id).toBeNull();
    });
  });

  describe('PATCH /channels/:id - channel_updated fields', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'cupd-fields-test' }),
      });
      const body = await res.json() as any;
      channelId = body.id;
    });

    it('updating description returns ok', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: 'New description' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);

      // Verify the update persisted
      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.description).toBe('New description');
    });

    it('updating multiple fields at once works', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: 'Updated again',
          processing_mode: 'serial',
        }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.description).toBe('Updated again');
      expect(channel.processing_mode).toBe('serial');
    });

    it('PATCH with no fields returns 400', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});
