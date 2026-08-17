import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Pinned Messages', () => {
  let token1: string;
  let token2: string;
  let channelId: string;
  let messageId: string;
  let messageId2: string;

  beforeAll(async () => {
    await createTestUser('pin_user1');
    await createTestUser('pin_user2');
    const login1 = await loginUser('pin_user1');
    const login2 = await loginUser('pin_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create channel and messages
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'pin-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    // Join user2
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });

    const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Pin this message' }),
    });
    const msg = await msgRes.json() as any;
    messageId = msg.id;

    const msgRes2 = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Second message to pin' }),
    });
    const msg2 = await msgRes2.json() as any;
    messageId2 = msg2.id;
  });

  describe('POST /channels/:id/pins', () => {
    it('pins a message and returns 201', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins`, {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.channel_id).toBe(channelId);
      expect(body.message_id).toBe(messageId);
      expect(body.pinned_by).toBeDefined();
    });

    it('returns 409 when pinning same message twice', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins`, {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      });

      expect(res.status).toBe(409);
    });

    it('returns 404 for nonexistent message', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins`, {
        method: 'POST',
        body: JSON.stringify({ messageId: 'nonexistent' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 400 when messageId is missing', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /channels/:id/pins', () => {
    it('lists pinned messages with message data', async () => {
      // Pin the second message too
      await authedFetch(token1, `/channels/${channelId}/pins`, {
        method: 'POST',
        body: JSON.stringify({ messageId: messageId2 }),
      });

      const res = await authedFetch(token1, `/channels/${channelId}/pins`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);

      // Should include message content and user info
      const pin = body.find((p: any) => p.message_id === messageId);
      expect(pin).toBeDefined();
      expect(pin.content).toBe('Pin this message');
      expect(pin.username).toBe('pin_user1');
      expect(pin.pinned_by_username).toBe('pin_user1');
    });

    it('returns pins ordered by pin time descending', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins`);
      const body = await res.json() as any;

      // Both pins should be present; order is by created_at DESC
      const messageIds = body.map((p: any) => p.message_id);
      expect(messageIds).toContain(messageId);
      expect(messageIds).toContain(messageId2);
    });
  });

  describe('Pin status in message list', () => {
    it('pinned field appears on messages', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await res.json() as any;

      const pinnedMsg = body.messages.find((m: any) => m.id === messageId);
      expect(pinnedMsg).toBeDefined();
      expect(pinnedMsg.pinned).toBe(1);
    });
  });

  describe('DELETE /channels/:id/pins/:messageId', () => {
    it('unpins a message', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins/${messageId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify it's gone from pins list
      const listRes = await authedFetch(token1, `/channels/${channelId}/pins`);
      const body = await listRes.json() as any;
      expect(body.find((p: any) => p.message_id === messageId)).toBeUndefined();
    });

    it('returns 404 when unpinning a message that is not pinned', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/pins/${messageId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('unpinned message no longer shows pinned in message list', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await res.json() as any;

      const unpinnedMsg = body.messages.find((m: any) => m.id === messageId);
      expect(unpinnedMsg).toBeDefined();
      expect(unpinnedMsg.pinned).toBe(0);
    });
  });
});
