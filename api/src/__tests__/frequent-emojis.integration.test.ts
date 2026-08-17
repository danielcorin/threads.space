import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, json } from './helpers.js';

describe('GET /users/me/frequent-emojis', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('freq_emoji_user');
    const login = await loginUser('freq_emoji_user');
    token = login.sessionToken;

    const chanRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'freq-emoji-test-channel' }),
    });
    const chan = await json(chanRes);
    channelId = chan.id;
  });

  it('returns defaults when user has no reactions', async () => {
    const res = await authedFetch(token, '/users/me/frequent-emojis');
    expect(res.status).toBe(200);
    const emojis = await json(res);
    expect(emojis).toEqual(['👍', '❤️', '😂']);
  });

  it('returns user emoji plus defaults when user has 1 reaction', async () => {
    // Send a message and react with a non-default emoji
    const msgRes = await authedFetch(token, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'test message 1' }),
    });
    const msg = await json(msgRes);

    await authedFetch(token, `/messages/${msg.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '🔥' }),
    });

    const res = await authedFetch(token, '/users/me/frequent-emojis');
    const emojis = await json(res);
    expect(emojis).toEqual(['🔥', '👍', '❤️']);
  });

  it('returns user emojis plus defaults when user has 2 reactions', async () => {
    // Add another unique emoji reaction
    const msgRes = await authedFetch(token, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'test message 2' }),
    });
    const msg = await json(msgRes);

    await authedFetch(token, `/messages/${msg.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '🎉' }),
    });

    const res = await authedFetch(token, '/users/me/frequent-emojis');
    const emojis = await json(res);
    // 🔥 and 🎉 each have 1 reaction, order depends on DB, then backfill with 👍
    expect(emojis).toHaveLength(3);
    expect(emojis).toContain('🔥');
    expect(emojis).toContain('🎉');
    expect(emojis).toContain('👍');
  });

  it('returns top 3 user emojis when user has 3+ distinct reactions', async () => {
    // Add more reactions to make 🔥 the most frequent
    const msgs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const msgRes = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `fire msg ${i}` }),
      });
      const msg = await json(msgRes);
      msgs.push(msg.id);
      await authedFetch(token, `/messages/${msg.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: '🔥' }),
      });
    }

    // Add 2 more 🎉 reactions
    for (let i = 0; i < 2; i++) {
      const msgRes = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `party msg ${i}` }),
      });
      const msg = await json(msgRes);
      await authedFetch(token, `/messages/${msg.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: '🎉' }),
      });
    }

    // Add 1 👀 reaction
    const msgRes = await authedFetch(token, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'eyes msg' }),
    });
    const msg = await json(msgRes);
    await authedFetch(token, `/messages/${msg.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '👀' }),
    });

    const res = await authedFetch(token, '/users/me/frequent-emojis');
    const emojis = await json(res);
    expect(emojis).toHaveLength(3);
    // 🔥 has 4 reactions (1 original + 3 new), 🎉 has 3 (1 + 2), 👀 has 1
    // So top 3 should be 🔥, 🎉, 👀
    expect(emojis[0]).toBe('🔥');
    expect(emojis[1]).toBe('🎉');
    // Third could be 👀 (no defaults needed since we have 3+ distinct)
    expect(emojis[2]).toBe('👀');
  });

  it('skips defaults already in the user list during backfill', async () => {
    // Create a fresh user who only reacts with 👍
    await createTestUser('freq_emoji_user2');
    const login2 = await loginUser('freq_emoji_user2');

    // Join the channel first
    await authedFetch(login2.sessionToken, `/channels/${channelId}/join`, {
      method: 'POST',
    });

    const msgRes = await authedFetch(login2.sessionToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'thumbs up msg' }),
    });
    const msg = await json(msgRes);

    await authedFetch(login2.sessionToken, `/messages/${msg.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '👍' }),
    });

    const res = await authedFetch(login2.sessionToken, '/users/me/frequent-emojis');
    const emojis = await json(res);
    // 👍 is already in the list from the user's reactions, so backfill skips it
    expect(emojis).toEqual(['👍', '❤️', '😂']);
    // No duplicates
    expect(new Set(emojis).size).toBe(emojis.length);
  });

  it('requires authentication', async () => {
    const res = await fetch('http://localhost:8799/users/me/frequent-emojis');
    expect(res.status).toBe(401);
  });
});
