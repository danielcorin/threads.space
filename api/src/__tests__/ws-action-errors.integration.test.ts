import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch, makeAdmin, BASE_URL } from './helpers.js';

describe('WS action errors', () => {
  let token: string;
  let memberChannelId: string;
  let forbiddenChannelId: string;

  beforeAll(async () => {
    await createTestUser('wserr_user1');
    await createTestUser('wserr_user2');
    const login1 = await loginUser('wserr_user1');
    const login2 = await loginUser('wserr_user2');
    token = login1.sessionToken;

    const chan1 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'wserr-member-channel' }),
    });
    memberChannelId = ((await chan1.json()) as any).id;

    // A channel user1 is NOT a member of
    const chan2 = await authedFetch(login2.sessionToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'wserr-forbidden-channel', is_private: true }),
    });
    forbiddenChannelId = ((await chan2.json()) as any).id;
  });

  it('forwards authz failures as their real status, not 500 "[object Response]"', async () => {
    const wsBase = BASE_URL.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/ws/${memberChannelId}`, {
      headers: { Cookie: `session=${token}` },
    });
    const events: any[] = [];
    ws.on('message', (data: WebSocket.Data) => {
      try { events.push(JSON.parse(data.toString())); } catch {}
    });
    await new Promise<void>((r) => ws.on('open', r));

    ws.send(JSON.stringify({
      type: 'message.create',
      actionId: 'authz-test',
      channelId: forbiddenChannelId,
      content: 'should not land',
    }));

    await new Promise((r) => setTimeout(r, 700));
    const err = events.find((e) => e.type === 'action_error' && e.actionId === 'authz-test');
    expect(err).toBeDefined();
    expect(err.status).toBe(403);
    expect(JSON.stringify(err.error)).not.toContain('[object Response]');

    ws.close();
  });
});

describe('WS credential enforcement', () => {
  let adminSession: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('wscred_admin');
    await makeAdmin('wscred_admin');
    adminSession = (await loginUser('wscred_admin')).sessionToken;
    const channel = await authedFetch(adminSession, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'ws-credential-enforcement' }),
    });
    channelId = ((await channel.json()) as any).id;
  });

  it('allows a read-only token to connect but blocks state-changing actions', async () => {
    const tokenRes = await authedFetch(adminSession, '/users/me/api-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'ws-read-only', scopes: ['threads:read'] }),
    });
    const token = ((await tokenRes.json()) as any).token;
    const wsBase = BASE_URL.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/ws/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const events: any[] = [];
    ws.on('message', (data: WebSocket.Data) => {
      try { events.push(JSON.parse(data.toString())); } catch {}
    });
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ type: 'typing_start', actionId: 'read-only-write' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const error = events.find((event) => event.type === 'action_error');
    expect(error).toMatchObject({ actionId: 'read-only-write', status: 403 });
    ws.close();
  });

  it('finds an established socket for immediate close when its token is revoked', async () => {
    const tokenRes = await authedFetch(adminSession, '/users/me/api-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'ws-revocation' }),
    });
    const issued = (await tokenRes.json()) as any;
    const wsBase = BASE_URL.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/events`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const revoke = await authedFetch(adminSession, `/users/me/api-tokens/${issued.id}`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as any).connections_closed).toBeGreaterThan(0);

    const rejected = await fetch(`${BASE_URL}/users/me`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(rejected.status).toBe(401);
    ws.close();
  });

  // Regression: malformed frames were reported as status 500. Bots retry on
  // 5xx, so a single buggy client became a retry loop against the Durable
  // Object. Client-input failures are permanent 400s.
  describe('malformed frames are client errors, not server faults', () => {
    const cases: Array<{ label: string; frame: string; actionId: string | null }> = [
      { label: 'not JSON', frame: 'definitely not json', actionId: null },
      { label: 'JSON array', frame: '[1,2,3]', actionId: null },
      { label: 'JSON null', frame: 'null', actionId: null },
      { label: 'message.create without channelId', frame: JSON.stringify({ type: 'message.create', content: 'x', actionId: 'mf1' }), actionId: 'mf1' },
      { label: 'message.create with array channelId', frame: JSON.stringify({ type: 'message.create', channelId: ['a'], content: 'x', actionId: 'mf2' }), actionId: 'mf2' },
      { label: 'reaction.add without messageId', frame: JSON.stringify({ type: 'reaction.add', emoji: 'x', actionId: 'mf3' }), actionId: 'mf3' },
      { label: 'process.update without processId', frame: JSON.stringify({ type: 'process.update', actionId: 'mf4' }), actionId: 'mf4' },
      // Type confusion on fields the handlers used to cast with `as string`.
      // An object here reached createMessage and died on content?.trim().
      { label: 'message.create with object content', frame: JSON.stringify({ type: 'message.create', channelId: 'placeholder', content: { a: 1 }, actionId: 'mf5' }), actionId: 'mf5' },
      { label: 'message.create with numeric content', frame: JSON.stringify({ type: 'message.create', channelId: 'placeholder', content: 42, actionId: 'mf6' }), actionId: 'mf6' },
      { label: 'message.create with string attachmentIds', frame: JSON.stringify({ type: 'message.create', channelId: 'placeholder', content: 'x', attachmentIds: 'not-an-array', actionId: 'mf7' }), actionId: 'mf7' },
      { label: 'message.create with array metadata', frame: JSON.stringify({ type: 'message.create', channelId: 'placeholder', content: 'x', metadata: [1, 2], actionId: 'mf8' }), actionId: 'mf8' },
      { label: 'reaction.add with object emoji', frame: JSON.stringify({ type: 'reaction.add', messageId: 'placeholder', emoji: { a: 1 }, actionId: 'mf9' }), actionId: 'mf9' },
    ];

    let channelId: string;
    let sessionToken: string;

    beforeAll(async () => {
      await createTestUser('wsmalformed_user');
      sessionToken = (await loginUser('wsmalformed_user')).sessionToken;
      const chan = await authedFetch(sessionToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'wsmalformed-channel' }),
      });
      channelId = ((await chan.json()) as any).id;
    });

    it('answers 400 and keeps the socket open', async () => {
      const wsBase = BASE_URL.replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/ws/${channelId}`, {
        headers: { Cookie: `session=${sessionToken}` },
      });
      const events: any[] = [];
      ws.on('message', (data: WebSocket.Data) => {
        try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
      });
      await new Promise<void>((r) => ws.on('open', r));

      // 'placeholder' stands in for a channel/message id in the type-confusion
      // cases; the field-type check must reject before any lookup happens.
      for (const { frame } of cases) ws.send(frame.replace(/"placeholder"/g, JSON.stringify(channelId)));
      await new Promise((r) => setTimeout(r, 1500));

      const errors = events.filter((e) => e.type === 'action_error');
      expect(errors.length).toBeGreaterThanOrEqual(cases.length);
      // The point of the fix: none of these are 5xx.
      expect(errors.filter((e) => e.status >= 500)).toEqual([]);
      for (const e of errors) expect(e.status).toBe(400);

      // A malformed frame must not take the connection down with it.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });
});
