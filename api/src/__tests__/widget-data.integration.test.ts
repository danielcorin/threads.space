import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, BASE_URL } from './helpers.js';

describe('Widget Data', () => {
  let token: string;
  let token2: string;
  let widgetId: string;

  beforeAll(async () => {
    await createTestUser('wdata_user1');
    const login = await loginUser('wdata_user1');
    token = login.sessionToken;

    await createTestUser('wdata_user2');
    const login2 = await loginUser('wdata_user2');
    token2 = login2.sessionToken;

    // Create a widget
    const res = await authedFetch(token, '/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Data Test Widget', code: '<p>data</p>' }),
    });
    const body = await res.json() as any;
    widgetId = body.id;
  });

  describe('Auth checks', () => {
    it('returns 401 for unauthenticated KV get', async () => {
      const res = await fetch(`${BASE_URL}/widgets/${widgetId}/data/kv/mykey`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for unauthenticated KV put', async () => {
      const res = await fetch(`${BASE_URL}/widgets/${widgetId}/data/kv/mykey`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 for unauthenticated KV delete', async () => {
      const res = await fetch(`${BASE_URL}/widgets/${widgetId}/data/kv/mykey`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('KV CRUD', () => {
    it('returns 404 for nonexistent widget', async () => {
      const res = await authedFetch(token, '/widgets/nonexistent/data/kv/mykey');
      expect(res.status).toBe(404);
    });

    it('returns 404 for key that does not exist', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/nokey`);
      expect(res.status).toBe(404);
    });

    it('puts a value', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`, {
        method: 'PUT',
        body: JSON.stringify({ value: 42 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('gets the value back', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.key).toBe('counter');
      expect(body.value).toBe(42);
    });

    it('updates the value', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`, {
        method: 'PUT',
        body: JSON.stringify({ value: { count: 99, label: 'updated' } }),
      });
      expect(res.status).toBe(200);
    });

    it('gets the updated value', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.key).toBe('counter');
      expect(body.value).toEqual({ count: 99, label: 'updated' });
    });

    it('stores string values', async () => {
      await authedFetch(token, `/widgets/${widgetId}/data/kv/greeting`, {
        method: 'PUT',
        body: JSON.stringify({ value: 'hello world' }),
      });
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/greeting`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.value).toBe('hello world');
    });

    it('deletes a key', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('returns 404 after deletion', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/counter`);
      expect(res.status).toBe(404);
    });

    it('delete is idempotent for nonexistent key', async () => {
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/nonexistent`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('KV user scoping', () => {
    it('user2 cannot read user1 KV data', async () => {
      // user1 writes a value
      await authedFetch(token, `/widgets/${widgetId}/data/kv/secret`, {
        method: 'PUT',
        body: JSON.stringify({ value: 'user1-only' }),
      });

      // user1 can read it
      const res1 = await authedFetch(token, `/widgets/${widgetId}/data/kv/secret`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json() as any;
      expect(body1.value).toBe('user1-only');

      // user2 cannot read it
      const res2 = await authedFetch(token2, `/widgets/${widgetId}/data/kv/secret`);
      expect(res2.status).toBe(404);
    });

    it('users can store different values for the same key', async () => {
      await authedFetch(token, `/widgets/${widgetId}/data/kv/shared-key`, {
        method: 'PUT',
        body: JSON.stringify({ value: 'from-user1' }),
      });
      await authedFetch(token2, `/widgets/${widgetId}/data/kv/shared-key`, {
        method: 'PUT',
        body: JSON.stringify({ value: 'from-user2' }),
      });

      const res1 = await authedFetch(token, `/widgets/${widgetId}/data/kv/shared-key`);
      const body1 = await res1.json() as any;
      expect(body1.value).toBe('from-user1');

      const res2 = await authedFetch(token2, `/widgets/${widgetId}/data/kv/shared-key`);
      const body2 = await res2.json() as any;
      expect(body2.value).toBe('from-user2');
    });

    it('user2 delete does not affect user1 data', async () => {
      await authedFetch(token, `/widgets/${widgetId}/data/kv/persist`, {
        method: 'PUT',
        body: JSON.stringify({ value: 'keep-me' }),
      });

      // user2 tries to delete user1's key
      await authedFetch(token2, `/widgets/${widgetId}/data/kv/persist`, {
        method: 'DELETE',
      });

      // user1's data should still be there
      const res = await authedFetch(token, `/widgets/${widgetId}/data/kv/persist`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.value).toBe('keep-me');
    });
  });
});
