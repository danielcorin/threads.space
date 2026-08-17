import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, json } from './helpers.js';

describe('Push Notifications', () => {
  let token: string;

  beforeAll(async () => {
    await createTestUser('push_user1');
    const login = await loginUser('push_user1');
    token = login.sessionToken;
  });

  describe('GET /push/vapid-key', () => {
    it('returns the VAPID public key', async () => {
      const res = await authedFetch(token, '/push/vapid-key');
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.key).toBeDefined();
      expect(typeof body.key).toBe('string');
    });
  });

  describe('POST /push/subscribe', () => {
    it('registers a push subscription', async () => {
      const res = await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-1',
          p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
          auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
          userAgent: 'Test/1.0',
        }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.ok).toBe(true);
    });

    it('upserts on duplicate endpoint', async () => {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-upsert';
      const sub = {
        endpoint,
        p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
        auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
      };

      // First subscription
      const res1 = await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub),
      });
      expect(res1.status).toBe(201);

      // Second subscription with same endpoint (should upsert)
      const res2 = await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ ...sub, auth: 'newAuthKey1234567890123456' }),
      });
      expect(res2.status).toBe(201);
    });

    it('rejects missing fields', async () => {
      const res = await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'https://example.com' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects endpoints that are not known push services (stored SSRF)', async () => {
      const keys = {
        p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
        auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
      };
      for (const endpoint of [
        'https://attacker.example.com/collect',
        'https://10.0.0.1/internal',
        'http://fcm.googleapis.com/fcm/send/x', // https only
        'https://fcm.googleapis.com.evil.com/x', // suffix spoof
        'not-a-url',
      ]) {
        const res = await authedFetch(token, '/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint, ...keys }),
        });
        expect(res.status, endpoint).toBe(400);
      }
    });

    it('accepts all known push service hosts', async () => {
      const keys = {
        p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
        auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
      };
      for (const endpoint of [
        'https://updates.push.services.mozilla.com/wpush/v2/test-moz',
        'https://web.push.apple.com/QOtest',
        'https://db5p.notify.windows.com/w/?token=test',
      ]) {
        const res = await authedFetch(token, '/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint, ...keys }),
        });
        expect(res.status, endpoint).toBe(201);
      }
    });

    it('refuses to rebind an endpoint owned by a different user', async () => {
      await createTestUser('push_user2');
      const login2 = await loginUser('push_user2');
      const token2 = login2.sessionToken;

      const sub = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-rebind',
        p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
        auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
      };
      const res1 = await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub),
      });
      expect(res1.status).toBe(201);

      const res2 = await authedFetch(token2, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub),
      });
      expect(res2.status).toBe(409);
    });
  });

  describe('DELETE /push/subscribe', () => {
    it('removes a push subscription', async () => {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-delete';
      await authedFetch(token, '/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint,
          p256dh: 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g',
          auth: 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv',
        }),
      });

      const res = await authedFetch(token, '/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
    });
  });

  describe('GET /push/preferences', () => {
    it('returns default preferences', async () => {
      const res = await authedFetch(token, '/push/preferences');
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.enabled).toBe(1);
      expect(body.notifyMentionsOnly).toBe(0);
    });
  });

  describe('PUT /push/preferences', () => {
    it('updates push preferences', async () => {
      const res = await authedFetch(token, '/push/preferences', {
        method: 'PUT',
        body: JSON.stringify({ enabled: 1, notifyMentionsOnly: 1 }),
      });
      expect(res.status).toBe(200);

      // Verify the update
      const getRes = await authedFetch(token, '/push/preferences');
      const body = await json(getRes);
      expect(body.enabled).toBe(1);
      expect(body.notifyMentionsOnly).toBe(1);
    });

    it('can disable push notifications', async () => {
      await authedFetch(token, '/push/preferences', {
        method: 'PUT',
        body: JSON.stringify({ enabled: 0 }),
      });

      const getRes = await authedFetch(token, '/push/preferences');
      const body = await json(getRes);
      expect(body.enabled).toBe(0);
    });
  });
});
