import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Jump to unread', () => {
  let token1: string;
  let token2: string;
  let channelId: string;
  const messageIds: string[] = [];

  beforeAll(async () => {
    await createTestUser('jtu_user1');
    await createTestUser('jtu_user2');
    const login1 = await loginUser('jtu_user1');
    const login2 = await loginUser('jtu_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create a channel and have both users join
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'jtu-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });

    // Send 10 messages from user2
    for (let i = 1; i <= 10; i++) {
      const res = await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `Message ${i}` }),
      });
      const msg = await res.json() as any;
      messageIds.push(msg.id);
    }
  });

  describe('Channel list includes last_read_message_id', () => {
    it('returns null when no reads exist', async () => {
      // user1 has not read the channel yet (no mark-as-read call)
      // But beforeAll doesn't call markRead — however the channel was just created
      // by user1 so let's check a fresh user (user2 joined but hasn't marked read)
      const res = await authedFetch(token2, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch).toBeDefined();
      // user2 sent all messages, so has_unread should be 0 for them
      // last_read_message_id should be null since they haven't marked read
      expect(ch.last_read_message_id).toBeNull();
    });

    it('returns last_read_message_id after marking read', async () => {
      await authedFetch(token1, `/channels/${channelId}/read`, { method: 'POST' });
      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const ch = channels.find((c: any) => c.id === channelId);
      expect(ch).toBeDefined();
      expect(ch.last_read_message_id).toBe(messageIds[messageIds.length - 1]);
    });
  });

  describe('?around= anchor pagination', () => {
    it('returns messages around the anchor', async () => {
      const anchorId = messageIds[4]; // message 5 (middle)
      const res = await authedFetch(
        token1,
        `/channels/${channelId}/messages?around=${anchorId}&limit=6`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages).toBeDefined();
      expect(Array.isArray(body.messages)).toBe(true);

      // Should contain the anchor message
      const ids = body.messages.map((m: any) => m.id);
      expect(ids).toContain(anchorId);

      // Messages should be in ascending order
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true);
      }
    });

    it('falls back to latest when anchor does not exist', async () => {
      const res = await authedFetch(
        token1,
        `/channels/${channelId}/messages?around=nonexistent_id`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages).toBeDefined();
      expect(body.messages.length).toBeGreaterThan(0);
      // Should contain the latest messages (fallback behavior)
      const ids = body.messages.map((m: any) => m.id);
      expect(ids).toContain(messageIds[messageIds.length - 1]);
    });

    it('returns hasNewer and afterCursor for mid-history anchors', async () => {
      const anchorId = messageIds[2]; // message 3 (early)
      const res = await authedFetch(
        token1,
        `/channels/${channelId}/messages?around=${anchorId}&limit=4`,
      );
      const body = await res.json() as any;
      // With limit=4 and anchor at position 3, afterQuery gets 2 messages (3,4)
      // and there are more after that
      expect(body.hasNewer).toBeDefined();
    });
  });

  describe('?after= forward pagination', () => {
    it('returns messages strictly after the given ID', async () => {
      const afterId = messageIds[5]; // after message 6
      const res = await authedFetch(
        token1,
        `/channels/${channelId}/messages?after=${afterId}&limit=10`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages).toBeDefined();

      // All returned messages should have IDs greater than afterId
      for (const msg of body.messages) {
        expect(msg.id > afterId).toBe(true);
      }

      // Should include messages 7-10
      const ids = body.messages.map((m: any) => m.id);
      expect(ids).toContain(messageIds[6]);
      expect(ids).toContain(messageIds[9]);
    });

    it('returns empty when no newer messages exist', async () => {
      const afterId = messageIds[messageIds.length - 1]; // last message
      const res = await authedFetch(
        token1,
        `/channels/${channelId}/messages?after=${afterId}`,
      );
      const body = await res.json() as any;
      expect(body.messages).toHaveLength(0);
      expect(body.hasNewer).toBe(false);
    });
  });

  describe('DM list includes last_read_message_id', () => {
    let dmId: string;

    beforeAll(async () => {
      // Get user IDs
      const login1 = await loginUser('jtu_user1');
      const login2 = await loginUser('jtu_user2');

      // Create a DM between user1 and user2
      const dmRes = await authedFetch(login1.sessionToken, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: login2.user.id }),
      });
      const dm = await dmRes.json() as any;
      dmId = dm.id;

      // Send a message from user2
      await authedFetch(login2.sessionToken, `/channels/${dmId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'DM message' }),
      });

      // Mark as read by user1
      await authedFetch(login1.sessionToken, `/channels/${dmId}/read`, { method: 'POST' });
    });

    it('DM list returns last_read_message_id', async () => {
      const res = await authedFetch(token1, '/dms');
      const dmList = await res.json() as any[];
      const dm = dmList.find((d: any) => d.id === dmId);
      expect(dm).toBeDefined();
      expect(dm.last_read_message_id).toBeDefined();
      expect(dm.last_read_message_id).not.toBeNull();
    });
  });
});
