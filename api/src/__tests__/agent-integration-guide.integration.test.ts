import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BASE_URL, authedFetch, createTestUser, json, loginUser, makeAdmin } from './helpers.js';

const WS_BASE = BASE_URL.replace(/^http/, 'ws');

interface WsMessage {
  type: string;
  channelId?: string;
  room?: { id: string; type: string };
  id?: string;
  userId?: string;
  username?: string;
  content?: string;
  mentions?: Array<{ userId: string; username: string }>;
  messageType?: string;
  [key: string]: unknown;
}

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

function sessionCookie(setCookie: string | null): string {
  const token = setCookie?.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error('login response did not include a session cookie');
  return `session=${token}`;
}

function connectEvents(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);

    function fail(err: Error) {
      clearTimeout(timeout);
      reject(err);
    }

    ws.on('error', fail);
    ws.on('unexpected-response', (_req, res) => {
      fail(new Error(`unexpected WebSocket response: ${res.statusCode}`));
    });
    ws.on('message', function onReady(data) {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        if (msg.type === 'events.ready') {
          clearTimeout(timeout);
          ws.removeListener('message', onReady);
          ws.removeListener('error', fail);
          resolve(ws);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: WsMessage) => boolean,
  timeoutMs = 5000,
): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    }

    ws.on('message', handler);
  });
}

describe('Agent integration guide setup flow', () => {
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of openSockets) {
      try { ws.terminate(); } catch {}
    }
    openSockets.length = 0;
  });

  it('provisions a bot with an admin token, receives over /events, and replies over REST', async () => {
    await createTestUser('guide_admin');
    await makeAdmin('guide_admin');
    await createTestUser('guide_human');

    // Step 1: log in as an admin and mint that admin's API token.
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'guide-admin-login' },
      body: JSON.stringify({ username: 'guide_admin', password: 'testpass123' }),
    });
    expect(loginRes.status).toBe(200);

    const adminTokenRes = await fetch(`${BASE_URL}/users/me/api-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie(loginRes.headers.get('set-cookie')),
      },
      body: JSON.stringify({
        name: 'guide-bot-admin',
        scopes: ['threads:read', 'threads:write', 'users:provision', 'tokens:manage'],
      }),
    });
    expect(adminTokenRes.status).toBe(201);
    const adminTokenBody = await json(adminTokenRes);
    expect(adminTokenBody.name).toBe('guide-bot-admin');
    expect(adminTokenBody.token).toBeTruthy();

    // Step 2: use the admin Bearer token to create the bot user.
    const botUsername = 'guide_agent';
    const createBotRes = await bearerFetch(adminTokenBody.token, '/users', {
      method: 'POST',
      body: JSON.stringify({
        username: botUsername,
        displayName: 'Guide Agent',
        password: 'throwaway-guide-agent-password',
        role: 'bot',
      }),
    });
    expect(createBotRes.status).toBe(201);
    const bot = await json(createBotRes);
    expect(bot).toMatchObject({ username: botUsername, displayName: 'Guide Agent' });
    expect(bot.id).toBeTruthy();

    // Step 3: mint the bot runtime token and verify it authenticates as the bot.
    const botTokenRes = await bearerFetch(adminTokenBody.token, `/users/${bot.id}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: 'guide-agent-runtime' }),
    });
    expect(botTokenRes.status).toBe(201);
    const botTokenBody = await json(botTokenRes);
    expect(botTokenBody.name).toBe('guide-agent-runtime');
    expect(botTokenBody.token).toBeTruthy();

    const botMeRes = await bearerFetch(botTokenBody.token, '/users/me');
    expect(botMeRes.status).toBe(200);
    const botMe = await json(botMeRes);
    expect(botMe).toMatchObject({ id: bot.id, username: botUsername, role: 'bot' });

    // Runtime flow: connect once before channel creation; membership is evaluated
    // dynamically, so later channel membership should stream through this socket.
    const botEvents = await connectEvents(botTokenBody.token);
    openSockets.push(botEvents);

    const pongPromise = waitForMessage(botEvents, (msg) => msg.type === 'pong');
    botEvents.send(JSON.stringify({ type: 'ping' }));
    await expect(pongPromise).resolves.toMatchObject({ type: 'pong' });

    // Step 4: create a channel as the bot, then add a human by username.
    const channelRes = await bearerFetch(botTokenBody.token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'guide-bot-lab', description: 'Bot testing' }),
    });
    expect(channelRes.status).toBe(201);
    const channel = await json(channelRes);
    expect(channel).toMatchObject({ name: 'guide-bot-lab', description: 'Bot testing' });
    expect(channel.id).toBeTruthy();

    const addHumanRes = await bearerFetch(botTokenBody.token, `/channels/${channel.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ username: 'guide_human' }),
    });
    expect(addHumanRes.status).toBe(201);

    const human = await loginUser('guide_human');
    const incomingPromise = waitForMessage(
      botEvents,
      (msg) => msg.type === 'message' && msg.channelId === channel.id && msg.content === '@guide_agent hello?',
    );
    const humanMessageRes = await authedFetch(human.sessionToken, `/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: '@guide_agent hello?' }),
    });
    expect(humanMessageRes.status).toBe(201);

    const incoming = await incomingPromise;
    expect(incoming.room).toEqual({ id: channel.id, type: 'channel' });
    expect(incoming.userId).toBe(human.user.id);
    expect(incoming.messageType).toBe('human');
    expect(incoming.mentions).toEqual([
      { userId: bot.id, username: botUsername },
    ]);

    const replyRes = await bearerFetch(botTokenBody.token, `/messages/${incoming.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        content: `Echo: ${incoming.content}`,
        message_type: 'response',
        metadata: { agent: botUsername },
      }),
    });
    expect(replyRes.status).toBe(201);
    const reply = await json(replyRes);
    expect(reply).toMatchObject({
      userId: bot.id,
      channelId: channel.id,
      threadId: incoming.id,
      content: 'Echo: @guide_agent hello?',
      messageType: 'response',
      metadata: { agent: botUsername },
    });

    const repliesRes = await bearerFetch(botTokenBody.token, `/messages/${incoming.id}/replies`);
    expect(repliesRes.status).toBe(200);
    const replies = await json(repliesRes);
    expect(replies.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: reply.id, content: 'Echo: @guide_agent hello?' }),
      ]),
    );
  });
});
