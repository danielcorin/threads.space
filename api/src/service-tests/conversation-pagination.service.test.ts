import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { MessageReadModel, type MessagePage } from '../read-models/messages.js';
import type { Env } from '../types.js';

const serviceEnv = env as unknown as Env;
const model = new MessageReadModel(serviceEnv);
const channelId = 'conversation-pagination';
const rootId = (n: number) => `conversation-${String(n).padStart(4, '0')}-0`;
const visible = (page: MessagePage) => page.messages.filter((message) => ['human', 'response'].includes(message.message_type));

beforeAll(async () => {
  await serviceEnv.DB.batch([
    serviceEnv.DB.prepare("INSERT INTO users (id, username, password_hash) VALUES ('pagination-user', 'pagination-user', '!')"),
    serviceEnv.DB.prepare("INSERT INTO channels (id, name, created_by) VALUES (?, ?, 'pagination-user')").bind(channelId, channelId),
  ]);
  const statements = [];
  for (let i = 0; i < 75; i++) {
    statements.push(serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content, message_type) VALUES (?, ?, 'pagination-user', ?, ?)")
      .bind(rootId(i), channelId, `Conversation ${i}`, i % 2 ? 'response' : 'human'));
    for (let j = 1; j <= 3; j++) {
      statements.push(serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content, message_type, metadata) VALUES (?, ?, 'pagination-user', 'Step', ?, ?)")
        .bind(`conversation-${String(i).padStart(4, '0')}-${j}`, channelId, ['progress', 'tool_output', 'thinking'][j - 1], JSON.stringify({ trigger_id: rootId(i) })));
    }
    statements.push(serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content, thread_id) VALUES (?, ?, 'pagination-user', 'Thread reply', ?)")
      .bind(`conversation-${String(i).padStart(4, '0')}-4`, channelId, rootId(i)));
  }
  for (let i = 0; i < 60; i++) {
    statements.push(serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content, message_type) VALUES (?, ?, 'pagination-user', 'Trailing tool call', 'tool_output')")
      .bind(`conversation-9999-${String(i).padStart(4, '0')}`, channelId));
  }
  await serviceEnv.DB.batch(statements);
});

describe('conversation pages', () => {
  it('loads 50 visible top-level messages even after more than 50 trailing tool calls', async () => {
    const page = await model.listChannelMessages(channelId, { view: 'conversation' });
    expect(visible(page).map((message) => message.id)).toEqual(Array.from({ length: 50 }, (_, i) => rootId(i + 25)));
    expect(page.cursor).toBe(rootId(25));
    expect(page.messages.every((message) => message.thread_id === null)).toBe(true);
    expect(page.messages.filter((message) => message.message_type === 'tool_output')).toHaveLength(110);
  });

  it('pages older conversation messages with no gaps or duplicate trace rows', async () => {
    const latest = await model.listChannelMessages(channelId, { view: 'conversation' });
    const older = await model.listChannelMessages(channelId, { view: 'conversation', cursor: latest.cursor });
    expect(visible(older).map((message) => message.id)).toEqual(Array.from({ length: 25 }, (_, i) => rootId(i)));
    expect(older.cursor).toBeNull();
    const newerIds = new Set(latest.messages.map((message) => message.id));
    expect(older.messages.every((message) => !newerIds.has(message.id))).toBe(true);
  });

  it('counts visible messages in both anchored and forward pages and retains steps between forward boundaries', async () => {
    const around = await model.listChannelMessages(channelId, { view: 'conversation', around: rootId(30), limit: 10 });
    expect(visible(around).map((message) => message.id)).toEqual(Array.from({ length: 10 }, (_, i) => rootId(25 + i)));
    expect(around.hasNewer).toBe(true);
    const next = await model.listChannelMessages(channelId, { view: 'conversation', after: around.afterCursor, limit: 10 });
    expect(visible(next).map((message) => message.id)).toEqual(Array.from({ length: 10 }, (_, i) => rootId(35 + i)));
    expect(next.messages.some((message) => message.id === 'conversation-0034-1')).toBe(true);
    const tail = await model.listChannelMessages(channelId, { view: 'conversation', after: rootId(74) });
    expect(visible(tail)).toHaveLength(0);
    expect(tail.messages).toHaveLength(63);
  });

  it('preserves the raw API view for callers that page individual step rows', async () => {
    const raw = await model.listChannelMessages(channelId, { limit: 50 });
    expect(raw.messages).toHaveLength(50);
    expect(raw.messages.every((message) => message.message_type === 'tool_output')).toBe(true);
  });
});
