import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Saved Drafts', () => {
  let token1: string;
  let token2: string;
  let channelId: string;
  let channelId2: string;

  beforeAll(async () => {
    await createTestUser('sdraft_user1');
    await createTestUser('sdraft_user2');
    const login1 = await loginUser('sdraft_user1');
    const login2 = await loginUser('sdraft_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create channels
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'sdraft-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    const chanRes2 = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'sdraft-test-channel-2' }),
    });
    const chan2 = await chanRes2.json() as any;
    channelId2 = chan2.id;

    // Join user2 to first channel
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('POST /channels/:id/saved-drafts', () => {
    it('creates a draft and returns 201', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'My first draft' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.channel_id).toBe(channelId);
      expect(body.content).toBe('My first draft');
      expect(body.created_at).toBeDefined();
    });

    it('returns 400 when content is missing', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when content is empty', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /channels/:id/saved-drafts', () => {
    it('lists drafts for current user in channel', async () => {
      // Create a second draft
      await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Second draft' }),
      });

      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      // Most recent first
      expect(body[0].content).toBe('Second draft');
      expect(body[1].content).toBe('My first draft');
    });

    it('drafts are per-user (user2 cannot see user1 drafts)', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/saved-drafts`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.length).toBe(0);
    });

    it('drafts are per-channel', async () => {
      // Create a draft in channel2
      await authedFetch(token1, `/channels/${channelId2}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Channel 2 draft' }),
      });

      const res1 = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const body1 = await res1.json() as any;
      expect(body1.every((d: any) => d.channel_id === channelId)).toBe(true);

      const res2 = await authedFetch(token1, `/channels/${channelId2}/saved-drafts`);
      const body2 = await res2.json() as any;
      expect(body2.length).toBe(1);
      expect(body2[0].content).toBe('Channel 2 draft');
    });
  });

  describe('DELETE /saved-drafts/:id', () => {
    let draftId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Draft to delete' }),
      });
      const body = await res.json() as any;
      draftId = body.id;
    });

    it('deletes a draft owned by the user', async () => {
      const res = await authedFetch(token1, `/saved-drafts/${draftId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify it's gone
      const listRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const body = await listRes.json() as any;
      expect(body.find((d: any) => d.id === draftId)).toBeUndefined();
    });

    it('returns 404 when deleting nonexistent draft', async () => {
      const res = await authedFetch(token1, `/saved-drafts/nonexistent`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when another user tries to delete (ownership)', async () => {
      // Create a draft as user1
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'User1 private draft' }),
      });
      const draft = await createRes.json() as any;

      // User2 tries to delete it
      const res = await authedFetch(token2, `/saved-drafts/${draft.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Auth required', () => {
    it('returns 401 without auth for list', async () => {
      const res = await fetch(`http://localhost:8799/channels/${channelId}/saved-drafts`);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth for create', async () => {
      const res = await fetch(`http://localhost:8799/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth for delete', async () => {
      const res = await fetch(`http://localhost:8799/saved-drafts/some-id`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });
});
