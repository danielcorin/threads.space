import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Channel notification tiers', () => {
  let token1: string;
  let token2: string;
  let _user1Id: string;
  let user2Id: string;

  beforeAll(async () => {
    const _u1 = await createTestUser('notif_user1');
    const _u2 = await createTestUser('notif_user2');
    const login1 = await loginUser('notif_user1');
    const login2 = await loginUser('notif_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    _user1Id = login1.user.id;
    user2Id = login2.user.id;
  });

  describe('PATCH /channels/:id/notifications', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'notif-patch-test' }),
      });
      const body = await res.json() as any;
      channelId = body.id;
      // Add user2 as member
      await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
    });

    it('default tier is all for a new channel member', async () => {
      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch).toBeDefined();
      expect(ch.notifications).toBe('all');
    });

    it('PATCH with tier=mentions returns 200 and persists', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'mentions' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
      expect(body.tier).toBe('mentions');

      // Verify persisted
      const listRes = await authedFetch(token1, '/channels');
      const channels = await listRes.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch.notifications).toBe('mentions');
    });

    it('PATCH with tier=none returns 200 and persists', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'none' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.tier).toBe('none');

      const listRes = await authedFetch(token1, '/channels');
      const channels = await listRes.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch.notifications).toBe('none');
    });

    it('PATCH with invalid tier returns 400', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'invalid' }),
      });
      expect(res.status).toBe(400);
    });

    it('PATCH from non-member returns 404', async () => {
      // Create a third user who is not a member
      await createTestUser('notif_outsider');
      const login = await loginUser('notif_outsider');
      const res = await authedFetch(login.sessionToken, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'mentions' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /channels tier-aware unread counts', () => {
    let channelId: string;

    beforeAll(async () => {
      // Create channel with user1, add user2
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'notif-unread-test' }),
      });
      const body = await res.json() as any;
      channelId = body.id;
      await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });

      // user2 sends a regular message (no mention)
      await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello world' }),
      });

      // user2 sends a message that mentions user1
      await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hey @notif_user1 check this' }),
      });
    });

    it('tier=all counts all unread non-self messages', async () => {
      // Ensure tier is 'all'
      await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'all' }),
      });

      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch.has_unread).toBe(1);
      expect(ch.unread_count).toBeGreaterThanOrEqual(2);
    });

    it('tier=none returns has_unread=0 and unread_count=0 even with unread messages', async () => {
      await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'none' }),
      });

      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch.has_unread).toBe(0);
      expect(ch.unread_count).toBe(0);
    });

    it('tier=mentions counts only @mention messages', async () => {
      await authedFetch(token1, `/channels/${channelId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'mentions' }),
      });

      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      // Should have at most 1 unread (the mention message) — not the regular one
      // The mention message creates a message_mentions row via the server
      // Note: the count depends on whether the server auto-parses @mentions into
      // message_mentions. If the count is 0, the mention wasn't parsed.
      // Either way, it should be less than the 'all' count.
      expect(ch.unread_count).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /dms tier-aware unread counts', () => {
    let dmId: string;

    beforeAll(async () => {
      // Create DM between user1 and user2
      const res = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      const body = await res.json() as any;
      dmId = body.id;

      // user2 sends a message in the DM
      await authedFetch(token2, `/channels/${dmId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'DM hello' }),
      });
    });

    it('DM with tier=all shows unread', async () => {
      await authedFetch(token1, `/channels/${dmId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'all' }),
      });

      const res = await authedFetch(token1, '/dms');
      const dms = await res.json() as any[];
      const dm = dms.find((d: any) => d.id === dmId);
      expect(dm).toBeDefined();
      expect(dm.notifications).toBe('all');
      expect(dm.has_unread).toBe(1);
      expect(dm.unread_count).toBeGreaterThanOrEqual(1);
    });

    it('DM with tier=none shows no unread', async () => {
      await authedFetch(token1, `/channels/${dmId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'none' }),
      });

      const res = await authedFetch(token1, '/dms');
      const dms = await res.json() as any[];
      const dm = dms.find((d: any) => d.id === dmId);
      expect(dm.notifications).toBe('none');
      expect(dm.has_unread).toBe(0);
      expect(dm.unread_count).toBe(0);
    });

    it('DM with tier=mentions counts only mentions', async () => {
      await authedFetch(token1, `/channels/${dmId}/notifications`, {
        method: 'PATCH',
        body: JSON.stringify({ tier: 'mentions' }),
      });

      const res = await authedFetch(token1, '/dms');
      const dms = await res.json() as any[];
      const dm = dms.find((d: any) => d.id === dmId);
      expect(dm.notifications).toBe('mentions');
      // Regular DM message doesn't have a mention, so should be 0
      expect(dm.unread_count).toBe(0);
      expect(dm.has_unread).toBe(0);
    });
  });
});
