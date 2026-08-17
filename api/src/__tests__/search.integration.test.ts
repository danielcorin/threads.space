import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, makeAdmin } from './helpers.js';

describe('Search', () => {
  let token1: string;
  let token2: string;
  let channelId1: string;
  let channelId2: string;

  beforeAll(async () => {
    await createTestUser('search_user1');
    await createTestUser('search_user2');
    const login1 = await loginUser('search_user1');
    const login2 = await loginUser('search_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create two channels
    const chan1Res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'search-channel-alpha' }),
    });
    const chan1 = await chan1Res.json() as any;
    channelId1 = chan1.id;

    const chan2Res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'search-channel-beta' }),
    });
    const chan2 = await chan2Res.json() as any;
    channelId2 = chan2.id;

    // Send messages
    await authedFetch(token1, `/channels/${channelId1}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'The flamingo dances at midnight' }),
    });
    await authedFetch(token1, `/channels/${channelId2}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'The flamingo sings a lullaby' }),
    });
    await authedFetch(token1, `/channels/${channelId1}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Regular message about nothing' }),
    });

    // User2 joins only channel1
    await authedFetch(token2, `/channels/${channelId1}/join`, { method: 'POST' });
  });

  describe('GET /search', () => {
    it('finds messages by content', async () => {
      const res = await authedFetch(token1, '/search?q=flamingo');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body.every((m: any) => m.content.includes('flamingo'))).toBe(true);
    });

    it('respects channel filter', async () => {
      const res = await authedFetch(token1, `/search?q=flamingo&channel=${channelId1}`);
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.length).toBe(1);
      expect(body[0].content).toContain('midnight');
    });

    it('only returns messages from joined channels', async () => {
      // User2 is only in channel1, so should only find flamingo from channel1
      const res = await authedFetch(token2, '/search?q=flamingo');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.length).toBe(1);
      expect(body[0].content).toContain('midnight');
    });

    it('returns empty results for missing query with no filters', async () => {
      const res = await authedFetch(token1, '/search');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('handles numeric search terms without SQL error', async () => {
      const res = await authedFetch(token1, '/search?q=1234567890');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      // No results expected, but importantly no error
    });

    it('handles special FTS characters safely', async () => {
      const res = await authedFetch(token1, '/search?q=test*OR+drop');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns a snippet field with sentinel-wrapped match terms', async () => {
      const res = await authedFetch(token1, '/search?q=flamingo');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.length).toBeGreaterThan(0);
      for (const row of body) {
        expect(typeof row.snippet).toBe('string');
        // Sentinel characters wrap the matched term(s)
        expect(row.snippet).toContain('\u0002MS\u0002');
        expect(row.snippet).toContain('\u0002ME\u0002');
        // Matched term appears between sentinels
        // eslint-disable-next-line no-control-regex
        expect(row.snippet.toLowerCase()).toMatch(/\u0002MS\u0002flamingo\u0002ME\u0002/i);
      }
    });

    it('returns a numeric bm25_score field for ranking', async () => {
      const res = await authedFetch(token1, '/search?q=flamingo');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.length).toBeGreaterThan(0);
      for (const row of body) {
        // FTS5 bm25 scores are negative (lower = better match)
        expect(typeof row.bm25_score).toBe('number');
        expect(row.bm25_score).toBeLessThanOrEqual(0);
      }
    });

    it('matches stemmed word forms via porter tokenizer', async () => {
      // Seeded "The flamingo dances at midnight" + new "...dancing in the rain".
      // Searching "dance" should find both via porter stemming.
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Someone was dancing in the rain' }),
      });

      const res = await authedFetch(token1, '/search?q=dance');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      const contents = body.map((r: any) => r.content).join(' | ');
      expect(contents).toMatch(/dances/i);
      expect(contents).toMatch(/dancing/i);
    });

    it('supports prefix matching with trailing asterisk', async () => {
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'The pterodactyl flew overhead' }),
      });

      const res = await authedFetch(token1, '/search?q=ptero*');
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.length).toBeGreaterThan(0);
      expect(body.some((r: any) => /pterodactyl/i.test(r.content))).toBe(true);
    });

    it('supports quoted exact-phrase search', async () => {
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'purple zebra walks left' }),
      });
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'zebra purple walks right' }),
      });

      const phrase = encodeURIComponent('"purple zebra"');
      const res = await authedFetch(token1, `/search?q=${phrase}`);
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      // Phrase match: "purple zebra" (in that order) should match row 1 only.
      const matches = body.filter((r: any) => /purple zebra/i.test(r.content));
      expect(matches.length).toBeGreaterThan(0);
      // The reversed-order row should NOT appear
      expect(body.some((r: any) => /zebra purple/i.test(r.content) && !/purple zebra/i.test(r.content))).toBe(false);
    });

    it('supports OR between terms', async () => {
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'giraffe roamed the savanna' }),
      });
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'rhino roamed the savanna' }),
      });

      const q = encodeURIComponent('giraffe OR rhino');
      const res = await authedFetch(token1, `/search?q=${q}`);
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      expect(body.some((r: any) => /giraffe/i.test(r.content))).toBe(true);
      expect(body.some((r: any) => /rhino/i.test(r.content))).toBe(true);
    });

    it('returns total count and hasMore flag', async () => {
      const res = await authedFetch(token1, '/search?q=flamingo');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(Array.isArray(body.results)).toBe(true);
      expect(typeof body.total).toBe('number');
      expect(typeof body.hasMore).toBe('boolean');
      expect(typeof body.offset).toBe('number');
      expect(typeof body.limit).toBe('number');
      expect(body.total).toBeGreaterThanOrEqual(body.results.length);
    });

    it('paginates with offset + limit', async () => {
      // Seed enough messages for a small limit to require pagination.
      const keyword = `pagtest${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await authedFetch(token1, `/channels/${channelId1}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: `${keyword} message ${i}` }),
        });
      }

      const page1 = await (await authedFetch(token1, `/search?q=${keyword}&limit=2&offset=0`)).json() as any;
      expect(page1.results.length).toBe(2);
      expect(page1.total).toBeGreaterThanOrEqual(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.offset).toBe(0);

      const page2 = await (await authedFetch(token1, `/search?q=${keyword}&limit=2&offset=2`)).json() as any;
      expect(page2.results.length).toBe(2);
      expect(page2.offset).toBe(2);
      // page2 rows must differ from page1 rows (different offsets → different slices)
      const page1Ids = new Set(page1.results.map((r: any) => r.id));
      expect(page2.results.every((r: any) => !page1Ids.has(r.id))).toBe(true);
    });

    it('supports -term exclusion', async () => {
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'octopus swims alone' }),
      });
      await authedFetch(token1, `/channels/${channelId1}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'octopus hides deeply' }),
      });

      const q = encodeURIComponent('octopus -swims');
      const res = await authedFetch(token1, `/search?q=${q}`);
      expect(res.status).toBe(200);

      const { results: body } = await res.json() as any;
      // Only "octopus hides" should match, not "octopus swims"
      expect(body.some((r: any) => /hides/i.test(r.content))).toBe(true);
      expect(body.every((r: any) => !/octopus swims/i.test(r.content))).toBe(true);
    });
  });
});

describe('Search across private channels', () => {
  let creatorToken: string;
  let memberToken: string;
  let outsiderToken: string;
  let privateChannelId: string;

  beforeAll(async () => {
    // Admins can create private channels — promote 'filae' to admin.
    try { await createTestUser('filae'); } catch {}
    await makeAdmin('filae');
    await createTestUser('search_priv_member');
    await createTestUser('search_priv_outsider');

    const creatorLogin = await loginUser('filae');
    creatorToken = creatorLogin.sessionToken;

    const memberLogin = await loginUser('search_priv_member');
    memberToken = memberLogin.sessionToken;

    const outsiderLogin = await loginUser('search_priv_outsider');
    outsiderToken = outsiderLogin.sessionToken;

    // Create a private channel
    const chanRes = await authedFetch(creatorToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'search-priv-room', isPrivate: true }),
    });
    const chan = await chanRes.json() as any;
    privateChannelId = chan.id;

    // Add member to private channel
    const memberUser = memberLogin.user;
    await authedFetch(creatorToken, `/channels/${privateChannelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: memberUser.id }),
    });

    // Send a message with a unique keyword in the private channel
    await authedFetch(creatorToken, `/channels/${privateChannelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'The xylophonist played beautifully' }),
    });
  });

  it('member can find messages in the private channel via search', async () => {
    const res = await authedFetch(memberToken, '/search?q=xylophonist');
    expect(res.status).toBe(200);
    const { results: body } = await res.json() as any;
    expect(body.length).toBe(1);
    expect(body[0].content).toContain('xylophonist');
  });

  it('non-member cannot find messages from the private channel via search', async () => {
    const res = await authedFetch(outsiderToken, '/search?q=xylophonist');
    expect(res.status).toBe(200);
    const { results: body } = await res.json() as any;
    expect(body.length).toBe(0);
  });

  it('channel creator can find messages in their private channel', async () => {
    const res = await authedFetch(creatorToken, '/search?q=xylophonist');
    expect(res.status).toBe(200);
    const { results: body } = await res.json() as any;
    expect(body.length).toBe(1);
  });
});

describe('Search filters: from / since / until', () => {
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let channelId: string;

  beforeAll(async () => {
    try { await createTestUser('search_filt_a'); } catch {}
    try { await createTestUser('search_filt_b'); } catch {}
    const a = await loginUser('search_filt_a');
    const b = await loginUser('search_filt_b');
    userAToken = a.sessionToken;
    userBToken = b.sessionToken;
    userAId = a.user.id;
    userBId = b.user.id;

    const chanRes = await authedFetch(userAToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'search-filters-test' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    await authedFetch(userBToken, `/channels/${channelId}/join`, { method: 'POST' });

    // Both users post messages with the keyword "filterkw"
    await authedFetch(userAToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'filterkw from user A' }),
    });
    await authedFetch(userBToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'filterkw from user B' }),
    });
  });

  it('from filter returns only messages from that user', async () => {
    const res = await authedFetch(userAToken, `/search?q=filterkw&from=${userAId}`);
    expect(res.status).toBe(200);
    const { results, total } = await res.json() as any;
    expect(results.length).toBe(1);
    expect(total).toBe(1);
    expect(results[0].user_id).toBe(userAId);
    expect(results[0].content).toContain('user A');
  });

  it('since filter excludes messages older than the bound', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const res = await authedFetch(userAToken, `/search?q=filterkw&since=${future}`);
    expect(res.status).toBe(200);
    const { results, total } = await res.json() as any;
    expect(results.length).toBe(0);
    expect(total).toBe(0);
  });

  it('until filter excludes messages newer than the bound', async () => {
    const past = 1; // 1970
    const res = await authedFetch(userAToken, `/search?q=filterkw&until=${past}`);
    expect(res.status).toBe(200);
    const { results, total } = await res.json() as any;
    expect(results.length).toBe(0);
    expect(total).toBe(0);
  });

  it('since + until form a window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 3600;
    const until = now + 3600;
    const res = await authedFetch(userAToken, `/search?q=filterkw&since=${since}&until=${until}`);
    expect(res.status).toBe(200);
    const { results, total } = await res.json() as any;
    expect(results.length).toBe(2);
    expect(total).toBe(2);
  });

  it('combines from + channel + q', async () => {
    const res = await authedFetch(userAToken, `/search?q=filterkw&channel=${channelId}&from=${userBId}`);
    expect(res.status).toBe(200);
    const { results, total } = await res.json() as any;
    expect(results.length).toBe(1);
    expect(total).toBe(1);
    expect(results[0].user_id).toBe(userBId);
  });

  it('count matches results under filters', async () => {
    const res = await authedFetch(userAToken, `/search?q=filterkw&from=${userAId}`);
    const { results, total } = await res.json() as any;
    expect(total).toBe(results.length);
  });
});
