import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Messages', () => {
  let token1: string;
  let token2: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('msg_user1');
    await createTestUser('msg_user2');
    const login1 = await loginUser('msg_user1');
    const login2 = await loginUser('msg_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create a channel and have both users join
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'msg-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('limit clamping', () => {
    it('limit=-1 does not return the entire channel', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages?limit=-1`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages.length).toBeLessThanOrEqual(1);
    });

    it('limit=abc falls back to the default instead of 500ing', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages?limit=abc`);
      expect(res.status).toBe(200);
    });

    it('limit=0 and oversized limits are clamped', async () => {
      const res0 = await authedFetch(token1, `/channels/${channelId}/messages?limit=0`);
      expect(res0.status).toBe(200);
      const resBig = await authedFetch(token1, `/channels/${channelId}/messages?limit=99999`);
      expect(resBig.status).toBe(200);
      const big = await resBig.json() as any;
      expect(big.messages.length).toBeLessThanOrEqual(100);
    });

    it('thread replies clamp limits too', async () => {
      const parentRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'limit clamp parent' }),
      });
      const parent = await parentRes.json() as any;
      const res = await authedFetch(token1, `/messages/${parent.id}/replies?limit=-1`);
      expect(res.status).toBe(200);
      const resNaN = await authedFetch(token1, `/messages/${parent.id}/replies?limit=zzz`);
      expect(resNaN.status).toBe(200);
    });
  });

  describe('idempotent sends', () => {
    it('re-sending with the same idempotencyKey returns the original message', async () => {
      const key = `idem-${Date.now()}`;
      const res1 = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Exactly once', idempotencyKey: key }),
      });
      expect(res1.status).toBe(201);
      const first = await res1.json() as any;

      const res2 = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Exactly once', idempotencyKey: key }),
      });
      expect(res2.status).toBe(200);
      const second = await res2.json() as any;
      expect(second.id).toBe(first.id);

      const list = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await list.json() as any;
      const copies = body.messages.filter((m: any) => m.content === 'Exactly once');
      expect(copies.length).toBe(1);
    });

    it('the same key from a different user creates a separate message', async () => {
      const key = `idem-cross-${Date.now()}`;
      const res1 = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'mine', idempotencyKey: key }),
      });
      expect(res1.status).toBe(201);
      const res2 = await authedFetch(token2, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'also mine', idempotencyKey: key }),
      });
      expect(res2.status).toBe(201);
    });
  });

  describe('POST /channels/:id/messages', () => {
    it('sends a message and returns 201', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hello world' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.content).toBe('Hello world');
      expect(body.username).toBe('msg_user1');
    });

    it('returns error for empty content', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns error for whitespace-only content', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '   ' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /channels/:id/messages', () => {
    it('returns sent messages', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.messages).toBeDefined();
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body.messages.length).toBeGreaterThan(0);
      expect(body.messages.some((m: any) => m.content === 'Hello world')).toBe(true);
    });
  });

  describe('PATCH /messages/:id', () => {
    let messageId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Original message' }),
      });
      const body = await res.json() as any;
      messageId = body.id;
    });

    it('owner can edit message', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'Edited message' }),
      });

      expect(res.status).toBe(200);
    });

    it('non-owner gets 403', async () => {
      const res = await authedFetch(token2, `/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'Hacked!' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /messages/:id', () => {
    let messageId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'To be deleted' }),
      });
      const body = await res.json() as any;
      messageId = body.id;
    });

    it('non-owner gets 403', async () => {
      const res = await authedFetch(token2, `/messages/${messageId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });

    it('owner can soft-delete message', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
    });

    it('deleted messages do not appear in message list', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await res.json() as any;

      const deleted = body.messages.find((m: any) => m.id === messageId);
      expect(deleted).toBeUndefined();
    });
  });

  describe('Pagination', () => {
    let paginationChannelId: string;

    beforeAll(async () => {
      // Create a channel with several messages for pagination testing
      const chanRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'msg-pagination-chan' }),
      });
      const chan = await chanRes.json() as any;
      paginationChannelId = chan.id;

      // Send 5 messages
      for (let i = 1; i <= 5; i++) {
        await authedFetch(token1, `/channels/${paginationChannelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: `Pagination message ${i}` }),
        });
      }
    });

    it('respects limit parameter', async () => {
      const res = await authedFetch(
        token1,
        `/channels/${paginationChannelId}/messages?limit=2`,
      );
      const body = await res.json() as any;

      expect(body.messages.length).toBe(2);
      expect(body.cursor).toBeTruthy();
    });

    it('cursor-based pagination returns next page', async () => {
      const firstRes = await authedFetch(
        token1,
        `/channels/${paginationChannelId}/messages?limit=3`,
      );
      const firstPage = await firstRes.json() as any;

      expect(firstPage.cursor).toBeTruthy();

      const secondRes = await authedFetch(
        token1,
        `/channels/${paginationChannelId}/messages?limit=3&cursor=${firstPage.cursor}`,
      );
      const secondPage = await secondRes.json() as any;

      expect(secondPage.messages.length).toBe(2);
      // No overlap
      const firstIds = firstPage.messages.map((m: any) => m.id);
      const secondIds = secondPage.messages.map((m: any) => m.id);
      for (const id of secondIds) {
        expect(firstIds).not.toContain(id);
      }
    });
  });

  describe('POST /channels/:id/read', () => {
    it('marks channel as read', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/read`, {
        method: 'POST',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);

      // Verify has_unread is 0 now
      const listRes = await authedFetch(token1, '/channels');
      const channels = await listRes.json() as any;
      const chan = channels.find((c: any) => c.id === channelId);
      expect(chan.has_unread).toBe(0);
    });
  });
});
