import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Channel Leave (soft delete)', () => {
  let token1: string;
  let token2: string;
  let _user1Id: string;
  let user2Id: string;
  let channelId: string;

  beforeAll(async () => {
    const u1 = await createTestUser('chleave_user1');
    const u2 = await createTestUser('chleave_user2');
    _user1Id = u1.id;
    user2Id = u2.id;
    const login1 = await loginUser('chleave_user1');
    const login2 = await loginUser('chleave_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create a public channel
    const res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'leave-test-channel' }),
    });
    const body = await res.json() as any;
    channelId = body.id;

    // User2 joins the public channel
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('DELETE /channels/:id/membership', () => {
    it('allows a user to leave a channel', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/membership`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('channel no longer appears in user channel list after leaving', async () => {
      // Ensure user2 has left
      await authedFetch(token2, `/channels/${channelId}/membership`, { method: 'DELETE' });

      const res = await authedFetch(token2, '/channels');
      const channels = await res.json() as any[];
      const found = channels.find((c: any) => c.id === channelId);
      expect(found).toBeUndefined();
    });

    it('user no longer appears in channel member list after leaving', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/members`);
      const members = await res.json() as any[];
      const found = members.find((m: any) => m.id === user2Id);
      expect(found).toBeUndefined();
    });

    it('user can rejoin a public channel after leaving', async () => {
      // Leave first
      await authedFetch(token2, `/channels/${channelId}/membership`, { method: 'DELETE' });

      // Rejoin
      const res = await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
      expect(res.status).toBe(200);

      // Should now appear in channel list
      const listRes = await authedFetch(token2, '/channels');
      const channels = await listRes.json() as any[];
      const found = channels.find((c: any) => c.id === channelId);
      expect(found).toBeDefined();
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await authedFetch(token1, '/channels/nonexistent/membership', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('returns 403 for non-member', async () => {
      await createTestUser('chleave_user3');
      const login3 = await loginUser('chleave_user3');
      const res = await authedFetch(login3.sessionToken, `/channels/${channelId}/membership`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });
  });
});
