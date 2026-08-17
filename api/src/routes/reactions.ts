import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { publishChannelEvent } from '../lib/channel-events.js';

export async function handleAddReaction(request: Request, env: Env, user: User, messageId: string, ctx?: ExecutionContext): Promise<Response> {
  const { emoji } = await readJsonObject<{ emoji: string }>(request);
  if (!emoji) return errorResponse('Emoji required');

  const msg = await env.DB.prepare('SELECT m.channel_id, c.processing_mode, c.auto_respond_bot_id, u.role AS author_role FROM messages m JOIN channels c ON m.channel_id = c.id JOIN users u ON m.user_id = u.id WHERE m.id = ?')
    .bind(messageId).first<{ channel_id: string; processing_mode: string | null; auto_respond_bot_id: string | null; author_role: string | null }>();
  if (!msg) return errorResponse('Message not found', 404);
  // Resolving a message by id is not authorization. Without this, any
  // authenticated user who knows a message id could react into a private
  // channel they were never in — persisting their name on the message and
  // broadcasting reaction_added (and webhooks) to that channel's members.
  // Mirrors handleGetMessage, which has always checked.
  await requireChannelMembership(env, user.id, msg.channel_id);

  try {
    await env.DB.prepare(
      'INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
    ).bind(messageId, user.id, emoji).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return jsonResponse({ ok: true }); // already reacted
    throw e;
  }

  // Broadcast (include channel config so daemon can decide whether to process)
  // Bot reacting to bot-authored message: filter out all bot recipients
  const botSender = (user.role === 'bot' && msg.author_role === 'bot')
    ? { mentionedUserIds: [] as string[] }
    : undefined;
  await publishChannelEvent(env, ctx, msg.channel_id, {
    type: 'reaction_added',
    messageId,
    userId: user.id,
    username: user.username,
    userRole: user.role || 'user',
    messageAuthorRole: msg.author_role || 'user',
    emoji,
    autoRespondBotId: msg.auto_respond_bot_id ?? null,
    processingMode: msg.processing_mode || 'immediate',
  }, {
    realtime: { botSender },
    webhooks: {
      senderId: user.id,
      senderRole: botSender ? user.role : undefined,
      mentionedUserIds: botSender?.mentionedUserIds,
    },
  });

  return jsonResponse({ ok: true }, 201);
}

export async function handleRemoveReaction(env: Env, user: User, messageId: string, emoji: string, ctx?: ExecutionContext): Promise<Response> {
  const msg = await env.DB.prepare('SELECT channel_id FROM messages WHERE id = ?')
    .bind(messageId).first<{ channel_id: string }>();
  if (!msg) return errorResponse('Message not found', 404);
  // The DELETE below is already scoped to the caller's own reaction, so this
  // guards the side effects rather than the data: without it a non-member can
  // still emit reaction_removed into a private channel and probe whether a
  // given message id exists.
  await requireChannelMembership(env, user.id, msg.channel_id);

  await env.DB.prepare(
    'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
  ).bind(messageId, user.id, emoji).run();

  // Broadcast
  await publishChannelEvent(env, ctx, msg.channel_id, {
    type: 'reaction_removed',
    messageId,
    userId: user.id,
    emoji,
  }, {
    webhooks: { senderId: user.id },
  });

  return jsonResponse({ ok: true });
}
