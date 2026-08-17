import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('requireChannelMembership middleware', () => {
  let token1: string;
  let token2: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('membership_user1');
    await createTestUser('membership_user2');
    const login1 = await loginUser('membership_user1');
    const login2 = await loginUser('membership_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // user1 creates a channel (auto-member)
    const res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'membership-test-chan' }),
    });
    const body = await res.json() as any;
    channelId = body.id;
  });

  describe('non-member is blocked', () => {
    it('non-member cannot list messages', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/messages`);
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });

    it('non-member cannot send messages', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'should be blocked' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });

    it('non-member cannot mark channel read', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/read`, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });

    it('non-member cannot update channel', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'hijacked' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });

    it('non-member cannot get thread replies for a message in a channel they are not in', async () => {
      // user1 sends a message in the channel
      const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'parent for thread reply test' }),
      });
      const msg = await msgRes.json() as any;

      // user2 (non-member) tries to get replies
      const res = await authedFetch(token2, `/messages/${msg.id}/replies`);
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });
  });

  describe('member is allowed', () => {
    it('member can list messages', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      expect(res.status).toBe(200);
    });

    it('member can send messages', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello from member' }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe('join grants access, leave revokes access', () => {
    it('after joining, user can access resources', async () => {
      // user2 joins the channel
      const joinRes = await authedFetch(token2, `/channels/${channelId}/join`, {
        method: 'POST',
      });
      expect(joinRes.status).toBe(200);

      // user2 can now list messages
      const listRes = await authedFetch(token2, `/channels/${channelId}/messages`);
      expect(listRes.status).toBe(200);

      // user2 can now send messages
      const sendRes = await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello after joining' }),
      });
      expect(sendRes.status).toBe(201);
    });

    it('after leaving, user loses access', async () => {
      // user2 leaves the channel
      const leaveRes = await authedFetch(token2, `/channels/${channelId}/leave`, {
        method: 'POST',
      });
      expect(leaveRes.status).toBe(200);

      // user2 can no longer list messages
      const res = await authedFetch(token2, `/channels/${channelId}/messages`);
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error).toBe('Not a member of this channel');
    });
  });
});
