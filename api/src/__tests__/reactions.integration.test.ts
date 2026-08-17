import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, makeAdmin } from './helpers.js';

describe('Reactions', () => {
  let token1: string;
  let channelId: string;
  let messageId: string;

  beforeAll(async () => {
    await createTestUser('react_user1');
    const login = await loginUser('react_user1');
    token1 = login.sessionToken;

    // Create channel and message
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'react-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'React to this' }),
    });
    const msg = await msgRes.json() as any;
    messageId = msg.id;
  });

  describe('POST /messages/:id/reactions', () => {
    it('adds a reaction and returns 201', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: 'thumbsup' }),
      });

      expect(res.status).toBe(201);
    });

    it('duplicate reaction is idempotent', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: 'thumbsup' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('returns 404 for reaction on nonexistent message', async () => {
      const res = await authedFetch(token1, '/messages/nonexistent/reactions', {
        method: 'POST',
        body: JSON.stringify({ emoji: 'heart' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns error when emoji is missing', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('Reactions appear on messages', () => {
    it('reactions are included in message list', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await res.json() as any;

      const msg = body.messages.find((m: any) => m.id === messageId);
      expect(msg).toBeDefined();
      expect(msg.reactions).toBeDefined();
      expect(Array.isArray(msg.reactions)).toBe(true);
      expect(msg.reactions.some((r: any) => r.emoji === 'thumbsup')).toBe(true);
    });
  });

  describe('Reactions appear on thread replies', () => {
    it('reactions are included in thread reply list', async () => {
      // Create a reply in the thread
      const replyRes = await authedFetch(token1, `/messages/${messageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Thread reply to react on' }),
      });
      const reply = await replyRes.json() as any;

      // Add a reaction to the thread reply
      const reactRes = await authedFetch(token1, `/messages/${reply.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: 'fire' }),
      });
      expect(reactRes.status).toBe(201);

      // Fetch thread replies and verify reaction appears
      const repliesRes = await authedFetch(token1, `/messages/${messageId}/replies`);
      const body = await repliesRes.json() as any;

      const reactedReply = body.messages.find((m: any) => m.id === reply.id);
      expect(reactedReply).toBeDefined();
      expect(reactedReply.reactions).toBeDefined();
      expect(Array.isArray(reactedReply.reactions)).toBe(true);
      expect(reactedReply.reactions.some((r: any) => r.emoji === 'fire')).toBe(true);
    });
  });

  describe('DELETE /messages/:id/reactions/:emoji', () => {
    it('removes a reaction', async () => {
      const res = await authedFetch(token1, `/messages/${messageId}/reactions/thumbsup`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);

      // Verify reaction is gone
      const listRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await listRes.json() as any;
      const msg = body.messages.find((m: any) => m.id === messageId);
      const thumbsup = msg.reactions.find((r: any) => r.emoji === 'thumbsup');
      expect(thumbsup).toBeUndefined();
    });
  });

  // Regression: the reaction handlers used to resolve a message by id and act on
  // it without ever checking channel membership — unlike handleGetMessage, which
  // always has. Any authenticated user who knew a message id could react into a
  // private channel they were never in, persisting their name on the message and
  // broadcasting reaction_added (plus webhooks) to that channel's members.
  describe('channel membership', () => {
    let outsiderToken: string;
    let privateMessageId: string;

    beforeAll(async () => {
      await createTestUser('react_outsider');
      outsiderToken = (await loginUser('react_outsider')).sessionToken;

      // Only admins may create private channels.
      await makeAdmin('react_user1');
      const chanRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'react-private-channel', isPrivate: true }),
      });
      const privateChannelId = ((await chanRes.json()) as any).id;

      const msgRes = await authedFetch(token1, `/channels/${privateChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'members only' }),
      });
      privateMessageId = ((await msgRes.json()) as any).id;
    });

    it('rejects a non-member adding a reaction', async () => {
      const res = await authedFetch(outsiderToken, `/messages/${privateMessageId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: 'eyes' }),
      });

      expect(res.status).toBe(403);

      // The reaction must not have been persisted either — a 403 that still
      // wrote the row would leave the member-visible state just as wrong.
      const listRes = await authedFetch(token1, `/messages/${privateMessageId}`);
      const msg = await listRes.json() as any;
      expect((msg.reactions ?? []).some((r: any) => r.emoji === 'eyes')).toBe(false);
    });

    it('rejects a non-member removing a reaction', async () => {
      const res = await authedFetch(outsiderToken, `/messages/${privateMessageId}/reactions/eyes`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });
  });
});
