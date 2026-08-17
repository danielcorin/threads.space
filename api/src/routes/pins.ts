import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { publishChannelEvent } from '../lib/channel-events.js';

export async function handlePinMessage(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);
  const { messageId } = await readJsonObject<{ messageId: string }>(request);
  if (!messageId) return errorResponse('messageId required');

  // Verify message exists and belongs to this channel
  const msg = await env.DB.prepare('SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL')
    .bind(messageId).first<{ id: string; channel_id: string }>();
  if (!msg) return errorResponse('Message not found', 404);
  if (msg.channel_id !== channelId) return errorResponse('Message does not belong to this channel', 400);

  const id = generateId();
  try {
    await env.DB.prepare(
      'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)'
    ).bind(id, channelId, messageId, user.id).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return errorResponse('Message already pinned', 409);
    throw e;
  }

  const pin = { id, channel_id: channelId, message_id: messageId, pinned_by: user.id, created_at: Math.floor(Date.now() / 1000) };

  // Broadcast via Durable Object
  publishChannelEvent(env, undefined, channelId, {
    type: 'message_pinned',
    channelId,
    messageId,
    pinnedBy: user.id,
    pin,
  }).catch(() => {});

  return jsonResponse(pin, 201);
}

export async function handleUnpinMessage(env: Env, user: User, channelId: string, messageId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const existing = await env.DB.prepare(
    'SELECT id FROM pinned_messages WHERE channel_id = ? AND message_id = ?'
  ).bind(channelId, messageId).first();
  if (!existing) return errorResponse('Pin not found', 404);

  await env.DB.prepare('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?')
    .bind(channelId, messageId).run();

  // Broadcast via Durable Object
  publishChannelEvent(env, undefined, channelId, {
    type: 'message_unpinned',
    channelId,
    messageId,
  }).catch(() => {});

  return jsonResponse({ ok: true });
}

export async function handleListPins(env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const pins = await env.DB.prepare(`
    SELECT pm.id, pm.channel_id, pm.message_id, pm.pinned_by, pm.created_at as pin_created_at,
      m.content, m.created_at as message_created_at, m.user_id,
      u.username, u.display_name, u.name_color, u.avatar_url,
      pb.username as pinned_by_username
    FROM pinned_messages pm
    JOIN messages m ON pm.message_id = m.id
    LEFT JOIN users u ON m.user_id = u.id
    LEFT JOIN users pb ON pm.pinned_by = pb.id
    WHERE pm.channel_id = ? AND m.deleted_at IS NULL
    ORDER BY pm.created_at DESC
  `).bind(channelId).all();

  return jsonResponse(pins.results);
}
