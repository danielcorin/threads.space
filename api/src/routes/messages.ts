import type { BackgroundTaskContext, Env, User, Message } from '../types.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { unfurlMessageLinks } from './link-previews.js';
import { MessageReadModel } from '../read-models/messages.js';
import { InboxReadModel } from '../read-models/inbox.js';
import { publishChannelEvent, type ChannelEvent } from '../lib/channel-events.js';
import {
  createMessage,
  MessageCreationError,
  parseMentions,
  type CreateMessageCommand,
} from '../services/messages.js';

export async function handleListMessages(env: Env, user: User, channelId: string, url: URL): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);
  const readModel = new MessageReadModel(env);
  return jsonResponse(await readModel.listChannelMessages(channelId, {
    cursor: url.searchParams.get('cursor'),
    around: url.searchParams.get('around'),
    after: url.searchParams.get('after'),
    limit: parseInt(url.searchParams.get('limit') ?? '50'),
  }));
}

export async function handleListInbox(env: Env, user: User, url: URL): Promise<Response> {
  const readModel = new InboxReadModel(env);
  return jsonResponse(await readModel.list(user.id, {
    cursor: url.searchParams.get('cursor'),
    limit: parseInt(url.searchParams.get('limit') ?? '50'),
  }));
}

export async function createMessageResponse(
  env: Env,
  user: User,
  command: Omit<CreateMessageCommand, 'actor'>,
  ctx?: BackgroundTaskContext,
): Promise<Response> {
  try {
    const result = await createMessage(env, { ...command, actor: user }, ctx);
    return jsonResponse(result.message, result.outcome === 'created' ? 201 : 200);
  } catch (error) {
    if (error instanceof MessageCreationError) {
      return errorResponse(error.message, error.status);
    }
    throw error;
  }
}

export async function handleSendMessage(
  request: Request,
  env: Env,
  user: User,
  channelId: string,
  ctx?: BackgroundTaskContext,
): Promise<Response> {
  const body = await readJsonObject<{
    content: string;
    threadId?: string;
    attachmentIds?: string[];
    metadata?: Record<string, unknown>;
    message_type?: string;
    idempotencyKey?: string;
  }>(request);
  return createMessageResponse(env, user, {
    channelId,
    content: body.content,
    threadId: body.threadId,
    attachmentIds: body.attachmentIds,
    metadata: body.metadata,
    messageType: body.message_type,
    idempotencyKey: body.idempotencyKey,
  }, ctx);
}

export async function handleEditMessage(request: Request, env: Env, user: User, messageId: string, ctx?: ExecutionContext): Promise<Response> {
  const { content } = await readJsonObject<{ content?: unknown }>(request);
  // Type-check before .trim(): a non-string here faulted rather than returning 400.
  if (typeof content !== 'string') return errorResponse('Content must be a string');
  if (!content.trim()) return errorResponse('Content required');

  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId).first<Message>();
  if (!msg) return errorResponse('Message not found', 404);
  if (msg.user_id !== user.id) return errorResponse('Forbidden', 403);

  const trimmedContent = content.trim();
  const editedAt = Math.floor(Date.now() / 1000);

  // Re-derive mentions and link previews from the new content: an edit that
  // adds/removes an @mention or a URL must not keep the old associations.
  const statements = [
    env.DB.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?')
      .bind(trimmedContent, editedAt, messageId),
    env.DB.prepare('DELETE FROM message_mentions WHERE message_id = ?').bind(messageId),
    env.DB.prepare('DELETE FROM message_link_previews WHERE message_id = ?').bind(messageId),
  ];
  const mentionedUsernames = parseMentions(trimmedContent);
  if (mentionedUsernames.length > 0) {
    const placeholders = mentionedUsernames.map(() => '?').join(',');
    const users = await env.DB.prepare(
      `SELECT id, username FROM users WHERE username IN (${placeholders})`
    ).bind(...mentionedUsernames).all<{ id: string; username: string }>();
    for (const u of users.results) {
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO message_mentions (message_id, user_id, username) VALUES (?, ?, ?)'
      ).bind(messageId, u.id, u.username));
    }
  }
  await env.DB.batch(statements);

  // Broadcast edit
  await publishChannelEvent(env, ctx, msg.channel_id, {
    type: 'message_edited',
    id: messageId,
    content: trimmedContent,
    editedAt,
  });

  if (ctx) {
    ctx.waitUntil(unfurlMessageLinks(env, messageId, msg.channel_id, trimmedContent));
  }

  return jsonResponse({ ok: true });
}

export async function handleDeleteMessage(env: Env, user: User, messageId: string): Promise<Response> {
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId).first<Message>();
  if (!msg) return errorResponse('Message not found', 404);
  if (msg.user_id !== user.id) return errorResponse('Forbidden', 403);

  await env.DB.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), messageId).run();

  // Broadcast delete
  await publishChannelEvent(env, undefined, msg.channel_id, {
    type: 'message_deleted',
    id: messageId,
    threadId: msg.thread_id,
  });

  return jsonResponse({ ok: true });
}

// Mark a top-level message resolved: it dims in place instead of being deleted,
// so a thread the author is finished with reads differently from one still needing
// work. Any channel member may resolve (matching pins), which also lets a bot do it
// on a user's behalf via an API token. resolved_at doubles as the boolean flag.
export async function handleResolveMessage(env: Env, user: User, messageId: string): Promise<Response> {
  const msg = await env.DB.prepare('SELECT id, channel_id, thread_id FROM messages WHERE id = ? AND deleted_at IS NULL')
    .bind(messageId).first<{ id: string; channel_id: string; thread_id: string | null }>();
  if (!msg) return errorResponse('Message not found', 404);
  if (msg.thread_id !== null) return errorResponse('Only top-level messages can be resolved', 400);
  await requireChannelMembership(env, user.id, msg.channel_id);

  const resolvedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE messages SET resolved_at = ?, resolved_by = ? WHERE id = ?')
    .bind(resolvedAt, user.id, messageId).run();

  await publishChannelEvent(env, undefined, msg.channel_id, {
    type: 'message_resolved',
    id: messageId,
    channelId: msg.channel_id,
    resolvedBy: user.id,
    resolvedAt,
  });

  return jsonResponse({ ok: true, resolved_at: resolvedAt, resolved_by: user.id });
}

export async function handleUnresolveMessage(env: Env, user: User, messageId: string): Promise<Response> {
  const msg = await env.DB.prepare('SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL')
    .bind(messageId).first<{ id: string; channel_id: string }>();
  if (!msg) return errorResponse('Message not found', 404);
  await requireChannelMembership(env, user.id, msg.channel_id);

  await env.DB.prepare('UPDATE messages SET resolved_at = NULL, resolved_by = NULL WHERE id = ?')
    .bind(messageId).run();

  await publishChannelEvent(env, undefined, msg.channel_id, {
    type: 'message_unresolved',
    id: messageId,
    channelId: msg.channel_id,
  });

  return jsonResponse({ ok: true });
}

/**
 * Set or rename a thread's human-readable title. Accept either a root or reply
 * id and normalize to the stable root message, matching the thread reply APIs.
 * Titles are display metadata, not unique slugs: preserve case and punctuation.
 */
export async function handleSetThreadTitle(request: Request, env: Env, user: User, messageId: string): Promise<Response> {
  const body = await readJsonObject<{ title?: unknown; if_unset?: unknown }>(request)
    .catch((): { title?: unknown; if_unset?: unknown } => ({}));
  if (typeof body.title !== 'string') return errorResponse('title required');
  if (body.if_unset !== undefined && typeof body.if_unset !== 'boolean') {
    return errorResponse('if_unset must be a boolean');
  }

  const title = body.title.trim().replace(/\s+/g, ' ');
  if (!title) return errorResponse('title required');
  if (Array.from(title).length > 120) return errorResponse('title must be 120 characters or fewer');

  const target = await env.DB.prepare(`
    SELECT root.id as thread_id, root.channel_id
    FROM messages target
    JOIN messages root ON root.id = COALESCE(target.thread_id, target.id)
    WHERE target.id = ?
      AND target.deleted_at IS NULL
      AND root.thread_id IS NULL
      AND root.deleted_at IS NULL
  `).bind(messageId).first<{ thread_id: string; channel_id: string }>();
  if (!target) return errorResponse('Thread not found', 404);

  const threadId = target.thread_id;
  await requireChannelMembership(env, user.id, target.channel_id);

  const updatedAt = Math.floor(Date.now() / 1000);
  const write = await env.DB.prepare(`
    UPDATE messages
    SET thread_title = ?, thread_title_updated_at = ?
    WHERE id = ?
      AND thread_id IS NULL
      AND deleted_at IS NULL
      AND (thread_title IS NULL OR thread_title <> ?)
      AND (? = 0 OR thread_title IS NULL)
  `).bind(title, updatedAt, threadId, title, body.if_unset === true ? 1 : 0).run();

  if ((write.meta.changes ?? 0) === 0) {
    const current = await env.DB.prepare(`
      SELECT thread_title, thread_title_updated_at
      FROM messages
      WHERE id = ? AND thread_id IS NULL AND deleted_at IS NULL
    `).bind(threadId).first<{ thread_title: string | null; thread_title_updated_at: number | null }>();
    if (!current) return errorResponse('Thread not found', 404);
    if (current.thread_title === null || current.thread_title_updated_at === null) {
      return errorResponse('Thread title update conflicted', 409);
    }
    return jsonResponse({
      ok: true,
      applied: false,
      thread_id: threadId,
      thread_title: current.thread_title,
      thread_title_updated_at: current.thread_title_updated_at,
    });
  }

  await publishChannelEvent(env, undefined, target.channel_id, {
    type: 'thread_title_updated',
    channelId: target.channel_id,
    threadId,
    title,
    updatedAt,
  });

  return jsonResponse({
    ok: true,
    applied: true,
    thread_id: threadId,
    thread_title: title,
    thread_title_updated_at: updatedAt,
  });
}

export async function handleGetThreadReplies(env: Env, user: User, messageId: string, url: URL): Promise<Response> {
  // Accept either a root or reply id, matching the reply-write endpoint. Keep
  // normalization here so every caller gets one stable thread interface.
  const parentMsg = await env.DB.prepare('SELECT channel_id, thread_id FROM messages WHERE id = ?')
    .bind(messageId).first<{ channel_id: string; thread_id: string | null }>();
  if (!parentMsg) return errorResponse('Thread not found', 404);
  await requireChannelMembership(env, user.id, parentMsg.channel_id);

  const readModel = new MessageReadModel(env);
  return jsonResponse(await readModel.listThreadReplies(parentMsg.thread_id || messageId, {
    cursor: url.searchParams.get('cursor'),
    before: url.searchParams.get('before'),
    around: url.searchParams.get('around'),
    after: url.searchParams.get('after'),
    latest: url.searchParams.get('latest') === 'true',
    limit: parseInt(url.searchParams.get('limit') ?? '50'),
  }));
}

export async function handleGetMentions(env: Env, user: User): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT m.*, u.username, u.display_name, u.name_color, u.avatar_url
    FROM message_mentions mm
    JOIN messages m ON mm.message_id = m.id
    JOIN users u ON m.user_id = u.id
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ? AND cm.left_at IS NULL
    WHERE mm.user_id = ? AND m.deleted_at IS NULL
    ORDER BY m.id DESC
    LIMIT 50
  `).bind(user.id, user.id).all<any>();

  return jsonResponse({ messages: result.results });
}

export async function handleGetMessage(env: Env, user: User, messageId: string): Promise<Response> {
  const readModel = new MessageReadModel(env);
  const message = await readModel.getMessage(messageId);
  if (!message) return errorResponse('Message not found', 404);

  await requireChannelMembership(env, user.id, message.channel_id);

  return jsonResponse(message);
}

export async function handleUpdateProcessStatus(request: Request, env: Env, user: User, messageId: string): Promise<Response> {
  const { processId, status, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, error_text } = await readJsonObject<{ processId: string; status: string; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; error_text?: string | null }>(request);
  if (!processId) return errorResponse('processId required');
  if (!['queued', 'processing', 'running', 'done', 'error', 'killed', 'restarted'].includes(status)) {
    return errorResponse('Invalid status. Must be: queued, processing, running, done, error, killed, restarted');
  }
  const visibleStatus = status === 'running' ? 'processing' : status;

  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId).first<Message>();
  if (!msg) return errorResponse('Message not found', 404);

  // Cap error text to keep rows small and avoid blowing out the broadcast frame.
  const capped_error_text = typeof error_text === 'string' && error_text.length > 0
    ? error_text.slice(0, 4000)
    : null;

  await env.DB.prepare('UPDATE messages SET process_id = ?, process_status = ?, process_input_tokens = ?, process_output_tokens = ?, process_cache_creation_input_tokens = ?, process_cache_read_input_tokens = ?, process_error_text = ? WHERE id = ?')
    .bind(processId, visibleStatus, input_tokens ?? 0, output_tokens ?? 0, cache_creation_input_tokens ?? 0, cache_read_input_tokens ?? 0, capped_error_text, messageId).run();

  // Broadcast process_status event via Durable Object
  const broadcastData: ChannelEvent = { type: 'process_status', channelId: msg.channel_id, messageId, processId, status: visibleStatus, threadId: msg.thread_id || null };
  if (input_tokens !== undefined) broadcastData.input_tokens = input_tokens;
  if (output_tokens !== undefined) broadcastData.output_tokens = output_tokens;
  if (cache_creation_input_tokens !== undefined) broadcastData.cache_creation_input_tokens = cache_creation_input_tokens;
  if (cache_read_input_tokens !== undefined) broadcastData.cache_read_input_tokens = cache_read_input_tokens;
  if (capped_error_text !== null) broadcastData.error_text = capped_error_text;
  await publishChannelEvent(env, undefined, msg.channel_id, broadcastData);

  return jsonResponse({ ok: true });
}

/** Retry processing of a message whose previous run errored, was killed, or ended by restart.
 *  Resets process_status to 'queued', clears process_error_text, broadcasts
 *  both process_status (so UI updates immediately) and process_retry (so the
 *  daemon picks up the retry signal). Caller must be a member of the channel. */
export async function handleRetryMessage(env: Env, user: User, messageId: string): Promise<Response> {
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId).first<Message>();
  if (!msg) return errorResponse('Message not found', 404);

  await requireChannelMembership(env, user.id, msg.channel_id);

  // Only allow retry from terminal failure states. Reprocessing a 'done' or
  // currently-running message would create duplicate work and confused UI.
  const currentStatus = (msg as any).process_status as string | null;
  if (currentStatus !== 'error' && currentStatus !== 'killed' && currentStatus !== 'restarted') {
    return errorResponse(`Cannot retry message with process_status=${currentStatus ?? 'null'} (must be error, killed, or restarted)`, 400);
  }

  const processId = (msg as any).process_id as string | null;
  if (!processId) return errorResponse('Message has no associated process', 400);

  // Reset to queued and clear the error text so the popover collapses to the
  // pending state. Token counters left intact for cumulative cost accounting.
  await env.DB.prepare(
    'UPDATE messages SET process_status = ?, process_error_text = ? WHERE id = ?'
  ).bind('queued', null, messageId).run();

  // Update UI for all connected clients first.
  await publishChannelEvent(env, undefined, msg.channel_id, {
    type: 'process_status',
    channelId: msg.channel_id,
    messageId,
    processId,
    status: 'queued',
    threadId: msg.thread_id || null,
    error_text: null,
  });
  // Then signal the daemon to actually re-run.
  await publishChannelEvent(env, undefined, msg.channel_id, {
    type: 'process_retry',
    channelId: msg.channel_id,
    messageId,
    processId,
    threadId: msg.thread_id || null,
  });

  return jsonResponse({ ok: true });
}

export async function handleMarkRead(env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);
  const latest = await env.DB.prepare(
    'SELECT MAX(id) as id FROM messages WHERE channel_id = ? AND deleted_at IS NULL'
  ).bind(channelId).first<{ id: string | null }>();

  if (latest?.id) {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO channel_reads (user_id, channel_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, channel_id)
        DO UPDATE SET last_read_message_id = excluded.last_read_message_id
      `).bind(user.id, channelId, latest.id),
      env.DB.prepare(`
        DELETE FROM message_reads
        WHERE user_id = ?
          AND message_id IN (
            SELECT id FROM messages WHERE channel_id = ? AND id <= ?
          )
      `).bind(user.id, channelId, latest.id),
    ]);
  }

  return jsonResponse({ ok: true });
}

export async function handleMarkMessageRead(env: Env, user: User, messageId: string): Promise<Response> {
  const message = await env.DB.prepare(
    'SELECT channel_id FROM messages WHERE id = ? AND deleted_at IS NULL',
  ).bind(messageId).first<{ channel_id: string }>();
  if (!message) return errorResponse('Message not found', 404);

  await requireChannelMembership(env, user.id, message.channel_id);
  await env.DB.prepare(`
    INSERT INTO message_reads (user_id, message_id, read_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id, message_id)
    DO UPDATE SET read_at = excluded.read_at
  `).bind(user.id, messageId).run();

  return jsonResponse({ ok: true });
}
