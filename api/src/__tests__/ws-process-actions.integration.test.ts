import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { authedFetch, createTestUser, json, loginUser } from './helpers.js';

const WS_BASE = 'ws://localhost:8799';

interface WsMessage {
  type: string;
  actionId?: string | number | null;
  action?: string;
  status?: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

function connect(path: string, sessionToken: string, readyType?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}${path}`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket connection to ${path} timed out`));
    }, 5000);
    ws.on('error', reject);
    if (!readyType) {
      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      return;
    }
    ws.on('message', function onReady(data) {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        if (message.type === readyType) {
          clearTimeout(timeout);
          ws.removeListener('message', onReady);
          resolve(ws);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
  });
}

function sendAction(
  ws: WebSocket,
  action: Record<string, unknown> & { actionId: string },
): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timed out waiting for action ${action.type}`));
    }, 5000);
    function handler(data: WebSocket.Data) {
      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        if (
          (message.type === 'action_result' || message.type === 'action_error')
          && message.actionId === action.actionId
        ) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(message);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify(action));
  });
}

describe('WebSocket process actions', () => {
  let humanToken: string;
  let botToken: string;
  let channelId: string;
  const openSockets: WebSocket[] = [];

  async function createTrigger(content: string): Promise<string> {
    const response = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    expect(response.status).toBe(201);
    return (await json(response)).id;
  }

  beforeAll(async () => {
    await createTestUser('wsproc_human');
    humanToken = (await loginUser('wsproc_human')).sessionToken;

    await createTestUser('wsproc_bot', 'testpass123', 'WS Process Bot', 'bot');
    botToken = (await loginUser('wsproc_bot')).sessionToken;

    const channelResponse = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'ws-process-actions' }),
    });
    channelId = (await json(channelResponse)).id;
    const joinResponse = await authedFetch(botToken, `/channels/${channelId}/join`, { method: 'POST' });
    expect(joinResponse.ok).toBe(true);
  });

  afterEach(() => {
    for (const ws of openSockets) {
      try {
        ws.terminate();
      } catch {
        // Already closed.
      }
    }
    openSockets.length = 0;
  });

  it('runs the complete process lifecycle over the owner-scoped /events socket', async () => {
    const triggerId = await createTrigger('owner-scoped process trigger');
    const ws = await connect('/events', botToken, 'events.ready');
    openSockets.push(ws);

    const created = await sendAction(ws, {
      type: 'process.create',
      actionId: 'events-create',
      channelId,
      messageId: triggerId,
      status: 'running',
    });
    expect(created).toMatchObject({
      type: 'action_result',
      actionId: 'events-create',
      action: 'process.create',
      status: 201,
    });
    const processId = created.result?.id;
    expect(typeof processId).toBe('string');

    const stamped = await sendAction(ws, {
      type: 'message.process_status',
      actionId: 'events-status',
      messageId: triggerId,
      processId,
      status: 'processing',
    });
    expect(stamped).toMatchObject({
      type: 'action_result',
      actionId: 'events-status',
      action: 'message.process_status',
      status: 200,
    });

    const activity = await sendAction(ws, {
      type: 'process.activity',
      actionId: 'events-activity',
      processId,
      activityType: 'tool_call',
    });
    expect(activity).toMatchObject({
      type: 'action_result',
      actionId: 'events-activity',
      action: 'process.activity',
      status: 200,
    });

    const updated = await sendAction(ws, {
      type: 'process.update',
      actionId: 'events-update',
      processId,
      status: 'done',
    });
    expect(updated).toMatchObject({
      type: 'action_result',
      actionId: 'events-update',
      action: 'process.update',
      status: 200,
    });
  });

  it('accepts process creation over a per-channel socket', async () => {
    const triggerId = await createTrigger('per-channel process trigger');
    const ws = await connect(`/ws/${channelId}`, botToken);
    openSockets.push(ws);

    const result = await sendAction(ws, {
      type: 'process.create',
      actionId: 'channel-create',
      channel_id: channelId,
      message_id: triggerId,
      status: 'queued',
    });
    expect(result).toMatchObject({
      type: 'action_result',
      actionId: 'channel-create',
      action: 'process.create',
      status: 201,
      result: { status: 'queued' },
    });
  });

  it('returns an immediate correlated error for unsupported actions', async () => {
    const ws = await connect('/events', botToken, 'events.ready');
    openSockets.push(ws);

    const result = await sendAction(ws, {
      type: 'process.teleport',
      actionId: 'unsupported-action',
    });
    expect(result).toMatchObject({
      type: 'action_error',
      actionId: 'unsupported-action',
      status: 400,
    });
    expect(JSON.stringify(result.error)).toContain('Unsupported WebSocket action');
  });
});
