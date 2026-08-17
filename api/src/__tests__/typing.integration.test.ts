import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

const WS_BASE = 'ws://localhost:8799';

interface WsMessage {
  type: string;
  userId?: string;
  username?: string;
  [key: string]: unknown;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connectWebSocket(channelId: string, sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${channelId}`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);
    ws.on('open', () => clearTimeout(timeout));
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
        // Ignore non-JSON messages
      }
    }

    ws.on('message', handler);
  });
}

/**
 * Asserts that no message matching the predicate arrives within the given window.
 */
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
        // Ignore
      }
    }

    ws.on('message', handler);
  });
}

/**
 * Connect two users to a channel, waiting for the user_joined broadcast
 * so we know both connections are fully established in the DO.
 */
async function connectPair(
  channelId: string,
  token1: string,
  token2: string,
  sockets: WebSocket[],
): Promise<[WebSocket, WebSocket]> {
  const ws1 = await connectWebSocket(channelId, token1);
  sockets.push(ws1);

  // Small delay to let the DO fully register ws1
  await delay(200);

  const joinPromise = waitForMessage(ws1, (msg) => msg.type === 'user_joined');
  const ws2 = await connectWebSocket(channelId, token2);
  sockets.push(ws2);

  // Wait for user_joined to confirm both are registered
  await joinPromise;

  // Small delay to let the DO fully register ws2
  await delay(200);

  return [ws1, ws2];
}

describe('WebSocket typing indicators', () => {
  let token1: string;
  let token2: string;
  let _user1: { id: string; username: string };
  let user2: { id: string; username: string };
  let channelId: string;

  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    await createTestUser('typing_user1', 'testpass123', 'User One');
    await createTestUser('typing_user2', 'testpass123', 'User Two');
    const login1 = await loginUser('typing_user1');
    const login2 = await loginUser('typing_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    _user1 = { id: login1.user.id, username: login1.user.username };
    user2 = { id: login2.user.id, username: login2.user.username };

    // Create a channel for testing
    const res = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'typing-test-channel' }),
    });
    const channel = await res.json() as any;
    channelId = channel.id;

    // Add user2 to the channel
    await authedFetch(token2, `/channels/${channelId}/join`, {
      method: 'POST',
    });
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      try { ws.terminate(); } catch {}
    }
    openSockets.length = 0;
    // Let the DO process disconnects before the next test
    await delay(300);
  });

  it('connects successfully with valid auth', async () => {
    const ws = await connectWebSocket(channelId, token1);
    openSockets.push(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects unauthenticated WebSocket connections', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${WS_BASE}/ws/${channelId}`);
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

  it('broadcasts user_joined when a user connects', async () => {
    const ws1 = await connectWebSocket(channelId, token1);
    openSockets.push(ws1);

    await delay(200);

    const joinPromise = waitForMessage(ws1, (msg) => msg.type === 'user_joined');
    const ws2 = await connectWebSocket(channelId, token2);
    openSockets.push(ws2);

    const msg = await joinPromise;
    expect(msg.type).toBe('user_joined');
    expect(msg.userId).toBe(user2.id);
    expect(msg.username).toBe(user2.username);
  });

  it('broadcasts user_left when a user disconnects', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    const leftPromise = waitForMessage(ws1, (msg) => msg.type === 'user_left');
    ws2.close();

    const msg = await leftPromise;
    expect(msg.type).toBe('user_left');
    expect(msg.userId).toBe(user2.id);
  });

  it('broadcasts user_typing to other users on typing_start', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    const typingPromise = waitForMessage(ws1, (msg) => msg.type === 'user_typing');
    ws2.send(JSON.stringify({ type: 'typing_start' }));

    const msg = await typingPromise;
    expect(msg.type).toBe('user_typing');
    expect(msg.userId).toBe(user2.id);
    expect(msg.username).toBe(user2.username);
  });

  it('does not echo typing_start back to sender', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    // user1 sends typing_start
    ws1.send(JSON.stringify({ type: 'typing_start' }));

    // user2 should receive user_typing (confirms the event fired)
    await waitForMessage(ws2, (msg) => msg.type === 'user_typing');

    // user1 should NOT receive user_typing for their own action
    await expectNoMessage(ws1, (msg) => msg.type === 'user_typing');
  });

  it('broadcasts user_stopped_typing on typing_stop', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    // Start typing first
    ws2.send(JSON.stringify({ type: 'typing_start' }));
    await waitForMessage(ws1, (msg) => msg.type === 'user_typing');

    // Now stop typing
    const stopPromise = waitForMessage(ws1, (msg) => msg.type === 'user_stopped_typing');
    ws2.send(JSON.stringify({ type: 'typing_stop' }));

    const msg = await stopPromise;
    expect(msg.type).toBe('user_stopped_typing');
    expect(msg.userId).toBe(user2.id);
  });

  it('includes threadId when typing in a thread', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    const typingPromise = waitForMessage(ws1, (msg) => msg.type === 'user_typing');
    ws2.send(JSON.stringify({ type: 'typing_start', threadId: 'parent-msg-1' }));

    const msg = await typingPromise;
    expect(msg.userId).toBe(user2.id);
    expect(msg.threadId).toBe('parent-msg-1');
  });

  it('reports threadId null for main-channel typing', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    const typingPromise = waitForMessage(ws1, (msg) => msg.type === 'user_typing');
    ws2.send(JSON.stringify({ type: 'typing_start' }));

    const msg = await typingPromise;
    expect(msg.userId).toBe(user2.id);
    expect(msg.threadId).toBe(null);
  });

  it('emits a stop for the old context when switching from channel into a thread', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    // Start typing in the main channel.
    ws2.send(JSON.stringify({ type: 'typing_start' }));
    await waitForMessage(ws1, (msg) => msg.type === 'user_typing' && msg.threadId === null);

    // Switch to typing in a thread — others should be told channel typing stopped,
    // then that thread typing started.
    const stopPromise = waitForMessage(
      ws1,
      (msg) => msg.type === 'user_stopped_typing' && msg.threadId === null,
    );
    ws2.send(JSON.stringify({ type: 'typing_start', threadId: 'parent-msg-2' }));

    const stop = await stopPromise;
    expect(stop.userId).toBe(user2.id);

    const start = await waitForMessage(
      ws1,
      (msg) => msg.type === 'user_typing' && msg.threadId === 'parent-msg-2',
    );
    expect(start.userId).toBe(user2.id);
  });

  it('echoes back the recorded threadId on typing_stop', async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    ws2.send(JSON.stringify({ type: 'typing_start', threadId: 'parent-msg-3' }));
    await waitForMessage(ws1, (msg) => msg.type === 'user_typing');

    const stopPromise = waitForMessage(ws1, (msg) => msg.type === 'user_stopped_typing');
    ws2.send(JSON.stringify({ type: 'typing_stop', threadId: 'parent-msg-3' }));

    const msg = await stopPromise;
    expect(msg.userId).toBe(user2.id);
    expect(msg.threadId).toBe('parent-msg-3');
  });

  it('auto-expires typing state after ~8 seconds', { timeout: 15000 }, async () => {
    const [ws1, ws2] = await connectPair(channelId, token1, token2, openSockets);

    // user2 starts typing
    ws2.send(JSON.stringify({ type: 'typing_start' }));
    await waitForMessage(ws1, (msg) => msg.type === 'user_typing');

    // Wait for auto-expiry (~8 seconds). The timeout callback in the DO
    // broadcasts to ALL sockets (no exclude), so ws1 should receive it.
    const msg = await waitForMessage(
      ws1,
      (msg) => msg.type === 'user_stopped_typing',
      10000,
    );
    expect(msg.type).toBe('user_stopped_typing');
    expect(msg.userId).toBe(user2.id);
  });
});
