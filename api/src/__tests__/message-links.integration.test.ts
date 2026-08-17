import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Message Links', () => {
  let token1: string;
  let token2: string;
  let channelId: string;
  let messageId: string;

  beforeAll(async () => {
    await createTestUser('link_user1');
    await createTestUser('link_user2');
    const login1 = await loginUser('link_user1');
    const login2 = await loginUser('link_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'link-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });

    // Create a test message
    const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Hello from link test' }),
    });
    const msg = await msgRes.json() as any;
    messageId = msg.id;
  });

  describe('GET /messages/:id', () => {
    it('returns a single message with full data', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(messageId);
      expect(body.content).toBe('Hello from link test');
      expect(body.channel_id).toBeDefined();
      expect(body.username).toBe('link_user1');
    });

    it('includes reactions in response', async () => {
      // Add a reaction first
      await authedFetch(token1, `/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: '🔗' }),
      });

      const res = await authedFetch(token1, `/messages/${messageId}`);
      const body = await res.json() as any;
      expect(body.reactions).toBeDefined();
      expect(body.reactions.length).toBeGreaterThan(0);
      expect(body.reactions.some((r: any) => r.emoji === '🔗')).toBe(true);
    });

    it('includes mentions in response', async () => {
      // Send a message with a mention
      const mentionRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey @link_user2 check this' }),
      });
      const mentionMsg = await mentionRes.json() as any;

      const res = await authedFetch(token1, `/messages/${mentionMsg.id}`);
      const body = await res.json() as any;
      expect(body.mentions).toBeDefined();
      expect(body.mentions.some((m: any) => m.username === 'link_user2')).toBe(true);
    });

    it('includes channel_name for navigation context', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}`);
      const body = await res.json() as any;
      expect(body.channel_name).toBe('link-test-channel');
    });

    it('returns 404 for non-existent message', async () => {
      const res = await authedFetch(token1, '/messages/nonexistent123');
      expect(res.status).toBe(404);
    });

    it('returns 404 for deleted message', async () => {
      // Create and delete a message
      const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Will be deleted' }),
      });
      const msg = await msgRes.json() as any;
      await authedFetch(token1, `/messages/${msg.id}`, { method: 'DELETE' });

      const res = await authedFetch(token1, `/messages/${msg.id}`);
      expect(res.status).toBe(404);
    });

    it('accessible by any channel member', async () => {
      // token2 (link_user2) should be able to view since they joined the channel
      const res = await authedFetch(token2, `/messages/${messageId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(messageId);
    });

    it('returns reply_count for messages with thread replies', async () => {
      // Send a thread reply
      await authedFetch(token1, `/messages/${messageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'A reply' }),
      });

      const res = await authedFetch(token1, `/messages/${messageId}`);
      const body = await res.json() as any;
      expect(body.reply_count).toBeGreaterThanOrEqual(1);
    });
  });
});
