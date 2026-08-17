import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, makeAdmin, BASE_URL } from './helpers.js';

describe('Widgets', () => {
  let token1: string;
  let token2: string;
  let user1Id: string;

  beforeAll(async () => {
    await createTestUser('wid_user1');
    await createTestUser('wid_user2');
    const login1 = await loginUser('wid_user1');
    const login2 = await loginUser('wid_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    user1Id = login1.user.id;
  });

  describe('Auth checks', () => {
    it('returns 401 for unauthenticated GET /widgets', async () => {
      const res = await fetch(`${BASE_URL}/widgets`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for unauthenticated POST /widgets', async () => {
      const res = await fetch(`${BASE_URL}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', code: '<p>hi</p>' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for unauthenticated GET /w/:id (public endpoint)', async () => {
      const res = await fetch(`${BASE_URL}/w/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('CRUD', () => {
    let widgetId: string;

    it('creates a widget', async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Counter',
          description: 'A simple counter widget',
          icon: '🔢',
          code: '<script>document.body.textContent = "hello";</script>',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Test Counter');
      expect(body.description).toBe('A simple counter widget');
      expect(body.icon).toBe('🔢');
      expect(body.code).toContain('hello');
      expect(body.created_by).toBe(user1Id);
      widgetId = body.id;
    });

    it('rejects create without name', async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ code: '<p>hi</p>' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects create without code', async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'No Code' }),
      });
      expect(res.status).toBe(400);
    });

    it('uses default icon when not provided', async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Default Icon', code: '<p>x</p>' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.icon).toBe('PuzzlePiece');
    });

    it('lists all widgets', async () => {
      const res = await authedFetch(token1, '/widgets');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
      const names = body.map((w: any) => w.name);
      expect(names).toContain('Test Counter');
    });

    it('gets a widget by id', async () => {
      const res = await authedFetch(token1, `/widgets/${widgetId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(widgetId);
      expect(body.name).toBe('Test Counter');
      expect(body.code).toBeDefined();
    });

    it('returns 404 for nonexistent widget', async () => {
      const res = await authedFetch(token1, '/widgets/nonexistent');
      expect(res.status).toBe(404);
    });

    it('updates a widget', async () => {
      const res = await authedFetch(token1, `/widgets/${widgetId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Updated Counter', description: 'Updated desc' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe('Updated Counter');
      expect(body.description).toBe('Updated desc');
    });

    it('rejects update with no fields', async () => {
      const res = await authedFetch(token1, `/widgets/${widgetId}`, {
        method: 'PUT',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('deletes a widget', async () => {
      // Create a widget to delete
      const createRes = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'To Delete', code: '<p>bye</p>' }),
      });
      const { id } = await createRes.json() as any;

      const res = await authedFetch(token1, `/widgets/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      // Verify it's gone
      const getRes = await authedFetch(token1, `/widgets/${id}`);
      expect(getRes.status).toBe(404);
    });

    it('returns 404 when deleting nonexistent widget', async () => {
      const res = await authedFetch(token1, '/widgets/nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('Creator-only enforcement', () => {
    let widgetId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Creator Only', code: '<p>mine</p>' }),
      });
      const body = await res.json() as any;
      widgetId = body.id;
    });

    it('non-creator cannot update widget', async () => {
      const res = await authedFetch(token2, `/widgets/${widgetId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Hijacked' }),
      });
      expect(res.status).toBe(403);
    });

    it('non-creator cannot delete widget', async () => {
      const res = await authedFetch(token2, `/widgets/${widgetId}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    it('creator can still update', async () => {
      const res = await authedFetch(token1, `/widgets/${widgetId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Still Mine' }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Channel scoping', () => {
    let channelId: string;
    let widgetId: string;

    beforeAll(async () => {
      // Create a public channel
      const chanRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'wid-channel-scope' }),
      });
      channelId = (await chanRes.json() as any).id;

      // Create a widget
      const widRes = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Channel Widget', code: '<p>scoped</p>' }),
      });
      widgetId = (await widRes.json() as any).id;
    });

    it('adds a widget to a channel', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId }),
      });
      expect(res.status).toBe(201);
    });

    it('adding the same widget again is idempotent (INSERT OR IGNORE)', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId }),
      });
      expect(res.status).toBe(201);
    });

    it('rejects adding without widgetId', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('rejects adding a nonexistent widget', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId: 'nonexistent' }),
      });
      expect(res.status).toBe(404);
    });

    it('lists widgets for a channel', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(widgetId);
      expect(body[0].name).toBe('Channel Widget');
      expect(body[0].added_by).toBeDefined();
      expect(body[0].added_at).toBeDefined();
    });

    it('removes a widget from a channel', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/widgets/${widgetId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify it's gone from the channel
      const listRes = await authedFetch(token1, `/channels/${channelId}/widgets`);
      const body = await listRes.json() as any;
      expect(body.length).toBe(0);
    });

    it('deleting a widget also removes it from channels', async () => {
      // Create a fresh widget and add it to the channel
      const widRes = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Cascade Delete', code: '<p>gone</p>' }),
      });
      const wid = (await widRes.json() as any).id;

      await authedFetch(token1, `/channels/${channelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId: wid }),
      });

      // Delete the widget itself
      await authedFetch(token1, `/widgets/${wid}`, { method: 'DELETE' });

      // Channel should no longer list it
      const listRes = await authedFetch(token1, `/channels/${channelId}/widgets`);
      const body = await listRes.json() as any;
      const ids = body.map((w: any) => w.id);
      expect(ids).not.toContain(wid);
    });
  });

  describe('Private channel membership checks on widget endpoints', () => {
    let privateChannelId: string;
    let widgetId: string;
    let creatorToken: string;
    let outsiderToken: string;

    beforeAll(async () => {
      await createTestUser('wid_outsider');
      const outsiderLogin = await loginUser('wid_outsider');
      outsiderToken = outsiderLogin.sessionToken;

      // Admins can create private channels — promote 'filae' to admin.
      try { await createTestUser('filae'); } catch { /* already exists */ }
      await makeAdmin('filae');
      const creatorLogin = await loginUser('filae');
      creatorToken = creatorLogin.sessionToken;

      const chanRes = await authedFetch(creatorToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'wid-private-test', isPrivate: true }),
      });
      const chanBody = await chanRes.json() as any;
      privateChannelId = chanBody.id;

      // Create a widget to use
      const widRes = await authedFetch(creatorToken, '/widgets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Private Widget', code: '<p>secret</p>' }),
      });
      widgetId = (await widRes.json() as any).id;

      // Add widget to private channel
      await authedFetch(creatorToken, `/channels/${privateChannelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId }),
      });
    });

    it('non-member cannot list widgets on private channel', async () => {
      const res = await authedFetch(outsiderToken, `/channels/${privateChannelId}/widgets`);
      expect(res.status).toBe(403);
    });

    it('non-member cannot add widget to private channel', async () => {
      const res = await authedFetch(outsiderToken, `/channels/${privateChannelId}/widgets`, {
        method: 'POST',
        body: JSON.stringify({ widgetId }),
      });
      expect(res.status).toBe(403);
    });

    it('non-member cannot remove widget from private channel', async () => {
      const res = await authedFetch(outsiderToken, `/channels/${privateChannelId}/widgets/${widgetId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);
    });

    it('member can list widgets on private channel', async () => {
      const res = await authedFetch(creatorToken, `/channels/${privateChannelId}/widgets`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.length).toBe(1);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await authedFetch(creatorToken, '/channels/nonexistent-chan/widgets');
      expect(res.status).toBe(404);
    });
  });

  describe('Widget runtime (GET /w/:id)', () => {
    let widgetId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/widgets', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Runtime Widget',
          code: '<script>console.log("runtime");</script>',
        }),
      });
      widgetId = (await res.json() as any).id;
    });

    it('returns HTML with widget code', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('http://localhost:5173')}`, {
        headers: { Cookie: `session=${token1}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Runtime Widget');
      expect(html).toContain('console.log("runtime")');
      expect(html).toContain('window.ThreadsWidget');
    });

    it('includes widgetId in context', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('http://localhost:5173')}`);
      const html = await res.text();
      expect(html).toContain('WIDGET_ID');
      expect(html).toContain(widgetId);
    });

    it('passes channelId query param to context', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?channelId=test-chan-123&parentOrigin=${encodeURIComponent('http://localhost:5173')}`, {
        headers: { Cookie: `session=${token1}` },
      });
      const html = await res.text();
      expect(html).toContain('test-chan-123');
    });

    it('returns 404 for nonexistent widget', async () => {
      const res = await fetch(`${BASE_URL}/w/nonexistent?parentOrigin=${encodeURIComponent('http://localhost:5173')}`, {
        headers: { Cookie: `session=${token1}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns widget HTML without auth (public endpoint)', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('http://localhost:5173')}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('rejects requests without parentOrigin', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}`);
      expect(res.status).toBe(400);
    });

    it('rejects requests with invalid parentOrigin', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('https://evil.com')}`);
      expect(res.status).toBe(400);
    });

    it('sets Content-Security-Policy header', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('http://localhost:5173')}`, {
        headers: { Cookie: `session=${token1}` },
      });
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeDefined();
      expect(csp).toContain('unsafe-inline');
    });

    it('img-src does not allow arbitrary https: hosts (image-beacon exfiltration)', async () => {
      const res = await fetch(`${BASE_URL}/w/${widgetId}?parentOrigin=${encodeURIComponent('http://localhost:5173')}`, {
        headers: { Cookie: `session=${token1}` },
      });
      const csp = res.headers.get('content-security-policy') ?? '';
      const imgSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src'));
      expect(imgSrc).toBe("img-src 'self' blob: data:");
    });
  });
});
