import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Resolved Messages', () => {
  let token1: string;
  let token2: string;
  let token3: string;
  let channelId: string;
  let messageId: string;
  let replyId: string;

  beforeAll(async () => {
    await createTestUser('resolve_user1');
    await createTestUser('resolve_user2');
    await createTestUser('resolve_user3');
    token1 = (await loginUser('resolve_user1')).sessionToken;
    token2 = (await loginUser('resolve_user2')).sessionToken;
    token3 = (await loginUser('resolve_user3')).sessionToken;

    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'resolve-test-channel' }),
    });
    channelId = ((await chanRes.json()) as any).id;

    // user2 is a member; user3 is not.
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });

    const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Top-level thread' }),
    });
    messageId = ((await msgRes.json()) as any).id;

    const replyRes = await authedFetch(token1, `/messages/${messageId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ content: 'A reply' }),
    });
    replyId = ((await replyRes.json()) as any).id;
  });

  describe('POST /messages/:id/resolve', () => {
    it('resolves a top-level message and records who resolved it', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/resolve`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(typeof body.resolved_at).toBe('number');
      expect(body.resolved_by).toBeDefined();
    });

    it('surfaces resolved_at on the message list', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = (await res.json()) as any;
      const msg = body.messages.find((m: any) => m.id === messageId);
      expect(msg).toBeDefined();
      expect(msg.resolved_at).toBeTruthy();
      expect(msg.resolved_by).toBeTruthy();
    });

    it('lets any channel member resolve (not just the author)', async () => {
      const res = await authedFetch(token2, `/messages/${messageId}/resolve`, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('rejects a non-member with 403', async () => {
      const res = await authedFetch(token3, `/messages/${messageId}/resolve`, { method: 'POST' });
      expect(res.status).toBe(403);
    });

    it('rejects resolving a thread reply with 400', async () => {
      const res = await authedFetch(token1, `/messages/${replyId}/resolve`, { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a nonexistent message', async () => {
      const res = await authedFetch(token1, `/messages/nonexistent/resolve`, { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /messages/:id/resolve', () => {
    it('clears the resolved state', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/resolve`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      const listRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = (await listRes.json()) as any;
      const msg = body.messages.find((m: any) => m.id === messageId);
      expect(msg.resolved_at).toBeFalsy();
      expect(msg.resolved_by).toBeFalsy();
    });

    it('rejects a non-member with 403', async () => {
      const res = await authedFetch(token3, `/messages/${messageId}/resolve`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });
  });
});
