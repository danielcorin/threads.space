import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

const WS_BASE = 'ws://localhost:8799';

interface WsMessage {
  type: string;
  userId?: string;
  online?: boolean;
  [key: string]: unknown;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connectPresenceWs(sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/presence`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Presence WebSocket connection timed out'));
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
 * Collect all messages matching a predicate within a time window.
 */
function _collectMessages(
  ws: WebSocket,
  predicate: (msg: WsMessage) => boolean,
  windowMs = 2000,
): Promise<WsMessage[]> {
  return new Promise((resolve) => {
    const collected: WsMessage[] = [];
    const _timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, windowMs);

    function handler(data: WebSocket.Data) {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        if (predicate(msg)) {
          collected.push(msg);
        }
      } catch {
        // Ignore
      }
    }

    ws.on('message', handler);
  });
}

describe('Presence', () => {
  let token1: string;
  let token2: string;
  let _token3: string;
  let user1: { id: string; username: string };
  let user2: { id: string; username: string };
  let _user3: { id: string; username: string };

  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    await createTestUser('presence_user1', 'testpass123', 'User One');
    await createTestUser('presence_user2', 'testpass123', 'User Two');
    await createTestUser('presence_user3', 'testpass123', 'User Three');
    const login1 = await loginUser('presence_user1');
    const login2 = await loginUser('presence_user2');
    const login3 = await loginUser('presence_user3');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    _token3 = login3.sessionToken;
    user1 = { id: login1.user.id, username: login1.user.username };
    user2 = { id: login2.user.id, username: login2.user.username };
    _user3 = { id: login3.user.id, username: login3.user.username };
  });

  afterEach(async () => {
    for (const ws of openSockets) {
      try { ws.terminate(); } catch {}
    }
    openSockets.length = 0;
    // Let the DO process disconnects before the next test
    await delay(300);
  });

  // ── WebSocket connection tests ──────────────────────────────────────────

  it('connects to /ws/presence with valid auth', async () => {
    const ws = await connectPresenceWs(token1);
    openSockets.push(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects unauthenticated presence WebSocket connections', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${WS_BASE}/ws/presence`);
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

  // ── First-connect broadcasts online ─────────────────────────────────────

  it('broadcasts presence_update online when first user connects', async () => {
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 connects — ws1 should see user2 come online
    const onlinePromise = waitForMessage(ws1, (msg) =>
      msg.type === 'presence_update' && msg.userId === user2.id && msg.online === true,
    );
    const ws2 = await connectPresenceWs(token2);
    openSockets.push(ws2);

    const msg = await onlinePromise;
    expect(msg.type).toBe('presence_update');
    expect(msg.userId).toBe(user2.id);
    expect(msg.online).toBe(true);
  });

  // ── Second connect same user doesn't re-broadcast ───────────────────────

  it('does not re-broadcast online when same user opens second connection', async () => {
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 first connection
    const onlinePromise = waitForMessage(ws1, (msg) =>
      msg.type === 'presence_update' && msg.userId === user2.id && msg.online === true,
    );
    const ws2a = await connectPresenceWs(token2);
    openSockets.push(ws2a);
    await onlinePromise;
    await delay(200);

    // user2 second connection — should NOT re-broadcast online
    const ws2b = await connectPresenceWs(token2);
    openSockets.push(ws2b);

    await expectNoMessage(
      ws1,
      (msg) => msg.type === 'presence_update' && msg.userId === user2.id,
    );
  });

  // ── Last-disconnect starts grace timer → broadcasts offline ─────────────

  it('broadcasts offline after last connection closes and grace period expires', { timeout: 20000 }, async () => {
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 connects
    const onlinePromise = waitForMessage(ws1, (msg) =>
      msg.type === 'presence_update' && msg.userId === user2.id && msg.online === true,
    );
    const ws2 = await connectPresenceWs(token2);
    openSockets.push(ws2);
    await onlinePromise;
    await delay(200);

    // user2 disconnects — should broadcast offline after 10s grace
    ws2.close();

    const offlineMsg = await waitForMessage(
      ws1,
      (msg) => msg.type === 'presence_update' && msg.userId === user2.id && msg.online === false,
      15000,
    );
    expect(offlineMsg.online).toBe(false);
  });

  // ── Reconnect within grace cancels timer ────────────────────────────────

  it('cancels offline broadcast when user reconnects within grace period', { timeout: 20000 }, async () => {
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 connects
    const onlinePromise = waitForMessage(ws1, (msg) =>
      msg.type === 'presence_update' && msg.userId === user2.id && msg.online === true,
    );
    const ws2a = await connectPresenceWs(token2);
    openSockets.push(ws2a);
    await onlinePromise;
    await delay(200);

    // user2 disconnects
    ws2a.close();
    // Wait a bit but well within the 10s grace window
    await delay(2000);

    // user2 reconnects within grace
    const ws2b = await connectPresenceWs(token2);
    openSockets.push(ws2b);

    // Should NOT receive an offline broadcast for user2
    await expectNoMessage(
      ws1,
      (msg) => msg.type === 'presence_update' && msg.userId === user2.id && msg.online === false,
      12000,
    );
  });

  // ── Initial presence snapshot on connect ─────────────────────────────────

  it('sends presence_snapshot with currently online users on connect', async () => {
    // user1 connects first
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 connects — should get a snapshot showing user1 online
    const ws2 = await connectPresenceWs(token2);
    openSockets.push(ws2);

    const snapshot = await waitForMessage(ws2, (msg) => msg.type === 'presence_snapshot');
    expect(snapshot.type).toBe('presence_snapshot');
    const users = snapshot.users as Record<string, boolean>;
    expect(users[user1.id]).toBe(true);
  });

  // ── App-level keepalive: auto-respond to client ping with pong ──────────

  it('auto-responds with pong to a client app-level ping', async () => {
    const ws = await connectPresenceWs(token1);
    openSockets.push(ws);
    await delay(200);

    const pongPromise = waitForMessage(ws, (msg) => msg.type === 'pong');
    ws.send(JSON.stringify({ type: 'ping' }));

    const pong = await pongPromise;
    expect(pong.type).toBe('pong');
  });

  // ── Activity heartbeat: handled without disrupting the socket ────────────

  it('accepts an activity heartbeat and keeps the socket healthy', async () => {
    const ws = await connectPresenceWs(token1);
    openSockets.push(ws);
    await delay(200);

    // The client sends {type:'activity'} on clicks/keystrokes so push-send can
    // treat the user as active. It must be absorbed silently (no reply) and must
    // not tear down the connection or its keepalive.
    ws.send(JSON.stringify({ type: 'activity' }));
    await expectNoMessage(ws, () => true, 500);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Ping still round-trips after an activity message (attachment intact).
    const pongPromise = waitForMessage(ws, (msg) => msg.type === 'pong');
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await pongPromise;
    expect(pong.type).toBe('pong');

    // And the user is still reported online.
    const res = await authedFetch(token2, `/presence?userIds=${user1.id}`);
    const body = await res.json() as Record<string, boolean>;
    expect(body[user1.id]).toBe(true);
  });

  // ── GET /presence?userIds= batch fetch ──────────────────────────────────

  it('returns presence state for requested userIds via GET /presence', async () => {
    // user1 connects to presence
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // Query presence for user1 and user2
    const res = await authedFetch(token2, `/presence?userIds=${user1.id},${user2.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, boolean>;
    expect(body[user1.id]).toBe(true);
    expect(body[user2.id]).toBe(false);
  });

  // ── Integration: two clients see each other's presence ──────────────────

  it('two clients see each other come online', async () => {
    // user1 connects
    const ws1 = await connectPresenceWs(token1);
    openSockets.push(ws1);
    await delay(200);

    // user2 connects — both should see the other
    const user2OnlinePromise = waitForMessage(ws1, (msg) =>
      msg.type === 'presence_update' && msg.userId === user2.id && msg.online === true,
    );
    const ws2 = await connectPresenceWs(token2);
    openSockets.push(ws2);

    // ws2 gets snapshot with user1 online
    const snapshot = await waitForMessage(ws2, (msg) => msg.type === 'presence_snapshot');
    const users = snapshot.users as Record<string, boolean>;
    expect(users[user1.id]).toBe(true);

    // ws1 gets user2 online update
    const msg = await user2OnlinePromise;
    expect(msg.userId).toBe(user2.id);
    expect(msg.online).toBe(true);
  });
});
