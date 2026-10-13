import { env } from 'cloudflare:workers';
import { beforeAll, expect, it, vi } from 'vitest';
import { MessageReadModel } from '../read-models/messages.js';
import { handleDeleteMessage } from '../routes/messages.js';
import type { Env, User } from '../types.js';

const serviceEnv = env as unknown as Env;
const model = new MessageReadModel(serviceEnv);
const actor = { id: 'reply-count-user', username: 'reply-count-user' } as User;
const channelId = 'reply-count-channel';
const rootId = 'reply-count-root';

beforeAll(async () => {
  await serviceEnv.DB.batch([
    serviceEnv.DB.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, '!')").bind(actor.id, actor.username),
    serviceEnv.DB.prepare('INSERT INTO channels (id, name, created_by) VALUES (?, ?, ?)').bind(channelId, channelId, actor.id),
    serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content) VALUES (?, ?, ?, 'Root')").bind(rootId, channelId, actor.id),
    ...['human', 'response', 'progress', 'tool_output', 'thinking'].map((type) => serviceEnv.DB.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, thread_id, message_type) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(`reply-${type}`, channelId, actor.id, type, rootId, type)),
    serviceEnv.DB.prepare("INSERT INTO messages (id, channel_id, user_id, content, thread_id, message_type, deleted_at) VALUES ('deleted-reply', ?, ?, 'Deleted', ?, 'response', 1)").bind(channelId, actor.id, rootId),
  ]);
});

it('counts human and final responses across message detail and channel pages, retaining trace rows in threads', async () => {
  expect(await model.getMessage(rootId)).toMatchObject({ reply_count: 2, replyCount: 2 });
  for (const options of [{}, { view: 'conversation' }, { around: rootId }]) {
    const page = await model.listChannelMessages(channelId, options);
    expect(page.messages.find((message) => message.id === rootId)).toMatchObject({ reply_count: 2 });
  }
  const replies = await model.listThreadReplies(rootId, {});
  expect(replies.messages).toHaveLength(5);
  expect(replies.messages.map((message) => message.message_type)).toContain('tool_output');
});

it('includes the deleted type for live counts, and does not broadcast a repeated deletion', async () => {
  const broadcastMessage = vi.fn().mockResolvedValue(undefined);
  const deleteEnv = { ...serviceEnv, CHAT_ROOM: { idFromName: (name: string) => name, get: () => ({ broadcastMessage }) } } as unknown as Env;
  for (const type of ['tool_output', 'human']) {
    await handleDeleteMessage(deleteEnv, actor, `reply-${type}`);
    expect(broadcastMessage).toHaveBeenLastCalledWith(channelId, {
      type: 'message_deleted', id: `reply-${type}`, threadId: rootId, messageType: type,
    }, undefined, undefined);
    expect(await model.getMessage(rootId)).toMatchObject({ reply_count: type === 'human' ? 1 : 2 });
  }
  await handleDeleteMessage(deleteEnv, actor, 'reply-human');
  expect(broadcastMessage).toHaveBeenCalledTimes(2);
});
