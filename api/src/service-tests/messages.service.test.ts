import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FEEDBACK_BOT_ID, FEEDBACK_CHANNEL_ID } from '../constants.js';
import { createMessage, MessageCreationError } from '../services/messages.js';
import type { Env, User } from '../types.js';

const actor: User = {
  id: 'service-user',
  username: 'service-user',
  email: 'service-user@example.com',
  email_normalized: 'service-user@example.com',
  email_verified_at: 1,
  display_name: 'Service User',
  name_color: null,
  code_theme: null,
  is_admin: 0,
  avatar_url: null,
  role: 'human',
  bot_capabilities_json: null,
  ephemeral_bot_id: null,
  created_at: 1,
};

const serviceEnv = env as unknown as Env;

beforeEach(async () => {
  await serviceEnv.DB.batch([
    serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, username, password_hash, display_name, role, is_admin)
       VALUES (?, ?, '!', ?, 'human', 0)`,
    ).bind(actor.id, actor.username, actor.display_name),
    serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, username, password_hash, display_name, role, is_admin)
       VALUES ('mentioned-user', 'mentioned-user', '!', 'Mentioned User', 'human', 0)`,
    ),
    serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO channels
       (id, name, description, is_private, created_by)
       VALUES ('service-channel', 'service-channel', NULL, 0, ?)`,
    ).bind(actor.id),
    serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id)
       VALUES ('service-channel', ?)`,
    ).bind(actor.id),
    serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id)
       VALUES ('service-channel', 'mentioned-user')`,
    ),
  ]);
});

describe('createMessage service interface', () => {
  it('exposes transport-independent rejection details', async () => {
    const outsider = { ...actor, id: 'service-outsider', username: 'service-outsider' };
    await serviceEnv.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, username, password_hash, display_name, role, is_admin)
       VALUES (?, ?, '!', 'Service Outsider', 'human', 0)`,
    ).bind(outsider.id, outsider.username).run();

    const rejection = await createMessage(serviceEnv, {
      actor: outsider,
      channelId: 'service-channel',
      content: 'not allowed',
    }).catch((error) => error);

    expect(rejection).toBeInstanceOf(MessageCreationError);
    expect(rejection).toMatchObject({
      status: 403,
      message: 'Not a member of this channel',
    });
  });

  it('owns persistence, mention parsing, and idempotent retries', async () => {
    const command = {
      actor,
      channelId: 'service-channel',
      content: '  hello @mentioned-user  ',
      idempotencyKey: 'service-idempotency-key',
    };

    const created = await createMessage(serviceEnv, command);
    const retried = await createMessage(serviceEnv, command);

    expect(created.outcome).toBe('created');
    expect(retried.outcome).toBe('existing');
    expect(retried.message?.id).toBe(created.message?.id);

    const messages = await serviceEnv.DB.prepare(
      'SELECT id, content FROM messages WHERE channel_id = ? AND user_id = ?',
    ).bind(command.channelId, actor.id).all<{ id: string; content: string }>();
    expect(messages.results).toEqual([{ id: created.message?.id, content: 'hello @mentioned-user' }]);

    const mention = await serviceEnv.DB.prepare(
      'SELECT user_id, username FROM message_mentions WHERE message_id = ?',
    ).bind(created.message?.id).first<{ user_id: string; username: string }>();
    expect(mention).toEqual({ user_id: 'mentioned-user', username: 'mentioned-user' });
  });

  it('keeps feedback acknowledgement persistence behind the service', async () => {
    const ctx = createExecutionContext();

    const created = await createMessage(serviceEnv, {
      actor,
      channelId: FEEDBACK_CHANNEL_ID,
      content: 'Feedback from the direct service test',
    }, ctx);
    await waitOnExecutionContext(ctx);

    expect(created.outcome).toBe('created');
    const replies = await serviceEnv.DB.prepare(
      `SELECT user_id, content, message_type
       FROM messages
       WHERE channel_id = ?
       ORDER BY created_at, rowid`,
    ).bind(FEEDBACK_CHANNEL_ID).all<{
      user_id: string;
      content: string;
      message_type: string;
    }>();
    expect(replies.results).toHaveLength(2);
    expect(replies.results[0]).toMatchObject({
      user_id: actor.id,
      content: 'Feedback from the direct service test',
      message_type: 'human',
    });
    expect(replies.results[1]).toMatchObject({
      user_id: FEEDBACK_BOT_ID,
      message_type: 'response',
    });
  });
});
