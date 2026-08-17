import type { Env } from '../types.js';

/** Consecutive top-level bot responses within the window before the breaker trips. */
export const BOT_LOOP_THRESHOLD = 10;

/** Rolling window in milliseconds — counter resets if the gap exceeds this. */
export const BOT_LOOP_WINDOW_MS = 60_000;

/** Tripped breakers auto-reset after this long, even with no human message. */
export const BOT_LOOP_RESET_MS = 5 * 60_000;

export interface CircuitBreakerState {
  /** Current trip timestamp (null = not tripped). */
  trippedAt: number | null;
  /** True when this very message tripped the breaker — broadcast an event. */
  newlyTripped: boolean;
}

/**
 * Update per-channel circuit-breaker state after a message insert.
 *
 * Call BEFORE fan-out so the tripped flag can gate bot delivery.
 *
 * Only top-level `response` messages count toward the loop: a single
 * streaming agent emits thinking/tool_output/progress freely and threaded
 * replies are scoped conversations — neither indicates bots answering bots.
 */
export async function updateCircuitBreaker(
  env: Env,
  channelId: string,
  messageType: string,
  threadId: string | null = null,
): Promise<CircuitBreakerState> {
  const nowMs = Date.now();

  if (messageType === 'human') {
    // Human message resets the breaker (including a previously-tripped one).
    await env.DB.prepare(
      `UPDATE channels
         SET consecutive_non_human_count = 0,
             non_human_window_started_at = NULL,
             bot_loop_tripped_at = NULL
       WHERE id = ?`,
    ).bind(channelId).run();
    return { trippedAt: null, newlyTripped: false };
  }

  if (messageType !== 'response' || threadId) {
    // Neutral traffic: neither counts toward the loop nor resets it. Read the
    // current state (honoring the auto-reset window) to gate delivery.
    const row = await env.DB.prepare(
      `SELECT CASE
                WHEN bot_loop_tripped_at IS NOT NULL AND (? - bot_loop_tripped_at) <= ?
                THEN bot_loop_tripped_at
                ELSE NULL
              END AS tripped_at
         FROM channels WHERE id = ?`,
    ).bind(nowMs, BOT_LOOP_RESET_MS, channelId).first<{ tripped_at: number | null }>();
    return { trippedAt: row?.tripped_at ?? null, newlyTripped: false };
  }

  // Top-level bot response — atomic UPDATE … RETURNING so concurrent inserts
  // each see a consistent count (SQLite SET-clause reads OLD column values).
  // A trip older than BOT_LOOP_RESET_MS is treated as expired and recomputed.
  const row = await env.DB.prepare(
    `UPDATE channels SET
       consecutive_non_human_count = CASE
         WHEN non_human_window_started_at IS NULL OR (? - non_human_window_started_at) > ?
         THEN 1
         ELSE consecutive_non_human_count + 1
       END,
       non_human_window_started_at = CASE
         WHEN non_human_window_started_at IS NULL OR (? - non_human_window_started_at) > ?
         THEN ?
         ELSE non_human_window_started_at
       END,
       bot_loop_tripped_at = CASE
         WHEN bot_loop_tripped_at IS NOT NULL AND (? - bot_loop_tripped_at) <= ? THEN bot_loop_tripped_at
         WHEN (CASE
                 WHEN non_human_window_started_at IS NULL OR (? - non_human_window_started_at) > ?
                 THEN 1
                 ELSE consecutive_non_human_count + 1
               END) >= ?
         THEN ?
         ELSE NULL
       END
     WHERE id = ?
     RETURNING bot_loop_tripped_at`,
  ).bind(
    nowMs, BOT_LOOP_WINDOW_MS,          // count CASE
    nowMs, BOT_LOOP_WINDOW_MS, nowMs,   // window_started_at CASE
    nowMs, BOT_LOOP_RESET_MS,           // tripped keep-if-fresh CASE
    nowMs, BOT_LOOP_WINDOW_MS,          // tripped nested count CASE
    BOT_LOOP_THRESHOLD, nowMs,          // tripped threshold + value
    channelId,                          // WHERE
  ).first<{ bot_loop_tripped_at: number | null }>();

  const trippedAt = row?.bot_loop_tripped_at ?? null;
  return { trippedAt, newlyTripped: trippedAt === nowMs };
}
