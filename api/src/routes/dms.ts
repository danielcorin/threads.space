import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';

const BOT_DM_DISABLED_REASON = 'DMing this bot is not enabled for this user';

function parseBotCapabilities(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function canUserSendToBotDm(user: User, bot: Pick<User, 'id' | 'username' | 'role' | 'bot_capabilities_json'>): boolean {
  // Bots can proactively message anyone, including opening/using DMs with humans.
  if (user.role === 'bot') return true;
  if (bot.role !== 'bot') return true;

  // Admins can DM any bot.
  if (user.is_admin) return true;

  // Per-bot opt-in for future registered/owned bots. Bots can advertise either
  // usernames or user ids in their capabilities without requiring a schema change.
  const caps = parseBotCapabilities(bot.bot_capabilities_json);
  const allowedUsernames = stringArray(caps?.dm_allowed_usernames);
  const allowedUserIds = stringArray(caps?.dm_allowed_user_ids);
  return allowedUsernames.includes(user.username) || allowedUserIds.includes(user.id);
}

export function botDmDisabledReason(user: User, bot: Pick<User, 'id' | 'username' | 'role' | 'bot_capabilities_json'>): string | null {
  return canUserSendToBotDm(user, bot) ? null : BOT_DM_DISABLED_REASON;
}

export async function handleCreateOrGetDM(request: Request, env: Env, user: User): Promise<Response> {
  const { userId } = await readJsonObject<{ userId: string }>(request);
  if (!userId) return errorResponse('userId is required');
  if (userId === user.id) return errorResponse('Cannot DM yourself');

  // Verify target user exists
  const targetUserRow = await env.DB.prepare('SELECT id, username, display_name, name_color, role, bot_capabilities_json FROM users WHERE id = ?')
    .bind(userId).first<{ id: string; username: string; display_name: string | null; name_color: string | null; role: string; bot_capabilities_json: string | null }>();
  // role kept on response so client can pick bot icon
  if (!targetUserRow) return errorResponse('User not found', 404);
  const targetUser = {
    id: targetUserRow.id,
    username: targetUserRow.username,
    display_name: targetUserRow.display_name,
    name_color: targetUserRow.name_color,
    role: targetUserRow.role,
    bot_capabilities: parseBotCapabilities(targetUserRow.bot_capabilities_json),
  };
  const disabledReason = botDmDisabledReason(user, targetUserRow);

  // Check if a DM channel already exists between these two users
  const existing = await env.DB.prepare(`
    SELECT c.id, c.name, c.is_dm, c.dm_partner_id, c.created_at
    FROM channels c
    JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.user_id = ?
    JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.user_id = ?
    WHERE c.is_dm = 1
    LIMIT 1
  `).bind(user.id, userId).first<{ id: string; name: string; is_dm: number; dm_partner_id: string | null; created_at: number }>();

  if (existing) {
    // Re-opening (or proactively opening) a DM should resurface it for the
    // requester: clear both hidden_at (hide via X / context-menu) and left_at
    // (soft-leave that should never have been settable on a DM but might be
    // present on legacy rows or via the CLI). The partner's flags are left
    // alone — they get a separate resurface only on a new message (handled
    // in messages.ts).
    await env.DB.prepare(
      'UPDATE channel_members SET hidden_at = NULL, left_at = NULL WHERE channel_id = ? AND user_id = ?'
    ).bind(existing.id, user.id).run();
    return jsonResponse({
      ...existing,
      partner: targetUser,
      can_send_messages: disabledReason === null,
      disabled_reason: disabledReason,
    });
  }

  if (disabledReason) {
    return errorResponse(disabledReason, 403);
  }

  // Create new DM channel
  const id = generateId();
  const [id1, id2] = [user.id, userId].sort();
  const name = `dm-${id1}-${id2}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO channels (id, name, description, is_private, is_dm, created_by) VALUES (?, ?, NULL, 1, 1, ?)'
      ).bind(id, name, user.id),
      env.DB.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).bind(id, user.id),
      env.DB.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).bind(id, userId),
    ]);
  } catch (e: any) {
    // The DM name is deterministic (dm-<sorted ids>) and UNIQUE: a concurrent
    // request for the same pair may have won the race. Return its channel
    // instead of surfacing a 500.
    if (e.message?.includes('UNIQUE')) {
      const winner = await env.DB.prepare(
        'SELECT id, name, is_dm, dm_partner_id, created_at FROM channels WHERE name = ? AND is_dm = 1'
      ).bind(name).first<{ id: string; name: string; is_dm: number; dm_partner_id: string | null; created_at: number }>();
      if (winner) {
        return jsonResponse({
          ...winner,
          partner: targetUser,
          can_send_messages: disabledReason === null,
          disabled_reason: disabledReason,
        });
      }
    }
    throw e;
  }

  return jsonResponse({
    id,
    name,
    is_dm: 1,
    dm_partner_id: null,
    created_at: Math.floor(Date.now() / 1000),
    partner: targetUser,
    can_send_messages: true,
    disabled_reason: null,
  }, 201);
}

export async function handleListDMs(env: Env, user: User): Promise<Response> {
  const dms = await env.DB.prepare(`
    SELECT c.id, c.name, c.is_dm, c.dm_partner_id, c.created_at,
      cm.position as position,
      cm.notifications,
      cr.last_read_message_id,
      u.id as partner_id, u.username as partner_username, u.display_name as partner_display_name, u.name_color as partner_name_color, u.role as partner_role, u.bot_capabilities_json as partner_bot_capabilities_json,
      CASE cm.notifications
        WHEN 'none' THEN 0
        WHEN 'mentions' THEN CASE WHEN (
          SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
            AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id)
            AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ?)
        ) IS NOT NULL AND (
          cr.last_read_message_id IS NULL OR cr.last_read_message_id < (
            SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id)
              AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ?)
          )
        ) THEN 1 ELSE 0 END
        ELSE CASE WHEN (
          SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
            AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id)
        ) IS NOT NULL AND (
          cr.last_read_message_id IS NULL OR cr.last_read_message_id < (
            SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
              AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id)
          )
        ) THEN 1 ELSE 0 END
      END as has_unread,
      CASE cm.notifications
        WHEN 'none' THEN 0
        WHEN 'mentions' THEN (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
          AND (cr.last_read_message_id IS NULL OR m.id > cr.last_read_message_id)
          AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id)
          AND EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = ?))
        ELSE (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.user_id != ? AND m.message_type IN ('human', 'response')
          AND (cr.last_read_message_id IS NULL OR m.id > cr.last_read_message_id)
          AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.user_id = cm.user_id AND mr.message_id = m.id))
      END as unread_count,
      (SELECT m.content FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.thread_id IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_content,
      (SELECT m.created_at FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.thread_id IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at
    FROM channels c
    JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ?
    JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.user_id != ?
    JOIN users u ON cm2.user_id = u.id
    LEFT JOIN channel_reads cr ON c.id = cr.channel_id AND cr.user_id = ?
    WHERE c.is_dm = 1 AND cm.hidden_at IS NULL
    ORDER BY cm.position IS NULL, cm.position ASC, last_message_at DESC, c.created_at DESC
  `).bind(user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id).all();

  const results = dms.results.map((dm: any) => ({
    id: dm.id,
    name: dm.name,
    is_dm: dm.is_dm,
    dm_partner_id: dm.dm_partner_id,
    created_at: dm.created_at,
    position: dm.position,
    last_read_message_id: dm.last_read_message_id ?? null,
    notifications: dm.notifications,
    has_unread: dm.has_unread,
    unread_count: dm.unread_count,
    last_message_content: dm.last_message_content,
    last_message_at: dm.last_message_at,
    partner: {
      id: dm.partner_id,
      username: dm.partner_username,
      display_name: dm.partner_display_name,
      name_color: dm.partner_name_color,
      role: dm.partner_role,
      bot_capabilities: parseBotCapabilities(dm.partner_bot_capabilities_json),
    },
    can_send_messages: botDmDisabledReason(user, {
      id: dm.partner_id,
      username: dm.partner_username,
      role: dm.partner_role,
      bot_capabilities_json: dm.partner_bot_capabilities_json,
    }) === null,
    disabled_reason: botDmDisabledReason(user, {
      id: dm.partner_id,
      username: dm.partner_username,
      role: dm.partner_role,
      bot_capabilities_json: dm.partner_bot_capabilities_json,
    }),
  }));

  return jsonResponse(results);
}

export async function handleReorderDMs(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject<{ items?: { id: string; position: number }[] }>(request);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return errorResponse('items is required');
  }

  // Validate all entries reference DMs the user is a member of.
  const ids = items.map((i) => i.id);
  const placeholders = ids.map(() => '?').join(',');
  const owned = await env.DB.prepare(`
    SELECT cm.channel_id FROM channel_members cm
    JOIN channels c ON c.id = cm.channel_id
    WHERE cm.user_id = ? AND c.is_dm = 1 AND cm.channel_id IN (${placeholders})
  `).bind(user.id, ...ids).all<{ channel_id: string }>();
  const ownedSet = new Set((owned.results || []).map((r) => r.channel_id));
  for (const item of items) {
    if (!ownedSet.has(item.id)) {
      return errorResponse('DM not found or not a member', 404);
    }
    if (!Number.isInteger(item.position) || item.position < 0) {
      return errorResponse('position must be a non-negative integer');
    }
  }

  await env.DB.batch(
    items.map((item) =>
      env.DB.prepare(
        'UPDATE channel_members SET position = ? WHERE channel_id = ? AND user_id = ?'
      ).bind(item.position, item.id, user.id)
    )
  );

  return jsonResponse({ ok: true });
}

export async function handleHideDM(env: Env, user: User, dmId: string): Promise<Response> {
  // Verify channel exists and is a DM
  const channel = await env.DB.prepare('SELECT id, is_dm FROM channels WHERE id = ?')
    .bind(dmId).first<{ id: string; is_dm: number }>();
  if (!channel || !channel.is_dm) return errorResponse('DM not found', 404);

  // Verify user is a member
  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?'
  ).bind(dmId, user.id).first();
  if (!membership) return errorResponse('Not a member of this DM', 403);

  await env.DB.prepare(
    'UPDATE channel_members SET hidden_at = ? WHERE channel_id = ? AND user_id = ?'
  ).bind(new Date().toISOString(), dmId, user.id).run();

  return jsonResponse({ ok: true });
}
