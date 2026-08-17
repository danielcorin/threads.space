import type { Env, User } from '../types.js';

/** Convert SQLite datetime (YYYY-MM-DD HH:MM:SS) to ISO 8601 (with T and Z). Already-ISO strings pass through unchanged. */
export function normalizeDatetime(dt: string | null | undefined): string | null | undefined {
  if (!dt) return dt;
  if (dt.includes('T')) return dt;
  return dt.replace(' ', 'T') + 'Z';
}

// Processes are never killed by pid (there is no OS process). A run that never reports a
// terminal status — because its agent crashed or lost connectivity — is swept to `killed`
// purely on age, so the management page doesn't accumulate zombie "running" rows.
const STALE_PROCESS_AGE = '-24 hours';

export interface ProcessListOptions {
  status?: string | null;
}

export class ProcessReadModel {
  constructor(private readonly env: Env) {}

  async cleanupOldProcesses(): Promise<void> {
    const now = new Date().toISOString();

    await this.env.DB.prepare(
      `UPDATE messages
       SET process_status = 'killed'
       WHERE process_status IN ('running', 'queued')
         AND process_id IN (
           SELECT id FROM processes
           WHERE status IN ('running', 'queued')
             AND datetime(replace(replace(started_at, 'T', ' '), 'Z', '')) < datetime('now', ?)
         )`
    ).bind(STALE_PROCESS_AGE).run();

    await this.env.DB.prepare(
      `UPDATE processes
       SET status = 'killed', ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE status IN ('running', 'queued')
         AND datetime(replace(replace(started_at, 'T', ' '), 'Z', '')) < datetime('now', ?)`
    ).bind(now, now, STALE_PROCESS_AGE).run();

    await this.env.DB.prepare(
      `DELETE FROM processes
       WHERE status NOT IN ('running', 'queued')
         AND ended_at IS NOT NULL
         AND datetime(replace(replace(ended_at, 'T', ' '), 'Z', '')) < datetime('now', ?)`
    ).bind(STALE_PROCESS_AGE).run();
  }

  async listProcesses(user: User, options: ProcessListOptions = {}): Promise<any[]> {
    await this.cleanupOldProcesses();

    const visibilityJoin = user.is_admin
      ? ''
      : 'INNER JOIN channel_members cm ON cm.channel_id = p.channel_id AND cm.user_id = ? AND cm.left_at IS NULL';

    let query = `
      SELECT p.*, m.thread_id,
        COALESCE(thread_root.resolved_at, m.resolved_at, (
          SELECT linked.resolved_at
          FROM messages linked
          WHERE linked.channel_id = p.channel_id
            AND linked.thread_id IS NULL
            AND linked.deleted_at IS NULL
            AND linked.resolved_at IS NOT NULL
            AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = p.message_id
          ORDER BY linked.resolved_at DESC
          LIMIT 1
        )) as resolved_at,
        COALESCE(thread_root.resolved_by, m.resolved_by, (
          SELECT linked.resolved_by
          FROM messages linked
          WHERE linked.channel_id = p.channel_id
            AND linked.thread_id IS NULL
            AND linked.deleted_at IS NULL
            AND linked.resolved_at IS NOT NULL
            AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = p.message_id
          ORDER BY linked.resolved_at DESC
          LIMIT 1
        )) as resolved_by,
        u.username, u.display_name, c.name as channel_name, c.is_dm,
        partner_user.id as dm_partner_id,
        partner_user.display_name as dm_partner_display_name, partner_user.username as dm_partner_username,
        bot.username as bot_username, bot.display_name as bot_display_name
      FROM processes p
      LEFT JOIN messages m ON p.message_id = m.id
      LEFT JOIN messages thread_root ON m.thread_id = thread_root.id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN channels c ON p.channel_id = c.id
      LEFT JOIN users bot ON p.bot_id = bot.id
      ${visibilityJoin}
      LEFT JOIN channel_members partner_cm ON c.is_dm = 1 AND partner_cm.channel_id = c.id AND partner_cm.user_id != ? AND partner_cm.left_at IS NULL
      LEFT JOIN users partner_user ON partner_cm.user_id = partner_user.id
    `;
    const params: unknown[] = user.is_admin ? [user.id] : [user.id, user.id];

    if (options.status) {
      query += ' WHERE p.status = ?';
      params.push(options.status);
    }

    query += ' GROUP BY p.id ORDER BY p.started_at DESC';

    const result = await this.env.DB.prepare(query).bind(...params).all<any>();
    return result.results.map(normalizeProcessRow);
  }

  async getProcess(processId: string): Promise<any | null> {
    return this.env.DB.prepare('SELECT * FROM processes WHERE id = ?').bind(processId).first<any>();
  }

  async getProcessDetail(processId: string): Promise<any | null> {
    const process = await this.env.DB.prepare(
      `SELECT p.*, m.thread_id,
        COALESCE(thread_root.resolved_at, m.resolved_at, (
          SELECT linked.resolved_at
          FROM messages linked
          WHERE linked.channel_id = p.channel_id
            AND linked.thread_id IS NULL
            AND linked.deleted_at IS NULL
            AND linked.resolved_at IS NOT NULL
            AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = p.message_id
          ORDER BY linked.resolved_at DESC
          LIMIT 1
        )) as resolved_at,
        COALESCE(thread_root.resolved_by, m.resolved_by, (
          SELECT linked.resolved_by
          FROM messages linked
          WHERE linked.channel_id = p.channel_id
            AND linked.thread_id IS NULL
            AND linked.deleted_at IS NULL
            AND linked.resolved_at IS NOT NULL
            AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = p.message_id
          ORDER BY linked.resolved_at DESC
          LIMIT 1
        )) as resolved_by,
        bot.username as bot_username, bot.display_name as bot_display_name
       FROM processes p
       LEFT JOIN messages m ON p.message_id = m.id
       LEFT JOIN messages thread_root ON m.thread_id = thread_root.id
       LEFT JOIN users bot ON p.bot_id = bot.id
       WHERE p.id = ?`
    ).bind(processId).first<any>();

    return process ? normalizeProcessRow(process) : null;
  }
}

export function normalizeProcessRow(process: any): any {
  return {
    ...process,
    started_at: normalizeDatetime(process.started_at),
    ended_at: process.ended_at ? normalizeDatetime(process.ended_at) : null,
    updated_at: process.updated_at ? normalizeDatetime(process.updated_at) : null,
  };
}
