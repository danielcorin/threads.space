import type { BackgroundTaskContext, Env, User } from '../types.js';
import { generateId } from '../utils.js';
import { ensureChannelMembership } from '../middleware.js';
import { unfurlMessageLinks } from '../routes/link-previews.js';
import { sendPushNotifications } from '../routes/push-send.js';
import { updateCircuitBreaker } from '../lib/circuit-breaker.js';
import { MessageReadModel } from '../read-models/messages.js';
import { botDmDisabledReason } from '../routes/dms.js';
import { publishChannelEvent } from '../lib/channel-events.js';
import { handleFeedbackMessage, type FeedbackImageAttachment } from '../lib/feedback.js';
import {
  FEEDBACK_BOT_DISPLAY_NAME,
  FEEDBACK_BOT_ID,
  FEEDBACK_BOT_NAME_COLOR,
  FEEDBACK_CHANNEL_ID,
} from '../constants.js';
import {
  byteSizeBucket,
  contentLengthBucket,
  recordMessageSent,
  type MessageType,
} from '../lib/message-analytics.js';
import { logAppEvent } from '../lib/observability.js';

const MESSAGE_TYPES = ['human', 'response', 'progress', 'tool_output', 'thinking'] as const;

function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Extract unique @usernames from message content. */
export function parseMentions(content: string): string[] {
  const matches = content.match(/@([a-zA-Z0-9_-]+)/g);
  if (!matches) return [];
  const usernames = matches.map((match) => match.slice(1));
  return [...new Set(usernames)];
}

export function shouldSendPushForMessage(input: {
  messageType: string;
  senderRole?: string | null;
  threadId?: string | null;
}): boolean {
  if (!['human', 'response'].includes(input.messageType)) return false;
  if (input.senderRole === 'bot' && input.messageType !== 'response') return false;
  if (input.senderRole === 'bot' && input.threadId) return false;
  return true;
}

export interface CreateMessageCommand {
  actor: User;
  channelId: string;
  content: string;
  threadId?: string | null;
  attachmentIds?: string[];
  metadata?: Record<string, unknown>;
  messageType?: unknown;
  idempotencyKey?: string;
}

export interface CreateMessageResult {
  outcome: 'created' | 'existing';
  message: ({ id: string } & Record<string, unknown>) | null;
}

interface AttachmentRecord {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
}

/** Expected, caller-visible rejection shared by HTTP, WebSocket, and cron adapters. */
export class MessageCreationError extends Error {
  constructor(
    readonly status: 400 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'MessageCreationError';
  }
}

async function postFeedbackAcknowledgement(
  env: Env,
  ctx: BackgroundTaskContext | undefined,
  content: string,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(
    "INSERT INTO messages (id, channel_id, user_id, content, message_type) VALUES (?, ?, ?, ?, 'response')",
  ).bind(id, FEEDBACK_CHANNEL_ID, FEEDBACK_BOT_ID, content).run();

  await publishChannelEvent(env, ctx, FEEDBACK_CHANNEL_ID, {
    type: 'message',
    id,
    channelId: FEEDBACK_CHANNEL_ID,
    userId: FEEDBACK_BOT_ID,
    username: FEEDBACK_BOT_ID,
    displayName: FEEDBACK_BOT_DISPLAY_NAME,
    nameColor: FEEDBACK_BOT_NAME_COLOR,
    userRole: 'bot',
    content,
    threadId: null,
    createdAt: Math.floor(Date.now() / 1000),
    mentions: [],
    attachments: [],
    metadata: null,
    messageType: 'response',
    autoRespondBotId: null,
    processingMode: 'immediate',
  }, { webhooks: {} });
}

/**
 * Authoritative message creation operation shared by every inbound adapter.
 * Transport parsing and response serialization stay outside this interface.
 */
export async function createMessage(
  env: Env,
  command: CreateMessageCommand,
  ctx?: BackgroundTaskContext,
): Promise<CreateMessageResult> {
  const {
    actor,
    channelId,
    content,
    threadId,
    attachmentIds,
    metadata,
    messageType: requestedMessageType,
    idempotencyKey,
  } = command;

  if (!await ensureChannelMembership(env, actor.id, channelId)) {
    throw new MessageCreationError(403, 'Not a member of this channel');
  }

  const hasAttachments = attachmentIds && attachmentIds.length > 0;
  // Typed as string, but both callers take it from client input (an HTTP body
  // and a WebSocket frame), so at runtime it is whatever was sent. A non-string
  // used to die on .trim() below and surface as a 500. This is the choke point
  // for both transports, so one check covers them.
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new MessageCreationError(400, 'Message content must be a string');
  }
  if (!content?.trim() && !hasAttachments) {
    throw new MessageCreationError(400, 'Message content required');
  }

  // Idempotent retries: a client that re-sends after a network failure passes
  // the same key and gets the already-created message back instead of a dupe.
  const idemKey = typeof idempotencyKey === 'string' && idempotencyKey
    ? idempotencyKey.slice(0, 128)
    : null;
  const findExisting = () => env.DB.prepare(
    'SELECT id FROM messages WHERE channel_id = ? AND user_id = ? AND idempotency_key = ?',
  ).bind(channelId, actor.id, idemKey).first<{ id: string }>();
  if (idemKey) {
    const existing = await findExisting();
    if (existing) {
      const readModel = new MessageReadModel(env);
      return { outcome: 'existing', message: await readModel.getMessage(existing.id) };
    }
  }

  const id = generateId();
  const trimmedContent = content?.trim() ?? '';
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  const messageType = isMessageType(requestedMessageType) ? requestedMessageType : 'human';

  // Look up channel settings for broadcast metadata and DM send permissions.
  const channel = await env.DB.prepare(
    'SELECT processing_mode, is_dm, is_private, is_ephemeral, auto_respond_bot_id FROM channels WHERE id = ?',
  ).bind(channelId).first<{
    processing_mode: string;
    is_dm: number;
    is_private: number;
    is_ephemeral: number;
    auto_respond_bot_id: string | null;
  }>();

  if (channel?.is_dm) {
    const botMember = await env.DB.prepare(`
      SELECT u.id, u.username, u.role, u.bot_capabilities_json
      FROM users u
      JOIN channel_members cm ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND u.role = 'bot' AND cm.left_at IS NULL
      LIMIT 1
    `).bind(channelId).first<Pick<User, 'id' | 'username' | 'role' | 'bot_capabilities_json'>>();
    if (botMember) {
      const disabledReason = botDmDisabledReason(actor, botMember);
      if (disabledReason) throw new MessageCreationError(403, disabledReason);
    }
  }

  // Collect everything first, then write atomically in one batch: a failure
  // halfway through must not leave a half-created message that a client retry
  // would duplicate.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO messages (id, channel_id, user_id, content, thread_id, metadata, message_type, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, channelId, actor.id, trimmedContent, threadId ?? null, metadataJson, messageType, idemKey),
  ];

  // Clear hidden_at for all members of this DM so it resurfaces in their sidebar.
  if (channel?.is_dm) {
    statements.push(env.DB.prepare(
      'UPDATE channel_members SET hidden_at = NULL WHERE channel_id = ? AND hidden_at IS NOT NULL',
    ).bind(channelId));
  }

  // Link only unattached files uploaded by the sender.
  const attachments: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    url: string;
  }[] = [];
  const feedbackImages: FeedbackImageAttachment[] = [];
  if (hasAttachments) {
    for (const attachmentId of attachmentIds) {
      const attachment = await env.DB.prepare(
        'SELECT * FROM attachments WHERE id = ? AND message_id IS NULL AND r2_key LIKE ?',
      ).bind(attachmentId, `${actor.id}/%`).first<AttachmentRecord>();
      if (!attachment) continue;

      statements.push(env.DB.prepare(
        'UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL',
      ).bind(id, attachmentId));
      attachments.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        sizeBytes: attachment.size_bytes,
        url: `/uploads/${attachment.r2_key}`,
      });
      if (String(attachment.content_type).toLowerCase().startsWith('image/')) {
        feedbackImages.push({
          filename: attachment.filename,
          contentType: attachment.content_type,
          sizeBytes: attachment.size_bytes,
          r2Key: attachment.r2_key,
        });
      }
    }
  }

  const mentionedUsernames = parseMentions(trimmedContent);
  const mentions: { userId: string; username: string }[] = [];
  if (mentionedUsernames.length > 0) {
    const placeholders = mentionedUsernames.map(() => '?').join(',');
    const users = await env.DB.prepare(
      `SELECT id, username FROM users WHERE username IN (${placeholders})`,
    ).bind(...mentionedUsernames).all<{ id: string; username: string }>();

    for (const user of users.results) {
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO message_mentions (message_id, user_id, username) VALUES (?, ?, ?)',
      ).bind(id, user.id, user.username));
      mentions.push({ userId: user.id, username: user.username });
    }
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A concurrent retry with the same idempotency key may have won the race.
    if (idemKey) {
      const existing = await findExisting();
      if (existing) {
        const readModel = new MessageReadModel(env);
        return { outcome: 'existing', message: await readModel.getMessage(existing.id) };
      }
    }
    throw error;
  }

  const analytics = recordMessageSent(env, {
    userId: actor.id,
    actorRole: actor.role,
    messageType,
    channel,
    threadId: threadId ?? null,
    contentLength: trimmedContent.length,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
  });
  if (ctx) ctx.waitUntil(analytics);
  else await analytics;
  logAppEvent(env, 'threads.message.sent', {
    outcome: 'created',
    actor_id: actor.id,
    actor_role: actor.role || 'user',
    message_id: id,
    message_type: messageType,
    channel_id: channelId,
    channel_kind: channel?.is_dm
      ? 'dm'
      : channel?.is_ephemeral
        ? 'ephemeral'
        : channel?.is_private
          ? 'private'
          : 'public',
    placement: threadId ? 'thread_reply' : 'top_level',
    content_length_bucket: contentLengthBucket(trimmedContent.length),
    attachment_count: attachments.length,
    attachment_bytes_bucket: byteSizeBucket(
      attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
    ),
    mention_count: mentions.length,
    has_metadata: metadata !== undefined,
  });

  const message = {
    type: 'message',
    id,
    channelId,
    userId: actor.id,
    username: actor.username,
    displayName: actor.display_name,
    nameColor: actor.name_color,
    userRole: actor.role || 'user',
    content: trimmedContent,
    threadId: threadId ?? null,
    createdAt: Math.floor(Date.now() / 1000),
    mentions,
    attachments,
    metadata: metadata ?? null,
    messageType,
    autoRespondBotId: channel?.auto_respond_bot_id ?? null,
    processingMode: channel?.processing_mode || 'immediate',
  };

  // Circuit breaker state is updated before any event leaves the service.
  const breaker = await updateCircuitBreaker(env, channelId, messageType, threadId ?? null);
  if (breaker.newlyTripped) {
    await publishChannelEvent(env, ctx, channelId, {
      type: 'bot_loop_tripped',
      channelId,
      trippedAt: breaker.trippedAt,
    });
  }
  const botSender = actor.role === 'bot'
    ? { mentionedUserIds: [actor.id, ...mentions.map((mention) => mention.userId)] }
    : undefined;
  await publishChannelEvent(env, ctx, channelId, message, {
    realtime: {
      excludeRoles: breaker.trippedAt !== null ? ['bot'] : undefined,
      botSender,
    },
    webhooks: {
      senderId: actor.id,
      senderRole: actor.role,
      mentionedUserIds: botSender?.mentionedUserIds,
      breakerTripped: breaker.trippedAt !== null,
    },
  });

  if (ctx) {
    if (trimmedContent) {
      ctx.waitUntil(unfurlMessageLinks(env, id, channelId, trimmedContent));
    }
    if (shouldSendPushForMessage({
      messageType,
      senderRole: actor.role,
      threadId: threadId ?? null,
    })) {
      ctx.waitUntil(sendPushNotifications(env, {
        channelId,
        messageId: id,
        senderId: actor.id,
        senderName: actor.display_name || actor.username,
        content: trimmedContent,
        threadId: threadId ?? null,
        mentions,
        messageType,
      }).catch((error) => console.error('Push notification error:', error)));
    }
  }

  // Feedback is a distinct use case behind the same service: its acknowledgement
  // deliberately preserves the old reduced effects (persist + publish only).
  if (
    ctx
    && channelId === FEEDBACK_CHANNEL_ID
    && actor.role !== 'bot'
    && (trimmedContent || feedbackImages.length > 0)
    && !threadId
  ) {
    ctx.waitUntil(handleFeedbackMessage(
      env,
      actor.display_name || actor.username,
      trimmedContent,
      feedbackImages,
      (acknowledgement) => postFeedbackAcknowledgement(env, ctx, acknowledgement),
    ));
  }

  return { outcome: 'created', message };
}
