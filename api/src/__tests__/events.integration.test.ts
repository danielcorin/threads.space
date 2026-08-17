import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

const WS_BASE = 'ws://localhost:8799';

interface WsMessage {
  type: string;
  channelId?: string;
  room?: { id: string; type: string };
  [key: string]: unknown;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect to the owner-scoped /events stream and resolve once `events.ready` arrives. */
function connectEvents(sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/events`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);
    ws.on('error', reject);
    ws.on('message', function onReady(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'events.ready') {
          clearTimeout(timeout);
          ws.removeListener('message', onReady);
          resolve(ws);
        }
      } catch {
        // ignore
      }
    });
  });
}

function connectChannel(channelId: string, sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${channelId}`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.on('error', reject);
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
        const msg: WsMessage = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    }
    ws.on('message', handler);
  });
}

function expectNoMessage(
  ws: WebSocket,
  predicate: (msg: WsMessage) => boolean,
  windowMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve();
    }, windowMs);
    function handler(data: WebSocket.Data) {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          reject(new Error(`Unexpected message received: ${JSON.stringify(msg)}`));
        }
      } catch {
        // ignore
      }
    }
    ws.on('message', handler);
  });
}

async function sendMessage(token: string, channelId: string, content: string): Promise<{ id: string }> {
  const res = await authedFetch(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`sendMessage failed: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

describe('Owner-scoped /events stream', () => {
  let token1: string; // channel owner
  let token2: string; // channel member
  let token3: string; // non-member
  let user1: { id: string; username: string };
  let user2: { id: string; username: string };
  let channelId: string;

  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    await createTestUser('events_user1', 'testpass123', 'Events One');
    await createTestUser('events_user2', 'testpass123', 'Events Two');
    await createTestUser('events_user3', 'testpass123', 'Events Three');
    const login1 = await loginUser('events_user1');
    const login2 = await loginUser('events_user2');
    const login3 = await loginUser('events_user3');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    token3 = login3.sessionToken;
    user1 = { id: login1.user.id, username: login1.user.username };
    user2 = { id: login2.user.id, username: login2.user.username };

    const res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'events-test-channel' }),
    });
    channelId = ((await res.json()) as any).id;
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      try { ws.terminate(); } catch {}
    }
    openSockets.length = 0;
    await delay(300);
  });

  it('connects and greets with events.ready', async () => {
    const ws = await connectEvents(token1);
    openSockets.push(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects unauthenticated connections', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${WS_BASE}/events`);
        openSockets.push(ws);
        ws.on('open', () => reject(new Error('Should not have connected')));
        ws.on('error', () => resolve());
        ws.on('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(401);
          resolve();
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('delivers a channel message to a member over /events with an enriched envelope', async () => {
    const ws2 = await connectEvents(token2);
    openSockets.push(ws2);
    await delay(200);

    const msgPromise = waitForMessage(ws2, (m) => m.type === 'message' && m.channelId === channelId);
    await sendMessage(token1, channelId, 'hello over events');

    const msg = await msgPromise;
    expect(msg.channelId).toBe(channelId);
    expect(msg.room).toEqual({ id: channelId, type: 'channel' });
    expect(msg.content).toBe('hello over events');
    expect(msg.userId).toBe(user1.id);
  });

  it('delivers the message to the sender’s own /events stream too', async () => {
    const ws1 = await connectEvents(token1);
    openSockets.push(ws1);
    await delay(200);

    const msgPromise = waitForMessage(ws1, (m) => m.type === 'message' && m.channelId === channelId);
    await sendMessage(token1, channelId, 'echo to self');

    const msg = await msgPromise;
    expect(msg.content).toBe('echo to self');
  });

  it('dual-writes: a /ws subscriber and an /events subscriber both receive the broadcast', async () => {
    const wsChannel = await connectChannel(channelId, token1);
    openSockets.push(wsChannel);
    const wsEvents = await connectEvents(token2);
    openSockets.push(wsEvents);
    await delay(200);

    const onChannel = waitForMessage(wsChannel, (m) => m.type === 'message' && m.content === 'both paths');
    const onEvents = waitForMessage(wsEvents, (m) => m.type === 'message' && m.content === 'both paths');
    await sendMessage(token1, channelId, 'both paths');

    const [chMsg, evMsg] = await Promise.all([onChannel, onEvents]);
    // The legacy per-channel frame carries no envelope; the /events frame does.
    expect(chMsg.room).toBeUndefined();
    expect(evMsg.room).toEqual({ id: channelId, type: 'channel' });
  });

  it('delivers message mutations over /events with canonical channel metadata', async () => {
    const ws2 = await connectEvents(token2);
    openSockets.push(ws2);
    await delay(200);

    const message = await sendMessage(token1, channelId, 'mutate over events');

    const editedPromise = waitForMessage(ws2, (m) => m.type === 'message_edited' && m.id === message.id);
    const editRes = await authedFetch(token1, `/messages/${message.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'edited over events' }),
    });
    expect(editRes.status).toBe(200);
    const edited = await editedPromise;
    expect(edited.channelId).toBe(channelId);
    expect(edited.room).toEqual({ id: channelId, type: 'channel' });

    const reactionPromise = waitForMessage(ws2, (m) => m.type === 'reaction_added' && m.messageId === message.id);
    const reactionRes = await authedFetch(token1, `/messages/${message.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji: '👍' }),
    });
    expect(reactionRes.status).toBe(201);
    const reaction = await reactionPromise;
    expect(reaction.channelId).toBe(channelId);
    expect(reaction.room).toEqual({ id: channelId, type: 'channel' });

    const deletedPromise = waitForMessage(ws2, (m) => m.type === 'message_deleted' && m.id === message.id);
    const deleteRes = await authedFetch(token1, `/messages/${message.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    const deleted = await deletedPromise;
    expect(deleted.channelId).toBe(channelId);
    expect(deleted.room).toEqual({ id: channelId, type: 'channel' });
  });

  it('does not deliver channel events to a non-member’s /events stream', async () => {
    const ws3 = await connectEvents(token3);
    openSockets.push(ws3);
    await delay(200);

    const leak = expectNoMessage(ws3, (m) => m.type === 'message' && m.channelId === channelId, 2000);
    await sendMessage(token1, channelId, 'members only');
    await expect(leak).resolves.toBeUndefined();
  });

  it('marks DM rooms with room.type "dm"', async () => {
    const dmRes = await authedFetch(token1, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: user2.id }),
    });
    const dmId = ((await dmRes.json()) as any).id as string;

    const ws2 = await connectEvents(token2);
    openSockets.push(ws2);
    await delay(200);

    const msgPromise = waitForMessage(ws2, (m) => m.type === 'message' && m.channelId === dmId);
    await sendMessage(token1, dmId, 'dm hello');

    const msg = await msgPromise;
    expect(msg.room).toEqual({ id: dmId, type: 'dm' });
  });
});
