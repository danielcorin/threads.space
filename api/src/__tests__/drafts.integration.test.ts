import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Drafts', () => {
  let token1: string;
  let token2: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('draft_user1');
    await createTestUser('draft_user2');
    const login1 = await loginUser('draft_user1');
    const login2 = await loginUser('draft_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create a public channel and have user2 join
    const createRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'draft-test-channel' }),
    });
    const body = await createRes.json() as any;
    channelId = body.id;

    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('GET /channels/:id/draft', () => {
    it('returns empty content when no draft exists', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/draft`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.content).toBe('');
    });
  });

  describe('PUT /channels/:id/draft', () => {
    it('saves a draft', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'work in progress' }),
      });
      expect(res.status).toBe(200);

      // Verify it persists
      const getRes = await authedFetch(token1, `/channels/${channelId}/draft`);
      const body = await getRes.json() as any;
      expect(body.content).toBe('work in progress');
    });

    it('updates an existing draft', async () => {
      await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'first version' }),
      });

      const res = await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'second version' }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}/draft`);
      const body = await getRes.json() as any;
      expect(body.content).toBe('second version');
    });

    it('deletes draft when content is empty string', async () => {
      // First save a draft
      await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'to be deleted' }),
      });

      // Clear it
      const res = await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: '' }),
      });
      expect(res.status).toBe(200);

      // Verify it's gone
      const getRes = await authedFetch(token1, `/channels/${channelId}/draft`);
      const body = await getRes.json() as any;
      expect(body.content).toBe('');
    });
  });

  describe('draft isolation between users', () => {
    it('drafts are per-user', async () => {
      // user1 saves a draft
      await authedFetch(token1, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'user1 draft' }),
      });

      // user2 saves a different draft in same channel
      await authedFetch(token2, `/channels/${channelId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: 'user2 draft' }),
      });

      // Each user sees their own draft
      const res1 = await authedFetch(token1, `/channels/${channelId}/draft`);
      expect((await res1.json() as any).content).toBe('user1 draft');

      const res2 = await authedFetch(token2, `/channels/${channelId}/draft`);
      expect((await res2.json() as any).content).toBe('user2 draft');
    });
  });

  describe('auth required', () => {
    it('GET draft returns 401 without auth', async () => {
      const res = await fetch(`http://localhost:8799/channels/${channelId}/draft`);
      expect(res.status).toBe(401);
    });

    it('PUT draft returns 401 without auth', async () => {
      const res = await fetch(`http://localhost:8799/channels/${channelId}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'sneaky' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
