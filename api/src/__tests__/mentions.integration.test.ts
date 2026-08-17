import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Mentions', () => {
  let token1: string;
  let token2: string;
  let token3: string;
  let _user1: any;
  let user2: any;
  let user3: any;
  let channelId: string;

  beforeAll(async () => {
    _user1 = await createTestUser('mention_user1');
    user2 = await createTestUser('mention_user2');
    user3 = await createTestUser('mention_user3');
    const login1 = await loginUser('mention_user1');
    const login2 = await loginUser('mention_user2');
    const login3 = await loginUser('mention_user3');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    token3 = login3.sessionToken;

    // Create a channel and have user1 + user2 join
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'mention-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
    await authedFetch(token3, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('Mentions re-parsed on edit', () => {
    it('an edit that adds a mention creates the mention record', async () => {
      const sendRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'no mention yet (edit-add)' }),
      });
      const msg = await sendRes.json() as any;

      const editRes = await authedFetch(token1, `/messages/${msg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'now pinging @mention_user3 (edit-add)' }),
      });
      expect(editRes.status).toBe(200);

      const mentionsRes = await authedFetch(token3, '/mentions');
      const mentions = await mentionsRes.json() as any;
      expect(mentions.messages.find((m: any) => m.id === msg.id)).toBeDefined();
    });

    it('an edit that removes a mention deletes the mention record', async () => {
      const sendRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hey @mention_user3 (edit-remove)' }),
      });
      const msg = await sendRes.json() as any;

      const editRes = await authedFetch(token1, `/messages/${msg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'nevermind, nobody (edit-remove)' }),
      });
      expect(editRes.status).toBe(200);

      const mentionsRes = await authedFetch(token3, '/mentions');
      const mentions = await mentionsRes.json() as any;
      expect(mentions.messages.find((m: any) => m.id === msg.id)).toBeUndefined();
    });
  });

  describe('Mention extraction and storage', () => {
    it('message with @mention stores mention data', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey @mention_user2 check this out' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.mentions).toBeDefined();
      expect(body.mentions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: user2.id, username: 'mention_user2' }),
        ]),
      );
    });

    it('@mention of non-existent user is ignored', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey @nobody_here what?' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.mentions).toEqual([]);
    });

    it('multiple mentions in one message', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '@mention_user2 and @mention_user3 hello' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.mentions).toHaveLength(2);
      const usernames = body.mentions.map((m: any) => m.username).sort();
      expect(usernames).toEqual(['mention_user2', 'mention_user3']);
    });

    it('duplicate @mention only stored once', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '@mention_user2 hey @mention_user2 again' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.mentions).toHaveLength(1);
      expect(body.mentions[0].username).toBe('mention_user2');
    });
  });

  describe('Message response includes mentions', () => {
    it('GET messages returns mentions in each message', async () => {
      // Send a message with a mention
      const sendRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Check in @mention_user3 please' }),
      });
      const sent = await sendRes.json() as any;

      // Fetch messages
      const listRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      expect(listRes.status).toBe(200);
      const body = await listRes.json() as any;

      const found = body.messages.find((m: any) => m.id === sent.id);
      expect(found).toBeDefined();
      expect(found.mentions).toBeDefined();
      expect(found.mentions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: user3.id, username: 'mention_user3' }),
        ]),
      );
    });
  });

  describe('GET /mentions', () => {
    let mentionChannelId: string;

    beforeAll(async () => {
      // Create a fresh channel for GET /mentions tests
      const chanRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'mentions-get-channel' }),
      });
      const chan = await chanRes.json() as any;
      mentionChannelId = chan.id;

      await authedFetch(token2, `/channels/${mentionChannelId}/join`, { method: 'POST' });
      await authedFetch(token3, `/channels/${mentionChannelId}/join`, { method: 'POST' });

      // user2 sends a message mentioning user1
      await authedFetch(token2, `/channels/${mentionChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey @mention_user1 you there?' }),
      });
    });

    it('returns messages mentioning current user', async () => {
      const res = await authedFetch(token1, '/mentions');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages).toBeDefined();
      expect(body.messages.length).toBeGreaterThan(0);
      expect(body.messages.some((m: any) => m.content === 'Hey @mention_user1 you there?')).toBe(
        true,
      );
    });

    it('returns empty for user with no mentions', async () => {
      // user3 was not mentioned in the dedicated channel
      // Create a user with no mentions at all
      await createTestUser('mention_lonely');
      const loginLonely = await loginUser('mention_lonely');

      const res = await authedFetch(loginLonely.sessionToken, '/mentions');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.messages).toEqual([]);
    });

    it('only shows mentions from channels user belongs to', async () => {
      // Create a private channel that user1 is NOT in
      const chanRes = await authedFetch(token2, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'mentions-private-chan' }),
      });
      const privateChan = await chanRes.json() as any;

      // user3 joins and mentions user1 in that channel
      await authedFetch(token3, `/channels/${privateChan.id}/join`, { method: 'POST' });
      await authedFetch(token3, `/channels/${privateChan.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: '@mention_user1 secret mention' }),
      });

      // user1 is NOT a member of mentions-private-chan
      const res = await authedFetch(token1, '/mentions');
      expect(res.status).toBe(200);
      const body = await res.json() as any;

      // Should not contain the secret mention
      expect(body.messages.some((m: any) => m.content === '@mention_user1 secret mention')).toBe(
        false,
      );
    });
  });

  describe('Mentions in thread replies', () => {
    it('mentions work in thread replies', async () => {
      // Create a parent message
      const parentRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Thread starter' }),
      });
      const parent = await parentRes.json() as any;

      // Reply with a mention
      const replyRes = await authedFetch(token2, `/messages/${parent.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey @mention_user3 look at this thread' }),
      });

      expect(replyRes.status).toBe(201);
      const reply = await replyRes.json() as any;
      expect(reply.mentions).toBeDefined();
      expect(reply.mentions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: user3.id, username: 'mention_user3' }),
        ]),
      );
    });
  });
});
