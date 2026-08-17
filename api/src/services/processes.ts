import type { Env, User } from '../types.js';
import { generateId } from '../utils.js';
import { normalizeDatetime } from '../read-models/processes.js';
import { publishChannelEvent } from '../lib/channel-events.js';

// A "process" is one bot turn/run. It is identified by its own UUID — there is no OS
// pid coupling. The owning agent drives the lifecycle entirely over the REST API
// (create → activity/update → done|error), and cancellation flows back to the agent as
// a `process_kill` event fanned out over both the channel WebSocket and any registered
// bot webhooks (see killProcess). Cancellation is therefore cooperative: Threads marks
// the row `killed` and signals the agent, which is expected to stop on its own.
export type ProcessStatus = 'queued' | 'running' | 'done' | 'error' | 'killed' | 'restarted';
type MessageProcessStatus = ProcessStatus | 'processing';

// `restarted` is server-owned: agents can report ordinary lifecycle states, while
// cleanupProcessesByBot is the only operation that records an interrupted incarnation.
const AGENT_SETTABLE_STATUSES: ProcessStatus[] = ['queued', 'running', 'done', 'error', 'killed'];
const ACTIVE_STATUSES: ProcessStatus[] = ['queued', 'running'];

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'error' || status === 'killed' || status === 'restarted';
}

function messageProcessStatus(status: ProcessStatus): MessageProcessStatus {
  return status === 'running' ? 'processing' : status;
}

export interface CreateProcessInput {
  id?: string;
  channel_id: string;
  message_id: string;
  user_id?: string;
  status?: string;
  bot_id?: string;
}

export interface UpdateProcessInput {
  status?: string;
  tool_call_count?: number;
  reply_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ProcessActivityInput {
  type: 'tool_call' | 'reply' | 'token_usage';
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export class ProcessService {
  constructor(private readonly env: Env, private readonly ctx?: ExecutionContext) {}

  isValidStatus(status: string | undefined): status is ProcessStatus {
    return !!status && AGENT_SETTABLE_STATUSES.includes(status as ProcessStatus);
  }

  async createProcess(input: CreateProcessInput, user: User): Promise<{ id: string; status: ProcessStatus }> {
    const effectiveStatus = this.isValidStatus(input.status) ? input.status : 'running';
    const effectiveUserId = input.user_id || user.id;
    // The bot running the turn defaults to the caller (agents create their own process).
    // A bot always owns the process it creates. Admins retain the existing ability to
    // create a process on a bot's behalf, but bot principals cannot impersonate peers.
    const effectiveBotId = user.is_admin && input.bot_id ? input.bot_id : user.id;
    const processId = input.id || generateId();
    const now = new Date().toISOString();

    await this.env.DB.prepare(
      'INSERT INTO processes (id, channel_id, message_id, user_id, status, updated_at, bot_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(processId, input.channel_id, input.message_id, effectiveUserId, effectiveStatus, now, effectiveBotId).run();

    // Stamp the triggering message so the UI can show a per-message spinner.
    if (input.message_id) {
      await this.env.DB.prepare('UPDATE messages SET process_id = ?, process_status = ? WHERE id = ?')
        .bind(processId, messageProcessStatus(effectiveStatus), input.message_id).run();
    }

    const [msgRow, effectiveUser, channel, botUser] = await Promise.all([
      this.env.DB.prepare(
        `SELECT m.thread_id,
          COALESCE(thread_root.resolved_at, m.resolved_at, (
            SELECT linked.resolved_at
            FROM messages linked
            WHERE linked.channel_id = m.channel_id
              AND linked.thread_id IS NULL
              AND linked.deleted_at IS NULL
              AND linked.resolved_at IS NOT NULL
              AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = m.id
            ORDER BY linked.resolved_at DESC
            LIMIT 1
          )) as resolved_at,
          COALESCE(thread_root.resolved_by, m.resolved_by, (
            SELECT linked.resolved_by
            FROM messages linked
            WHERE linked.channel_id = m.channel_id
              AND linked.thread_id IS NULL
              AND linked.deleted_at IS NULL
              AND linked.resolved_at IS NOT NULL
              AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = m.id
            ORDER BY linked.resolved_at DESC
            LIMIT 1
          )) as resolved_by
         FROM messages m
         LEFT JOIN messages thread_root ON m.thread_id = thread_root.id
         WHERE m.id = ?`
      ).bind(input.message_id).first<{ thread_id: string | null; resolved_at: number | null; resolved_by: string | null }>(),
      effectiveUserId !== user.id
        ? this.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
            .bind(effectiveUserId).first<{ username: string; display_name: string }>()
        : Promise.resolve(null),
      this.env.DB.prepare('SELECT name, is_dm FROM channels WHERE id = ?')
        .bind(input.channel_id).first<{ name: string; is_dm: number }>(),
      this.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
        .bind(effectiveBotId).first<{ username: string; display_name: string | null }>(),
    ]);

    await publishChannelEvent(this.env, this.ctx, input.channel_id, {
      type: 'process_created',
      process: {
        id: processId,
        channel_id: input.channel_id,
        channel_name: channel?.name || '',
        is_dm: channel?.is_dm || 0,
        message_id: input.message_id,
        thread_id: msgRow?.thread_id || null,
        resolved_at: msgRow?.resolved_at ?? null,
        resolved_by: msgRow?.resolved_by ?? null,
        user_id: effectiveUserId,
        username: effectiveUser?.username || user.username,
        display_name: effectiveUser?.display_name || user.display_name,
        status: effectiveStatus,
        started_at: now,
        ended_at: null,
        tool_call_count: 0,
        reply_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        bot_id: effectiveBotId,
        bot_username: botUser?.username || '',
        bot_display_name: botUser?.display_name || null,
      },
    });

    // Also emit process_status for subscribers. Adapters should still call
    // /messages/:id/process with status=processing to show the active message chip.
    if (input.message_id) {
      await publishChannelEvent(this.env, this.ctx, input.channel_id, {
        type: 'process_status',
        messageId: input.message_id,
        processId,
        status: messageProcessStatus(effectiveStatus),
        threadId: msgRow?.thread_id || null,
      });
    }

    return { id: processId, status: effectiveStatus };
  }

  async cleanupProcessesByBot(botId: string): Promise<{ cleaned: number; process_ids: string[] }> {
    const running = await this.env.DB.prepare(
      `SELECT p.id, p.channel_id, p.message_id, p.user_id, p.bot_id, p.started_at, m.thread_id
       FROM processes p
       LEFT JOIN messages m ON p.message_id = m.id
       WHERE p.bot_id = ? AND p.status IN ('running', 'queued')`
    ).bind(botId).all<any>();

    const ids: string[] = [];
    for (const process of running.results) {
      if (await this.terminateProcess(process, 'restarted', false)) ids.push(process.id);
    }
    return { cleaned: ids.length, process_ids: ids };
  }

  async killAllProcesses(user: User): Promise<{ cleaned: number; process_ids: string[] }> {
    const isAdmin = !!user.is_admin;
    const running = await this.env.DB.prepare(
      `SELECT p.id, p.channel_id, p.message_id, p.user_id, p.bot_id, p.started_at, m.thread_id
       FROM processes p
       LEFT JOIN messages m ON p.message_id = m.id
       ${isAdmin ? '' : 'INNER JOIN channel_members cm ON cm.channel_id = p.channel_id AND cm.user_id = ? AND cm.left_at IS NULL'}
       WHERE p.status IN ('running', 'queued')`
    ).bind(...(isAdmin ? [] : [user.id])).all<any>();

    const ids: string[] = [];
    for (const process of running.results) {
      if (await this.killProcess(process)) ids.push(process.id);
    }
    return { cleaned: ids.length, process_ids: ids };
  }

  async updateProcess(process: any, input: UpdateProcessInput): Promise<boolean> {
    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.status) {
      const endedAt = isTerminal(input.status) ? now : null;
      setClauses.push('status = ?', 'ended_at = COALESCE(?, ended_at)');
      params.push(input.status, endedAt);
    }
    for (const column of ['tool_call_count', 'reply_count', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      if (input[column] !== undefined) {
        setClauses.push(`${column} = ?`);
        params.push(input[column]);
      }
    }

    // Terminal rows are immutable except for idempotently repeating their terminal
    // status. Keeping the condition in SQL closes the race where startup cleanup marks
    // a run restarted after this request loaded it but before this update executes.
    const mutableStatuses = input.status && isTerminal(input.status)
      ? [...ACTIVE_STATUSES, input.status]
      : ACTIVE_STATUSES;
    const statusPlaceholders = mutableStatuses.map(() => '?').join(', ');
    params.push(process.id, ...mutableStatuses);
    const write = await this.env.DB.prepare(
      `UPDATE processes SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${statusPlaceholders})`
    ).bind(...params).run();
    if ((write.meta.changes ?? 0) === 0) return false;

    const updated = await this.env.DB.prepare('SELECT status, ended_at, tool_call_count, reply_count, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, updated_at FROM processes WHERE id = ?')
      .bind(process.id).first<any>();

    await this.broadcastProcessUpdated(process, {
      status: updated?.status ?? process.status,
      ended_at: normalizeDatetime(updated?.ended_at ?? process.ended_at),
      tool_call_count: updated?.tool_call_count ?? 0,
      reply_count: updated?.reply_count ?? 0,
      input_tokens: updated?.input_tokens ?? 0,
      output_tokens: updated?.output_tokens ?? 0,
      cache_creation_input_tokens: updated?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: updated?.cache_read_input_tokens ?? 0,
      updated_at: normalizeDatetime(updated?.updated_at ?? now),
    });

    if (input.status) {
      await this.updateMessageProcessStatus(process, input.status as ProcessStatus);
    }

    return true;
  }

  async recordActivity(process: any, input: ProcessActivityInput): Promise<boolean> {
    const now = new Date().toISOString();
    let write: D1Result<unknown>;

    if (input.type === 'token_usage') {
      write = await this.env.DB.prepare(
        `UPDATE processes SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_creation_input_tokens = cache_creation_input_tokens + ?, cache_read_input_tokens = cache_read_input_tokens + ?, updated_at = ?
         WHERE id = ? AND status IN ('running', 'queued')`
      ).bind(input.input_tokens ?? 0, input.output_tokens ?? 0, input.cache_creation_input_tokens ?? 0, input.cache_read_input_tokens ?? 0, now, process.id).run();
    } else {
      const column = input.type === 'tool_call' ? 'tool_call_count' : 'reply_count';
      write = await this.env.DB.prepare(
        `UPDATE processes SET ${column} = ${column} + 1, updated_at = ?
         WHERE id = ? AND status IN ('running', 'queued')`
      )
        .bind(now, process.id).run();
    }
    if ((write.meta.changes ?? 0) === 0) return false;

    const updated = await this.env.DB.prepare('SELECT tool_call_count, reply_count, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM processes WHERE id = ?')
      .bind(process.id).first<any>();

    await this.broadcastProcessUpdated(process, {
      status: process.status,
      tool_call_count: updated?.tool_call_count ?? 0,
      reply_count: updated?.reply_count ?? 0,
      input_tokens: updated?.input_tokens ?? 0,
      output_tokens: updated?.output_tokens ?? 0,
      cache_creation_input_tokens: updated?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: updated?.cache_read_input_tokens ?? 0,
      updated_at: now,
    });

    return true;
  }

  // User-initiated cancellation from Threads. Marks the row `killed`, updates the
  // attached message, and publishes `process_kill` through the channel event seam — which fans it
  // out over the channel WebSocket AND any webhooks registered by the owning bot, so the
  // agent receives the cancel signal whichever transport it listens on.
  async killProcess(process: any): Promise<boolean> {
    return this.terminateProcess(process, 'killed', true);
  }

  private async terminateProcess(process: any, status: 'killed' | 'restarted', signalOwner: boolean): Promise<boolean> {
    const endedAt = new Date().toISOString();
    const write = await this.env.DB.prepare(
      `UPDATE processes SET status = ?, ended_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running', 'queued')`
    ).bind(status, endedAt, endedAt, process.id).run();
    if ((write.meta.changes ?? 0) === 0) return false;

    if (signalOwner) {
      await publishChannelEvent(
        this.env,
        this.ctx,
        process.channel_id,
        {
          type: 'process_kill',
          processId: process.id,
          messageId: process.message_id,
          botUserId: process.bot_id ?? null,
        },
        { webhooks: { extraBotRecipientIds: process.bot_id ? [process.bot_id] : [] } },
      );
    }

    await this.broadcastProcessUpdated(process, { status, ended_at: endedAt, updated_at: endedAt });
    await this.updateMessageProcessStatus(process, status);
    return true;
  }

  private async broadcastProcessUpdated(process: any, overrides: Record<string, unknown> = {}): Promise<void> {
    const [channelRow, userRow, botRow, msgRow] = await Promise.all([
      this.env.DB.prepare('SELECT name, is_dm FROM channels WHERE id = ?')
        .bind(process.channel_id).first<{ name: string; is_dm: number }>(),
      this.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
        .bind(process.user_id).first<{ username: string; display_name: string }>(),
      process.bot_id
        ? this.env.DB.prepare('SELECT username, display_name FROM users WHERE id = ?')
            .bind(process.bot_id).first<{ username: string; display_name: string | null }>()
        : Promise.resolve(null),
      this.env.DB.prepare(
        `SELECT m.thread_id,
          COALESCE(thread_root.resolved_at, m.resolved_at, (
            SELECT linked.resolved_at
            FROM messages linked
            WHERE linked.channel_id = m.channel_id
              AND linked.thread_id IS NULL
              AND linked.deleted_at IS NULL
              AND linked.resolved_at IS NOT NULL
              AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = m.id
            ORDER BY linked.resolved_at DESC
            LIMIT 1
          )) as resolved_at,
          COALESCE(thread_root.resolved_by, m.resolved_by, (
            SELECT linked.resolved_by
            FROM messages linked
            WHERE linked.channel_id = m.channel_id
              AND linked.thread_id IS NULL
              AND linked.deleted_at IS NULL
              AND linked.resolved_at IS NOT NULL
              AND json_extract(CASE WHEN json_valid(linked.metadata) THEN linked.metadata ELSE '{}' END, '$.trigger_id') = m.id
            ORDER BY linked.resolved_at DESC
            LIMIT 1
          )) as resolved_by
         FROM messages m
         LEFT JOIN messages thread_root ON m.thread_id = thread_root.id
         WHERE m.id = ?`
      ).bind(process.message_id).first<{ thread_id: string | null; resolved_at: number | null; resolved_by: string | null }>(),
    ]);

    await publishChannelEvent(this.env, this.ctx, process.channel_id, {
      type: 'process_updated',
      process: {
        id: process.id,
        channel_id: process.channel_id,
        channel_name: channelRow?.name || '',
        is_dm: channelRow?.is_dm || 0,
        message_id: process.message_id,
        thread_id: msgRow?.thread_id || process.thread_id || null,
        resolved_at: msgRow?.resolved_at ?? process.resolved_at ?? null,
        resolved_by: msgRow?.resolved_by ?? process.resolved_by ?? null,
        user_id: process.user_id,
        username: userRow?.username || '',
        display_name: userRow?.display_name || '',
        status: process.status,
        started_at: normalizeDatetime(process.started_at),
        bot_id: process.bot_id || null,
        bot_username: botRow?.username || '',
        bot_display_name: botRow?.display_name || null,
        ...overrides,
      },
    });
  }

  private async updateMessageProcessStatus(process: any, status: ProcessStatus): Promise<void> {
    if (!process.message_id) return;

    const visibleStatus = messageProcessStatus(status);

    await this.env.DB.prepare('UPDATE messages SET process_status = ? WHERE id = ? AND process_id = ?')
      .bind(visibleStatus, process.message_id, process.id).run();

    const threadId = process.thread_id ?? (await this.env.DB.prepare('SELECT thread_id FROM messages WHERE id = ?')
      .bind(process.message_id).first<{ thread_id: string | null }>())?.thread_id ?? null;

    await publishChannelEvent(this.env, this.ctx, process.channel_id, {
      type: 'process_status',
      messageId: process.message_id,
      processId: process.id,
      status: visibleStatus,
      threadId,
    });
  }

}
