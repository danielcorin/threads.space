import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishChannelEvent } from '../lib/channel-events.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import type { Env } from '../types.js';

vi.mock('../lib/webhooks.js', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

const broadcastMessage = vi.fn().mockResolvedValue(undefined);
const env = {
  CHAT_ROOM: {
    idFromName: vi.fn((channelId: string) => channelId),
    get: vi.fn(() => ({ broadcastMessage })),
  },
} as unknown as Env;

describe('publishChannelEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses its channel argument as the canonical routing key without rewriting the payload', async () => {
    await publishChannelEvent(env, undefined, 'channel-1', {
      type: 'message_edited',
      channelId: 'wrong-channel',
      id: 'message-1',
    });

    expect(broadcastMessage).toHaveBeenCalledWith(
      'channel-1',
      {
        type: 'message_edited',
        channelId: 'wrong-channel',
        id: 'message-1',
      },
      undefined,
      undefined,
    );
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('uses the same unchanged event for explicitly enabled webhooks', async () => {
    await publishChannelEvent(env, undefined, 'channel-1', {
      type: 'reaction_added',
      messageId: 'message-1',
    }, {
      realtime: {
        excludeRoles: ['bot'],
        botSender: { mentionedUserIds: ['bot-1'] },
      },
      webhooks: {
        senderId: 'user-1',
        senderRole: 'human',
      },
    });

    const event = {
      type: 'reaction_added',
      messageId: 'message-1',
    };
    expect(broadcastMessage).toHaveBeenCalledWith(
      'channel-1',
      event,
      ['bot'],
      { mentionedUserIds: ['bot-1'] },
    );
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      env,
      'channel-1',
      event,
      { senderId: 'user-1', senderRole: 'human' },
    );
  });

  it('schedules webhook delivery on the provided background context', async () => {
    const waitUntil = vi.fn();

    await publishChannelEvent(env, { waitUntil }, 'channel-1', {
      type: 'member_added',
      userId: 'user-1',
    }, { webhooks: {} });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});

describe('channel event publication boundary', () => {
  it('keeps the ChatRoom broadcast adapter behind the publisher', () => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const allowedAdapters = new Set(['chat-room.ts', 'lib/channel-events.ts']);
    const sourceFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => !path.includes('/__tests__/'));
    const bypasses = sourceFiles.filter((path) => {
      if (allowedAdapters.has(relative(sourceRoot, path))) return false;
      const source = readFileSync(path, 'utf8');
      return source.includes('.broadcastMessage(');
    }).map((path) => relative(sourceRoot, path));

    expect(bypasses).toEqual([]);
  });
});
