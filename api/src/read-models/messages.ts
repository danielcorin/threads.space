import type { Env } from '../types.js';

/** Safely parse a JSON string, returning fallback on failure. */
function safeJsonParse(value: string | null | undefined, fallback: any = []): any {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Split 'id:status' combined column back into thread_process_id and thread_process_status. */
function splitProcessCombined(combined: string | null | undefined): { thread_process_id: string | null; thread_process_status: string | null } {
  if (!combined) return { thread_process_id: null, thread_process_status: null };
  const sep = combined.indexOf(':');
  return { thread_process_id: combined.slice(0, sep), thread_process_status: combined.slice(sep + 1) };
}

/** Parse JSON aggregate columns and add camelCase aliases to match WebSocket broadcast format. */
export function parseMessageRow(m: any): any {
  const { thread_process_id, thread_process_status } = splitProcessCombined(m.thread_process_combined);
  return {
    ...m,
    // Add camelCase aliases (matching WebSocket event shape) while keeping snake_case for client compatibility
    userId: m.user_id,
    channelId: m.channel_id,
    threadId: m.thread_id,
    threadTitle: m.thread_title,
    threadTitleUpdatedAt: m.thread_title_updated_at,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    resolvedAt: m.resolved_at,
    resolvedBy: m.resolved_by,
    messageType: m.message_type,
    displayName: m.display_name,
    nameColor: m.name_color,
    avatarUrl: m.avatar_url,
    replyCount: m.reply_count,
    processId: m.process_id,
    processStatus: m.process_status,
    processInputTokens: m.process_input_tokens,
    processOutputTokens: m.process_output_tokens,
    processCacheCreationInputTokens: m.process_cache_creation_input_tokens,
    processCacheReadInputTokens: m.process_cache_read_input_tokens,
    processErrorText: m.process_error_text,
    reactions: safeJsonParse(m.reactions_json).filter((r: any) => r.emoji !== null),
    reactions_json: undefined,
    mentions: safeJsonParse(m.mentions_json).filter((mm: any) => mm.userId !== null),
    mentions_json: undefined,
    attachments: safeJsonParse(m.attachments_json).filter((a: any) => a.id !== null),
    attachments_json: undefined,
    linkPreviews: safeJsonParse(m.link_previews_json).filter((lp: any) => lp.url !== null),
    link_previews_json: undefined,
    metadata: safeJsonParse(m.metadata, null),
    ...(m.thread_process_combined !== undefined ? { thread_process_id, thread_process_status, thread_process_combined: undefined } : {}),
  };
}

/** Shared SELECT columns for message read queries. */
export const MESSAGE_SELECT_COLS = `
    SELECT m.*, u.username, u.display_name, u.name_color, u.avatar_url,
      (SELECT json_group_array(json_object('emoji', r.emoji, 'userId', r.user_id, 'username', ru.username))
       FROM reactions r JOIN users ru ON r.user_id = ru.id
       WHERE r.message_id = m.id) as reactions_json,
      (SELECT COUNT(*) FROM messages t WHERE t.thread_id = m.id AND t.deleted_at IS NULL) as reply_count,
      (SELECT json_group_array(json_object('userId', mm.user_id, 'username', mm.username))
       FROM message_mentions mm WHERE mm.message_id = m.id) as mentions_json,
      (SELECT json_group_array(json_object('id', a.id, 'filename', a.filename, 'contentType', a.content_type, 'sizeBytes', a.size_bytes, 'url', '/uploads/' || a.r2_key))
       FROM attachments a WHERE a.message_id = m.id) as attachments_json,
      (SELECT json_group_array(json_object('url', lp.url, 'urlHash', lp.url_hash, 'title', lp.title, 'description', lp.description, 'imageUrl', lp.image_url, 'siteName', lp.site_name))
       FROM message_link_previews mlp JOIN link_previews lp ON mlp.url_hash = lp.url_hash
       WHERE mlp.message_id = m.id) as link_previews_json,
      (SELECT p.id || ':' || CASE WHEN p.status = 'running' THEN 'processing' ELSE p.status END
       FROM processes p JOIN messages child ON p.message_id = child.id
       WHERE child.thread_id = m.id AND p.status IN ('running', 'queued')
       ORDER BY p.started_at DESC LIMIT 1) as thread_process_combined,
      CASE WHEN EXISTS (SELECT 1 FROM pinned_messages pm WHERE pm.message_id = m.id) THEN 1 ELSE 0 END as pinned
    FROM messages m
    LEFT JOIN users u ON m.user_id = u.id`;

const MESSAGE_WITH_CHANNEL_SELECT_COLS = MESSAGE_SELECT_COLS.replace(
  'SELECT m.*,',
  'SELECT m.*, c.name as channel_name, c.is_dm as is_dm,'
);

export interface MessagePage {
  messages: any[];
  cursor?: string | null;
  hasNewer?: boolean;
  afterCursor?: string | null;
}

/**
 * Clamp a caller-supplied page size to [1, 100]. SQLite treats a negative
 * LIMIT as unlimited and NaN binds blow up with a 500, so both must be
 * normalized, not just capped.
 */
export function clampLimit(limit: number | undefined | null): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 50;
  return Math.max(1, Math.min(n, 100));
}

export class MessageReadModel {
  constructor(private readonly env: Env) {}

  async listChannelMessages(channelId: string, options: { cursor?: string | null; around?: string | null; after?: string | null; limit?: number }): Promise<MessagePage> {
    const limit = clampLimit(options.limit);

    if (options.around) {
      return this.listChannelMessagesAround(channelId, options.around, limit);
    }

    if (options.after) {
      return this.listChannelMessagesAfter(channelId, options.after, limit);
    }

    let query = `${MESSAGE_SELECT_COLS}
      WHERE m.channel_id = ? AND m.thread_id IS NULL
    `;
    const params: any[] = [channelId];

    if (options.cursor) {
      query += ' AND m.id < ?';
      params.push(options.cursor);
    }

    query += ' AND (m.deleted_at IS NULL OR m.type = \'system\') ORDER BY m.id DESC LIMIT ?';
    params.push(limit);

    const messages = await this.env.DB.prepare(query).bind(...params).all<any>();
    const results = messages.results.map(parseMessageRow);

    return {
      messages: results.reverse(),
      cursor: results.length === limit ? results[0]?.id : null,
    };
  }

  async listThreadReplies(messageId: string, options: { cursor?: string | null; before?: string | null; around?: string | null; after?: string | null; latest?: boolean; limit?: number }): Promise<MessagePage> {
    const limit = clampLimit(options.limit);

    if (options.around) {
      return this.listThreadRepliesAround(messageId, options.around, limit);
    }

    if (options.after) {
      return this.listThreadRepliesAfter(messageId, options.after, limit);
    }

    let query = `${MESSAGE_SELECT_COLS}
      WHERE m.thread_id = ? AND m.deleted_at IS NULL
    `;
    const params: any[] = [messageId];

    if (options.latest || options.before) {
      if (options.before) {
        query += ' AND m.id < ?';
        params.push(options.before);
      }
      query += ' ORDER BY m.id DESC LIMIT ?';
      params.push(limit);
    } else {
      if (options.cursor) {
        query += ' AND m.id > ?';
        params.push(options.cursor);
      }
      query += ' ORDER BY m.id ASC LIMIT ?';
      params.push(limit);
    }

    const messages = await this.env.DB.prepare(query).bind(...params).all<any>();
    let results = messages.results.map(parseMessageRow);
    if (options.latest || options.before) results = results.reverse();

    return {
      messages: results,
      cursor: (options.latest || options.before)
        ? (results.length === limit ? results[0]?.id : null)
        : (results.length === limit ? results[results.length - 1]?.id : null),
    };
  }

  async getMessage(messageId: string): Promise<any | null> {
    const result = await this.env.DB.prepare(`${MESSAGE_WITH_CHANNEL_SELECT_COLS}
      LEFT JOIN channels c ON m.channel_id = c.id
      WHERE m.id = ? AND m.deleted_at IS NULL
    `).bind(messageId).first<any>();

    return result ? parseMessageRow(result) : null;
  }

  private async listThreadRepliesAround(messageId: string, around: string, limit: number): Promise<MessagePage> {
    const anchorExists = await this.env.DB.prepare(
      'SELECT id FROM messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL'
    ).bind(around, messageId).first();

    if (!anchorExists) {
      return this.listThreadReplies(messageId, { latest: true, limit });
    }

    const beforeLimit = Math.floor(limit / 2);
    const afterLimit = limit - beforeLimit;

    const beforeRows = beforeLimit > 0
      ? await this.env.DB.prepare(`${MESSAGE_SELECT_COLS}
          WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.id < ?
          ORDER BY m.id DESC LIMIT ?`).bind(messageId, around, beforeLimit + 1).all<any>()
      : { results: [] as any[] };
    const beforeRaw = beforeRows.results.map(parseMessageRow);
    const hasBefore = beforeRaw.length > beforeLimit;
    const beforeResults = beforeRaw.slice(0, beforeLimit).reverse();

    const afterRows = await this.env.DB.prepare(`${MESSAGE_SELECT_COLS}
      WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.id >= ?
      ORDER BY m.id ASC LIMIT ?`).bind(messageId, around, afterLimit + 1).all<any>();
    const afterRaw = afterRows.results.map(parseMessageRow);
    const hasAfter = afterRaw.length > afterLimit;
    const afterResults = afterRaw.slice(0, afterLimit);

    const combined = [...beforeResults, ...afterResults];

    return {
      messages: combined,
      cursor: hasBefore ? combined[0]?.id ?? null : null,
      hasNewer: hasAfter,
      afterCursor: hasAfter ? combined[combined.length - 1]?.id ?? null : null,
    };
  }

  private async listThreadRepliesAfter(messageId: string, after: string, limit: number): Promise<MessagePage> {
    const rows = await this.env.DB.prepare(`${MESSAGE_SELECT_COLS}
      WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.id > ?
      ORDER BY m.id ASC LIMIT ?`).bind(messageId, after, limit + 1).all<any>();
    const parsed = rows.results.map(parseMessageRow);
    const hasNewer = parsed.length > limit;
    const results = parsed.slice(0, limit);

    return {
      messages: results,
      afterCursor: hasNewer ? results[results.length - 1]?.id ?? null : null,
      hasNewer,
    };
  }

  private async listChannelMessagesAround(channelId: string, around: string, limit: number): Promise<MessagePage> {
    const anchorExists = await this.env.DB.prepare(
      'SELECT id FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL AND deleted_at IS NULL'
    ).bind(around, channelId).first();

    if (!anchorExists) {
      return this.listChannelMessages(channelId, { limit });
    }

    const half = Math.floor(limit / 2);

    const beforeQuery = `${MESSAGE_SELECT_COLS}
      WHERE m.channel_id = ? AND m.thread_id IS NULL
        AND (m.deleted_at IS NULL OR m.type = 'system')
        AND m.id < ?
      ORDER BY m.id DESC LIMIT ?`;
    const beforeRows = await this.env.DB.prepare(beforeQuery).bind(channelId, around, half).all<any>();

    const afterQuery = `${MESSAGE_SELECT_COLS}
      WHERE m.channel_id = ? AND m.thread_id IS NULL
        AND (m.deleted_at IS NULL OR m.type = 'system')
        AND m.id >= ?
      ORDER BY m.id ASC LIMIT ?`;
    const afterRows = await this.env.DB.prepare(afterQuery).bind(channelId, around, half).all<any>();

    const beforeResults = beforeRows.results.map(parseMessageRow).reverse();
    const afterResults = afterRows.results.map(parseMessageRow);
    const combined = [...beforeResults, ...afterResults];

    const hasBefore = beforeResults.length === half;
    const hasAfter = afterResults.length === half;

    return {
      messages: combined,
      cursor: hasBefore ? combined[0]?.id : null,
      hasNewer: hasAfter,
      afterCursor: hasAfter ? combined[combined.length - 1]?.id : null,
    };
  }

  private async listChannelMessagesAfter(channelId: string, after: string, limit: number): Promise<MessagePage> {
    const afterQuery = `${MESSAGE_SELECT_COLS}
      WHERE m.channel_id = ? AND m.thread_id IS NULL
        AND (m.deleted_at IS NULL OR m.type = 'system')
        AND m.id > ?
      ORDER BY m.id ASC LIMIT ?`;
    const afterRows = await this.env.DB.prepare(afterQuery).bind(channelId, after, limit).all<any>();
    const results = afterRows.results.map(parseMessageRow);

    return {
      messages: results,
      afterCursor: results.length === limit ? results[results.length - 1]?.id : null,
      hasNewer: results.length === limit,
    };
  }
}
