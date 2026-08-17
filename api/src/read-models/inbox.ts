import type { Env } from '../types.js';
import { clampLimit, MESSAGE_SELECT_COLS, parseMessageRow } from './messages.js';

export interface InboxPage {
  messages: any[];
  total: number;
  cursor: string | null;
}

const INBOX_MESSAGE_SELECT_COLS = MESSAGE_SELECT_COLS.replace(
  'SELECT m.*,',
  `SELECT m.*,
      c.name as channel_name,
      c.is_dm as is_dm,
      partner.id as dm_partner_id,
      partner.username as dm_partner_username,
      partner.display_name as dm_partner_display_name,`,
);

/**
 * Canonical cross-channel unread projection.
 *
 * Eligible messages are incoming, user-visible messages (human or final agent
 * response) that pass the conversation's notification tier. Thread replies use
 * exactly the same rule as top-level messages. A channel cursor provides the
 * bulk-read watermark; message_reads contains sparse acknowledgements above it.
 */
export class InboxReadModel {
  constructor(private readonly env: Env) {}

  async list(userId: string, options: { cursor?: string | null; limit?: number } = {}): Promise<InboxPage> {
    const limit = clampLimit(options.limit);
    const cursorClause = options.cursor ? 'AND m.id < ?' : '';
    const cursorParams = options.cursor ? [options.cursor] : [];

    const unreadWhere = `
      cm.user_id = ?
      AND cm.left_at IS NULL
      AND c.archived_at IS NULL
      AND (c.is_dm = 0 OR cm.hidden_at IS NULL)
      AND m.deleted_at IS NULL
      AND m.user_id != cm.user_id
      AND m.message_type IN ('human', 'response')
      AND (cr.last_read_message_id IS NULL OR m.id > cr.last_read_message_id)
      AND NOT EXISTS (
        SELECT 1 FROM message_reads mr
        WHERE mr.user_id = cm.user_id AND mr.message_id = m.id
      )
      AND (
        cm.notifications = 'all'
        OR (
          cm.notifications = 'mentions'
          AND EXISTS (
            SELECT 1 FROM message_mentions mm
            WHERE mm.message_id = m.id AND mm.user_id = cm.user_id
          )
        )
      )`;

    const rows = await this.env.DB.prepare(`${INBOX_MESSAGE_SELECT_COLS}
      JOIN channels c ON c.id = m.channel_id
      JOIN channel_members cm ON cm.channel_id = c.id
      LEFT JOIN channel_members partner_cm
        ON c.is_dm = 1
        AND partner_cm.channel_id = c.id
        AND partner_cm.user_id != ?
        AND partner_cm.left_at IS NULL
      LEFT JOIN users partner ON partner.id = partner_cm.user_id
      LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
      WHERE ${unreadWhere}
      ${cursorClause}
      ORDER BY m.id DESC
      LIMIT ?
    `).bind(userId, userId, userId, ...cursorParams, limit).all<any>();

    const total = await this.env.DB.prepare(`
      SELECT COUNT(*) as count
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
      JOIN channel_members cm ON cm.channel_id = c.id
      LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
      WHERE ${unreadWhere}
    `).bind(userId, userId).first<{ count: number }>();

    const messages = rows.results.map(parseMessageRow);
    return {
      messages,
      total: Number(total?.count ?? 0),
      cursor: messages.length === limit ? messages[messages.length - 1]?.id ?? null : null,
    };
  }
}
