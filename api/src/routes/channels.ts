import type { Env, User, Channel } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { publishChannelEvent, type ChannelEvent } from '../lib/channel-events.js';
import { FEEDBACK_CHANNEL_ID } from '../constants.js';

/** Deliver a user-targeted event over the global PresenceRoom (one DO hop). */
function notifyUsersViaPresence(env: Env, userIds: string[], event: Record<string, unknown>, ctx?: ExecutionContext): void {
  if (userIds.length === 0) return;
  const room = env.PRESENCE_ROOM.get(env.PRESENCE_ROOM.idFromName('global'));
  const delivery = room.sendToUsers(userIds, event).catch((error) => console.error('Channel presence notification failed:', error));
  ctx?.waitUntil(delivery);
}

/** Notify all of the actor's devices after a channel membership is committed. */
function notifyMembershipAdded(env: Env, user: User, channelId: string, ctx?: ExecutionContext): void {
  notifyUsersViaPresence(env, [user.id], {
    type: 'member_added',
    channelId,
    targetUserId: user.id,
    username: user.username,
    displayName: user.display_name,
  }, ctx);
}

/**
 * Compat path for bot adapters that only listen on channel sockets: replay an
 * event through the target's most recently joined channels, bounded so a bot
 * in hundreds of channels doesn't wake hundreds of DOs.
 */
async function notifyBotViaRecentChannels(env: Env, botUserId: string, excludeChannelId: string, event: Record<string, unknown>): Promise<void> {
  const recent = await env.DB.prepare(
    `SELECT channel_id FROM channel_members
      WHERE user_id = ? AND channel_id != ? AND left_at IS NULL
      ORDER BY rowid DESC LIMIT 20`
  ).bind(botUserId, excludeChannelId).all<{ channel_id: string }>();
  for (const row of recent.results) {
    const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(row.channel_id));
    room.sendToUser(botUserId, event).catch(() => {});
  }
}

export async function handleListChannels(env: Env, user: User): Promise<Response> {
  const channels = await env.DB.prepare(`
    SELECT c.*,
      cm.notifications,
      cr.last_read_message_id,
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
      END as unread_count
    FROM channels c
    JOIN channel_members cm ON c.id = cm.channel_id
    LEFT JOIN channel_reads cr ON c.id = cr.channel_id AND cr.user_id = ?
    WHERE cm.user_id = ? AND (c.is_dm = 0 OR c.is_dm IS NULL) AND cm.left_at IS NULL AND c.archived_at IS NULL
    ORDER BY c.name
  `).bind(user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id).all<Channel & { notifications: string; has_unread: number; unread_count: number; last_read_message_id: string | null }>();

  return jsonResponse(channels.results);
}

export async function handleBrowseChannels(env: Env, user: User): Promise<Response> {
  const channels = await env.DB.prepare(`
    SELECT c.*,
      CASE WHEN cm.user_id IS NOT NULL AND cm.left_at IS NULL THEN 1 ELSE 0 END as is_member,
      (SELECT COUNT(*) FROM channel_members cm2 WHERE cm2.channel_id = c.id AND cm2.left_at IS NULL) as member_count
    FROM channels c
    LEFT JOIN channel_members cm ON c.id = cm.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
    WHERE c.is_private = 0 AND (c.is_dm = 0 OR c.is_dm IS NULL)
    ORDER BY c.name
  `).bind(user.id).all();

  return jsonResponse(channels.results);
}

export async function handleCreateChannel(request: Request, env: Env, user: User, ctx?: ExecutionContext): Promise<Response> {
  const { name, description, isPrivate } = await readJsonObject<{
    name: string;
    description?: string;
    isPrivate?: boolean;
  }>(request);
  if (!name) return errorResponse('Channel name required');

  // Only admins may create private channels.
  if (isPrivate && !user.is_admin) {
    return errorResponse('You do not have permission to create private channels', 403);
  }

  const id = generateId();

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO channels (id, name, description, is_private, is_dm, created_by) VALUES (?, ?, ?, ?, 0, ?)'
      ).bind(id, name, description ?? null, isPrivate ? 1 : 0, user.id),
      env.DB.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).bind(id, user.id),
    ]);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return errorResponse('Channel name already exists', 409);
    throw e;
  }

  notifyMembershipAdded(env, user, id, ctx);
  return jsonResponse({ id, name, description: description ?? null, isPrivate: isPrivate ?? false }, 201);
}

/**
 * Create an ephemeral channel. Quick plus-button flow:
 * - is_ephemeral=1, is_private=1, auto_respond_bot_id = creator's configured ephemeral bot
 * - name is a timestamp placeholder; auto_named_at NULL means inference hasn't run yet
 * - membership: creator + the creator's configured ephemeral bot (per-user setting,
 *   users.ephemeral_bot_id). NULL means no bot is auto-added.
 * - description carries the creator's first-prompt-intent hint later; empty for now
 * - broadcasts member_added for the bot so its adapter connects to the new channel's WS immediately
 */
export async function handleCreateEphemeralChannel(request: Request, env: Env, user: User, ctx?: ExecutionContext): Promise<Response> {
  const id = generateId();
  // Timestamp placeholder like "ephemeral-1745256000" — unique, guaranteed non-colliding.
  // New (un-named) channels keep the "ephemeral-" prefix so it's obvious at a glance
  // that they haven't been named yet. Once Filae renames via the agent loop,
  // sanitizeEphemeralSlug drops the prefix so the named slug is clean kebab.
  const now = Math.floor(Date.now() / 1000);
  const name = `ephemeral-${now}`;

  // Resolve the creator's configured ephemeral bot (users.ephemeral_bot_id).
  // NULL means no bot. Re-check role='bot' so a since-demoted/deleted id is ignored.
  const bot = user.ephemeral_bot_id
    ? await env.DB.prepare(
        `SELECT id, username, display_name FROM users WHERE id = ? AND role = 'bot' LIMIT 1`
      ).bind(user.ephemeral_bot_id).first<{ id: string; username: string; display_name: string | null }>()
    : null;

  const statements = [
    env.DB.prepare(
      'INSERT INTO channels (id, name, description, is_private, is_dm, is_ephemeral, auto_respond_bot_id, created_by) VALUES (?, ?, NULL, 1, 0, 1, ?, ?)'
    ).bind(id, name, bot?.id ?? null, user.id),
    env.DB.prepare(
      'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
    ).bind(id, user.id),
  ];
  if (bot) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)'
      ).bind(id, bot.id)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return errorResponse('Channel name collision (rare, retry)', 409);
    throw e;
  }

  notifyMembershipAdded(env, user, id, ctx);

  // Broadcast member_added for the bot so its adapter connects to this channel's WS.
  // Without this, the bot won't know it's in the channel and won't respond to messages.
  // Delivered over the presence socket plus a bounded replay through its most
  // recent channel sockets (it isn't connected to this new one yet).
  if (bot) {
    const memberAddedEvent = {
      type: 'member_added' as const,
      channelId: id,
      targetUserId: bot.id,
      username: bot.username,
      displayName: bot.display_name,
    };
    const delivery = (async () => {
      await publishChannelEvent(env, ctx, id, memberAddedEvent, {
        webhooks: {
          senderId: user.id,
          senderRole: user.role,
        },
      });
      notifyUsersViaPresence(env, [bot.id], memberAddedEvent, ctx);
      await notifyBotViaRecentChannels(env, bot.id, id, memberAddedEvent);
    })().catch((error) => console.error('Ephemeral channel notification failed:', error));
    if (ctx) ctx.waitUntil(delivery);
    else await delivery;
  }

  return jsonResponse({
    id,
    name,
    description: null,
    is_private: 1,
    is_dm: 0,
    is_ephemeral: 1,
    auto_respond_bot_id: bot?.id ?? null,
    auto_named_at: null,
    archived_at: null,
    created_by: user.id,
    created_at: now,
  }, 201);
}

/**
 * Sanitize a free-form slug candidate into a kebab-case channel name.
 * Lowercase, non-alphanumeric → dash, collapse consecutive dashes, trim.
 * No "ephemeral-" prefix — is_ephemeral=1 + the Ephemeral sidebar section are the
 * disambiguators; Phase 4 logging wraps the slug in [ephemeral:<slug>] which keeps
 * the log convention clean without polluting the display name. Truncated to 40 chars.
 */
function sanitizeEphemeralSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'untitled';
}

function sanitizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

/** Promote an ephemeral channel into a first-class channel while preserving history, members, and metadata in place. */
export async function handlePromoteEphemeralChannel(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  const { name } = await readJsonObject<{ name?: string }>(request).catch((): { name?: string } => ({}));
  const channel = await env.DB.prepare(
    'SELECT id, name, is_ephemeral, archived_at FROM channels WHERE id = ?'
  ).bind(channelId).first<{ id: string; name: string; is_ephemeral: number; archived_at: number | null }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (!channel.is_ephemeral) return errorResponse('Only ephemeral channels can be promoted', 400);
  if (channel.archived_at) return errorResponse('Cannot promote archived channel', 400);

  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, user.id).first();
  if (!membership) return errorResponse('Not a member of this channel', 403);

  const newName = sanitizeChannelName(name || channel.name);
  const existing = await env.DB.prepare('SELECT id FROM channels WHERE name = ? AND id != ?')
    .bind(newName, channelId).first();
  if (existing) return errorResponse('Channel name already exists', 409);

  await env.DB.prepare('UPDATE channels SET name = ?, is_ephemeral = 0, auto_named_at = NULL, archived_at = NULL WHERE id = ?')
    .bind(newName, channelId).run();

  publishChannelEvent(env, undefined, channelId, {
    type: 'channel_updated',
    channelId,
    name: newName,
    is_ephemeral: 0,
    auto_named_at: null,
    archived_at: null,
  }).catch(() => {});

  return jsonResponse({ ok: true, id: channelId, channelId, name: newName });
}

/**
 * Rename an ephemeral channel. Agent-loop path: the default bot calls this after reading
 * the first user prompt and inferring a short kebab-case slug. Server-side
 * guards: channel must be ephemeral and must not have been auto-named already
 * (unless regenerated). Broadcasts channel_updated so clients update sidebar.
 */
export async function handleRenameEphemeralChannel(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  const { slug } = await readJsonObject<{ slug: string }>(request);
  if (!slug || typeof slug !== 'string') return errorResponse('slug required');

  const channel = await env.DB.prepare('SELECT id, is_ephemeral, auto_named_at, archived_at FROM channels WHERE id = ?')
    .bind(channelId).first<{ id: string; is_ephemeral: number; auto_named_at: number | null; archived_at: number | null }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (!channel.is_ephemeral) return errorResponse('Only ephemeral channels support auto-rename', 400);
  if (channel.archived_at) return errorResponse('Cannot rename archived channel', 400);
  if (channel.auto_named_at) return errorResponse('Channel already named; use regenerate-name to re-trigger', 409);

  // Membership gate — only members of the channel can rename (Tela qualifies
  // via her channel_members row added on create).
  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, user.id).first();
  if (!membership) return errorResponse('Not a member of this channel', 403);

  const newName = sanitizeEphemeralSlug(slug);
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare('UPDATE channels SET name = ?, auto_named_at = ? WHERE id = ?')
      .bind(newName, now, channelId).run();
  } catch (e: any) {
    // Name collision is possible if another ephemeral already claimed this slug
    if (e.message?.includes('UNIQUE')) {
      const disambiguated = `${newName}-${Math.floor(Math.random() * 10000)}`;
      await env.DB.prepare('UPDATE channels SET name = ?, auto_named_at = ? WHERE id = ?')
        .bind(disambiguated, now, channelId).run();
      publishChannelEvent(env, undefined, channelId, {
        type: 'channel_updated',
        channelId,
        name: disambiguated,
        auto_named_at: now,
      }).catch(() => {});
      return jsonResponse({ ok: true, name: disambiguated, auto_named_at: now });
    }
    throw e;
  }

  publishChannelEvent(env, undefined, channelId, {
    type: 'channel_updated',
    channelId,
    name: newName,
    auto_named_at: now,
  }).catch(() => {});

  return jsonResponse({ ok: true, name: newName, auto_named_at: now });
}

/**
 * Regenerate an ephemeral channel's name. Clears auto_named_at so the next
 * message in the channel re-triggers the agent-loop rename directive.
 */
export async function handleRegenerateEphemeralName(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT id, is_ephemeral, created_by FROM channels WHERE id = ?')
    .bind(channelId).first<{ id: string; is_ephemeral: number; created_by: string }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (!channel.is_ephemeral) return errorResponse('Only ephemeral channels support regenerate-name', 400);
  if (channel.created_by !== user.id && !user.is_admin) {
    return errorResponse('Only the creator or an admin can regenerate the name', 403);
  }

  await env.DB.prepare('UPDATE channels SET auto_named_at = NULL WHERE id = ?')
    .bind(channelId).run();

  publishChannelEvent(env, undefined, channelId, {
    type: 'channel_updated',
    channelId,
    auto_named_at: null,
  }).catch(() => {});

  return jsonResponse({ ok: true, auto_named_at: null });
}

/**
 * Soft-archive an ephemeral channel. Sets archived_at to now; sidebar list
 * filters on archived_at IS NULL so it disappears from UI but remains searchable.
 */
export async function handleArchiveEphemeralChannel(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT id, is_ephemeral, created_by FROM channels WHERE id = ?')
    .bind(channelId).first<{ id: string; is_ephemeral: number; created_by: string }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (!channel.is_ephemeral) return errorResponse('Only ephemeral channels can be archived this way', 400);
  if (channel.created_by !== user.id && !user.is_admin) {
    return errorResponse('Only the creator or an admin can archive this channel', 403);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE channels SET archived_at = ? WHERE id = ?')
    .bind(now, channelId).run();

  publishChannelEvent(env, undefined, channelId, {
    type: 'channel_archived',
    channelId,
  }).catch(() => {});

  return jsonResponse({ ok: true, archived_at: now });
}

export async function handleUnarchiveEphemeralChannel(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT id, is_ephemeral FROM channels WHERE id = ?')
    .bind(channelId).first<{ id: string; is_ephemeral: number }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (!channel.is_ephemeral) return errorResponse('Only ephemeral channels can be unarchived this way', 400);

  await requireChannelMembership(env, user.id, channelId);

  await env.DB.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?')
    .bind(channelId).run();

  publishChannelEvent(env, undefined, channelId, {
    type: 'channel_updated',
    channelId,
    archived_at: null,
  }).catch(() => {});

  return jsonResponse({ ok: true, archived_at: null });
}

export async function handleGetChannel(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ?')
    .bind(channelId).first<Channel>();
  if (!channel) return errorResponse('Channel not found', 404);

  // Private channels: only members can view metadata
  if (channel.is_private) {
    const membership = await env.DB.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
    ).bind(channelId, user.id).first();
    if (!membership) return errorResponse('Channel not found', 404);
  }

  return jsonResponse(channel);
}

export async function handleUpdateChannel(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);
  // The global feedback channel is locked — its name/description/settings are
  // fixed for the instance (the client also hides the edit affordance).
  if (channelId === FEEDBACK_CHANNEL_ID) return errorResponse('The feedback channel cannot be edited', 403);
  const body = await readJsonObject<{ name?: string; description?: string; processingMode?: string; processing_mode?: string; board_enabled?: number; auto_respond_bot_id?: string | null; autoRespondBotId?: string | null }>(request);
  const { name, description } = body;
  const processingMode = body.processingMode ?? body.processing_mode;
  const boardEnabled = body.board_enabled;
  const autoRespondBotId = body.auto_respond_bot_id !== undefined ? body.auto_respond_bot_id : body.autoRespondBotId;
  const updates: string[] = [];
  const values: any[] = [];

  if (name !== undefined) { updates.push('name = ?'); values.push(name); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description); }
  if (boardEnabled !== undefined) { updates.push('board_enabled = ?'); values.push(boardEnabled ? 1 : 0); }
  if (processingMode !== undefined) {
    if (processingMode !== 'immediate' && processingMode !== 'serial') {
      return errorResponse('Invalid processing_mode. Must be: immediate, serial');
    }
    updates.push('processing_mode = ?'); values.push(processingMode);
  }
  if (autoRespondBotId !== undefined) {
    if (autoRespondBotId !== null) {
      // Validate: must be a bot member of this channel
      const botMember = await env.DB.prepare(
        `SELECT u.id FROM users u
         JOIN channel_members cm ON u.id = cm.user_id
         WHERE u.id = ? AND cm.channel_id = ? AND cm.left_at IS NULL AND u.role = 'bot'`
      ).bind(autoRespondBotId, channelId).first();
      if (!botMember) {
        return errorResponse('auto_respond_bot_id must reference a bot member of this channel', 400);
      }
    }
    updates.push('auto_respond_bot_id = ?'); values.push(autoRespondBotId);
  }
  if (!updates.length) return errorResponse('No updates provided');

  values.push(channelId);
  await env.DB.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  // Broadcast channel_updated to all connected clients in this channel
  const channelUpdatedEvent: ChannelEvent = { type: 'channel_updated', channelId };
  if (description !== undefined) channelUpdatedEvent.description = description;
  if (name !== undefined) channelUpdatedEvent.name = name;
  if (processingMode !== undefined) channelUpdatedEvent.processing_mode = processingMode;
  if (boardEnabled !== undefined) channelUpdatedEvent.board_enabled = boardEnabled ? 1 : 0;
  if (autoRespondBotId !== undefined) channelUpdatedEvent.auto_respond_bot_id = autoRespondBotId;

  publishChannelEvent(env, undefined, channelId, channelUpdatedEvent).catch(() => {});

  return jsonResponse({ ok: true });
}

export async function handleJoinChannel(env: Env, user: User, channelId: string, ctx?: ExecutionContext): Promise<Response> {
  // Check if channel is private
  const channel = await env.DB.prepare('SELECT is_private FROM channels WHERE id = ?')
    .bind(channelId).first<{ is_private: number }>();
  if (!channel) return errorResponse('Channel not found', 404);
  if (channel.is_private) {
    return errorResponse('Cannot join private channels directly', 403);
  }

  // Check if user was previously a member who left (soft delete)
  const existingMember = await env.DB.prepare(
    'SELECT left_at FROM channel_members WHERE channel_id = ? AND user_id = ?'
  ).bind(channelId, user.id).first<{ left_at: string | null }>();

  if (existingMember) {
    if (existingMember.left_at) {
      // Re-join: clear left_at
      await env.DB.prepare(
        'UPDATE channel_members SET left_at = NULL WHERE channel_id = ? AND user_id = ?'
      ).bind(channelId, user.id).run();
      notifyMembershipAdded(env, user, channelId, ctx);
    }
    return jsonResponse({ ok: true });
  }

  try {
    await env.DB.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)')
      .bind(channelId, user.id).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return jsonResponse({ ok: true }); // already a member
    throw e;
  }
  notifyMembershipAdded(env, user, channelId, ctx);
  return jsonResponse({ ok: true });
}

export async function handleLeaveChannel(env: Env, user: User, channelId: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .bind(channelId, user.id).run();
  // Invariant: clear auto_respond_bot_id if the leaving user was the auto-respond bot.
  await env.DB.prepare(
    'UPDATE channels SET auto_respond_bot_id = NULL WHERE id = ? AND auto_respond_bot_id = ?'
  ).bind(channelId, user.id).run();
  return jsonResponse({ ok: true });
}

export async function handleLeaveChannelSoft(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT id, is_dm FROM channels WHERE id = ?')
    .bind(channelId).first<{ id: string; is_dm: number }>();
  if (!channel) return errorResponse('Channel not found', 404);

  // DMs should never be soft-left — they have no add-member flow back. The
  // X close button and the context-menu Hide both call PATCH /dms/:id/hide
  // (handleHideDM), which sets hidden_at and is reversible by re-opening the
  // DM. Soft-leave on a DM would strand the user.
  if (channel.is_dm) {
    return errorResponse('Cannot leave a DM; hide it instead', 400);
  }

  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, user.id).first();
  if (!membership) return errorResponse('Not a member of this channel', 403);

  await env.DB.prepare(
    'UPDATE channel_members SET left_at = ? WHERE channel_id = ? AND user_id = ?'
  ).bind(new Date().toISOString(), channelId, user.id).run();
  // Invariant: clear auto_respond_bot_id if the leaving user was the auto-respond bot.
  await env.DB.prepare(
    'UPDATE channels SET auto_respond_bot_id = NULL WHERE id = ? AND auto_respond_bot_id = ?'
  ).bind(channelId, user.id).run();

  return jsonResponse({ ok: true });
}

export async function handleListMembers(env: Env, user: User, channelId: string): Promise<Response> {
  // For private channels, only allow members to see the member list
  const channel = await env.DB.prepare('SELECT is_private FROM channels WHERE id = ?')
    .bind(channelId).first<{ is_private: number }>();
  if (!channel) return errorResponse('Channel not found', 404);

  if (channel.is_private) {
    const membership = await env.DB.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
    ).bind(channelId, user.id).first();
    if (!membership) return errorResponse('Not a member of this channel', 403);
  }

  const members = await env.DB.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.role
    FROM users u JOIN channel_members cm ON u.id = cm.user_id
    WHERE cm.channel_id = ? AND cm.left_at IS NULL
    ORDER BY u.username
  `).bind(channelId).all();
  return jsonResponse(members.results);
}

export async function handleAddMember(request: Request, env: Env, user: User, channelId: string, ctx?: ExecutionContext): Promise<Response> {
  // Check channel exists
  const channel = await env.DB.prepare('SELECT is_private FROM channels WHERE id = ?')
    .bind(channelId).first<{ is_private: number }>();
  if (!channel) return errorResponse('Channel not found', 404);

  // Check caller is a member
  const callerMembership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, user.id).first();
  if (!callerMembership) return errorResponse('Not a member of this channel', 403);

  const { userId, username } = await readJsonObject<{ userId?: string; username?: string }>(request);
  if (!userId && !username) return errorResponse('userId or username required');

  // Resolve target user - look up by ID or username
  let targetUserId = userId;
  if (!targetUserId && username) {
    const userByName = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username).first<{ id: string }>();
    if (!userByName) return errorResponse('User not found', 404);
    targetUserId = userByName.id;
  } else {
    const targetUser = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(targetUserId).first();
    if (!targetUser) return errorResponse('User not found', 404);
  }

  try {
    await env.DB.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)')
      .bind(channelId, targetUserId!).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return jsonResponse({ ok: true }); // already a member
    throw e;
  }

  // Look up the new member's info for the broadcast
  const newMember = await env.DB.prepare('SELECT id, username, display_name FROM users WHERE id = ?')
    .bind(targetUserId!).first<{ id: string; username: string; display_name: string | null }>();

  const memberAddedEvent = {
    type: 'member_added',
    channelId,
    targetUserId: targetUserId!,
    username: newMember?.username,
    displayName: newMember?.display_name,
  };

  await publishChannelEvent(env, ctx, channelId, memberAddedEvent, {
    webhooks: {
      senderId: user.id,
      senderRole: user.role,
    },
  });

  // Also notify the added user directly (they aren't connected to this
  // channel yet): humans via the presence socket; bot adapters additionally
  // get a bounded replay through their recent channel sockets.
  notifyUsersViaPresence(env, [targetUserId!], memberAddedEvent);
  const targetRole = await env.DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(targetUserId!).first<{ role: string | null }>();
  if (targetRole?.role === 'bot') {
    await notifyBotViaRecentChannels(env, targetUserId!, channelId, memberAddedEvent);
  }

  return jsonResponse({ ok: true }, 201);
}

export async function handleDeleteChannel(env: Env, user: User, channelId: string): Promise<Response> {
  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ?')
    .bind(channelId).first<Channel>();
  if (!channel) return errorResponse('Channel not found', 404);

  // Only the channel creator or an admin can delete
  if (channel.created_by !== user.id && !user.is_admin) {
    return errorResponse('Only the channel creator or an admin can delete a channel', 403);
  }

  // Collect member user IDs before deletion so we can broadcast the event
  const members = await env.DB.prepare(
    'SELECT user_id FROM channel_members WHERE channel_id = ?'
  ).bind(channelId).all<{ user_id: string }>();

  // Collect attachment R2 keys before the rows are gone so the objects can
  // be deleted too instead of orphaning them in the bucket.
  const attachmentKeys = await env.DB.prepare(
    'SELECT r2_key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)'
  ).bind(channelId).all<{ r2_key: string }>();

  // Tell connected clients first, then close their sockets so nothing stays
  // attached to a room whose data is about to disappear.
  const channelDeletedEvent = { type: 'channel_deleted', channelId };
  const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(channelId));
  await publishChannelEvent(env, undefined, channelId, channelDeletedEvent).catch(() => {});

  // Cascade delete all related data (order matters for FK constraints)
  await env.DB.batch([
    // Tables referencing messages (must delete before messages)
    env.DB.prepare('DELETE FROM processes WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').bind(channelId),
    env.DB.prepare('DELETE FROM message_mentions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').bind(channelId),
    env.DB.prepare('DELETE FROM message_link_previews WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').bind(channelId),
    env.DB.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)').bind(channelId),
    env.DB.prepare('DELETE FROM draft_attachments WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').bind(channelId),
  ]);

  // Delete messages in chunks: each row fires FTS triggers, and one giant
  // DELETE on a big channel can blow past D1 statement limits.
  for (;;) {
    const res = await env.DB.prepare(
      'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE channel_id = ? LIMIT 500)'
    ).bind(channelId).run();
    if ((res.meta.changes ?? 0) < 500) break;
  }

  await env.DB.batch([
    // Tables referencing channels
    env.DB.prepare('DELETE FROM channel_members WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channel_reads WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM drafts WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channel_widgets WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channel_folder_items WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM kanban_activity WHERE card_id IN (SELECT id FROM kanban_cards WHERE board_id IN (SELECT id FROM kanban_boards WHERE channel_id = ?))').bind(channelId),
    env.DB.prepare('DELETE FROM kanban_cards WHERE board_id IN (SELECT id FROM kanban_boards WHERE channel_id = ?)').bind(channelId),
    env.DB.prepare('DELETE FROM kanban_boards WHERE channel_id = ?').bind(channelId),
    env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channelId),
  ]);

  // Remove the uploaded objects (R2 bulk delete takes up to 1000 keys)
  const keys = attachmentKeys.results.map((r) => r.r2_key);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.UPLOADS.delete(keys.slice(i, i + 1000)).catch(() => {});
  }

  await room.closeAllConnections().catch(() => {});

  // Notify all former members over their presence sockets (one DO hop) instead
  // of N per-member membership queries fanning out through other channels.
  notifyUsersViaPresence(env, members.results.map((m) => m.user_id), channelDeletedEvent);

  return jsonResponse({ ok: true });
}

export async function handleUpdateChannelNotifications(req: Request, env: Env, user: User, channelId: string): Promise<Response> {
  const body = await readJsonObject<{ tier?: string }>(req);
  if (!body.tier || !['all', 'mentions', 'none'].includes(body.tier)) {
    return errorResponse('tier must be one of: all, mentions, none', 400);
  }
  const member = await env.DB.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL').bind(channelId, user.id).first();
  if (!member) return errorResponse('Not a member of this channel', 404);
  await env.DB.prepare('UPDATE channel_members SET notifications = ? WHERE channel_id = ? AND user_id = ?').bind(body.tier, channelId, user.id).run();
  // TODO: broadcast tier change via WS for multi-tab sync (v2)
  return jsonResponse({ ok: true, tier: body.tier });
}

export async function handleRemoveMember(env: Env, user: User, channelId: string, targetUserId: string, ctx?: ExecutionContext): Promise<Response> {
  // Check channel exists
  const channel = await env.DB.prepare('SELECT is_private FROM channels WHERE id = ?')
    .bind(channelId).first<{ is_private: number }>();
  if (!channel) return errorResponse('Channel not found', 404);

  // Check caller is a member
  const callerMembership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, user.id).first();
  if (!callerMembership) return errorResponse('Not a member of this channel', 403);

  // Non-admin members can only remove themselves
  if (targetUserId !== user.id && !user.is_admin) {
    return errorResponse('You can only remove yourself', 403);
  }

  const targetRole = await env.DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(targetUserId).first<{ role: string | null }>();

  await env.DB.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .bind(channelId, targetUserId).run();

  // Invariant: if this user was the auto-respond bot for this channel, clear it.
  await env.DB.prepare(
    'UPDATE channels SET auto_respond_bot_id = NULL WHERE id = ? AND auto_respond_bot_id = ?'
  ).bind(channelId, targetUserId).run();

  const memberRemovedEvent = {
    type: 'member_removed',
    channelId,
    targetUserId,
  };

  // Notify remaining members in the channel and the removed user's still-open
  // channel socket, then forcibly close the removed user's socket in this room.
  const channelRoomId = env.CHAT_ROOM.idFromName(channelId);
  const channelRoom = env.CHAT_ROOM.get(channelRoomId);
  await publishChannelEvent(env, ctx, channelId, memberRemovedEvent, {
    webhooks: {
      senderId: user.id,
      senderRole: user.role,
      extraBotRecipientIds: targetRole?.role === 'bot' ? [targetUserId] : undefined,
    },
  });
  channelRoom.disconnectUser(targetUserId, 'Removed from channel').catch(() => {});

  // Also notify the removed user via any other channels they are still in so
  // clients/bots can update sidebars/caches even after their old socket closes.
  const otherChannels = await env.DB.prepare(`
    SELECT cm.channel_id FROM channel_members cm
    WHERE cm.user_id = ? AND cm.channel_id != ? AND cm.left_at IS NULL
  `).bind(targetUserId, channelId).all<{ channel_id: string }>();

  for (const row of otherChannels.results) {
    const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(row.channel_id));
    room.sendToUser(targetUserId, memberRemovedEvent).catch(() => {});
  }

  return jsonResponse({ ok: true });
}
