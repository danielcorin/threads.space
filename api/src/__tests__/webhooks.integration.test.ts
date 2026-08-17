import { beforeAll, describe, expect, it } from 'vitest';
import { BASE_URL, authedFetch, createTestUser, json, loginUser, makeAdmin, querySql, sqlLit } from './helpers.js';

function bearerFetch(token: string, path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options?.headers,
    },
  });
}

describe('Webhooks', () => {
  let adminSession: string;
  let botId: string;
  let botToken: string;

  beforeAll(async () => {
    await createTestUser('wh_admin');
    await makeAdmin('wh_admin');
    adminSession = (await loginUser('wh_admin')).sessionToken;

    const botRes = await authedFetch(adminSession, '/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'wh_bot', password: 'testpass123', role: 'bot' }),
    });
    botId = (await json(botRes)).id;
  });

  it('creates token-bound webhooks at token mint time and lists without secrets', async () => {
    const res = await authedFetch(adminSession, `/users/${botId}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'bot-runtime',
        webhook_urls: ['https://hooks.example.com/threads'],
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    botToken = body.token;
    expect(body.id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0].secret).toMatch(/^[a-f0-9]{64}$/);

    const [stored] = querySql<{ token: string; secret: string; secret_key_version: number }>(
      `SELECT token, secret, secret_key_version FROM webhooks
       WHERE id = ${sqlLit(body.webhooks[0].id)}`,
    );
    expect(stored.token).toBe(`id:${body.id}`);
    expect(stored.token).not.toBe(body.token);
    expect(stored.secret).toBe('derived');
    expect(stored.secret).not.toBe(body.webhooks[0].secret);
    expect(stored.secret_key_version).toBe(1);

    const listRes = await bearerFetch(botToken, '/users/me/webhooks');
    expect(listRes.status).toBe(200);
    const listBody = await json(listRes);
    expect(listBody.webhooks).toHaveLength(1);
    expect(listBody.webhooks[0]).toMatchObject({
      url: 'https://hooks.example.com/threads',
      active: true,
      failure_count: 0,
      disabled_reason: null,
      token_name: 'bot-runtime',
    });
    expect(listBody.webhooks[0].secret).toBeUndefined();
  });

  it('registers and deletes a webhook for the authenticated token', async () => {
    const createRes = await bearerFetch(botToken, '/users/me/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://events.example.com/threads' }),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    expect(created.id).toMatch(/^wh_/);
    expect(created.secret).toMatch(/^[a-f0-9]{64}$/);

    const deleteRes = await bearerFetch(botToken, `/users/me/webhooks/${created.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);

    const listRes = await bearerFetch(botToken, '/users/me/webhooks');
    const listBody = await json(listRes);
    expect(listBody.webhooks.some((webhook: any) => webhook.id === created.id)).toBe(false);
  });

  it('rejects unsafe webhook URLs', async () => {
    const res = await bearerFetch(botToken, '/users/me/webhooks', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://localhost/webhook' }),
    });
    expect(res.status).toBe(400);
  });
});
