// Backpressure gating for fan-out sockets (the owner-scoped /events stream).
// A single UserEventsRoom socket receives events for ALL of a user's channels,
// so a slow client can accumulate a large send buffer. We shed load by priority:
// ephemeral events (presence/typing) are dropped first; critical events are
// never silently dropped, and a hopelessly-backed-up socket is closed so the
// client reconnects and refetches from REST.

export type EventPriority = 'critical' | 'ephemeral';

export interface BackpressureWebSocket {
  // Cloudflare's runtime exposes bufferedAmount, but the Workers TS type does
  // not currently declare it. Treat absent values as 0 so this helper remains
  // safe in test/runtime environments that omit it.
  bufferedAmount?: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type BackpressureOutcome =
  | 'sent'
  | 'dropped_ephemeral'
  | 'closed_backpressure'
  | 'send_error';

export const WS_BACKPRESSURE_HIGH_WATER_BYTES = 256 * 1024;
export const WS_BACKPRESSURE_MAX_BUFFERED_BYTES = 1024 * 1024;
export const WS_BACKPRESSURE_CLOSE_CODE = 1013;
export const WS_BACKPRESSURE_CLOSE_REASON = 'Backpressure: client too slow';

const EPHEMERAL_EVENT_TYPES = new Set([
  'presence',
  'presence_update',
  'presence_snapshot',
  'user_joined',
  'user_left',
  'user_typing',
  'user_stopped_typing',
  'typing_start',
  'typing_stop',
]);

export function eventPriority(type: string): EventPriority {
  return EPHEMERAL_EVENT_TYPES.has(type) ? 'ephemeral' : 'critical';
}

export function sendWithBackpressure(
  ws: BackpressureWebSocket,
  payload: string | ArrayBuffer,
  priority: EventPriority,
): BackpressureOutcome {
  const bufferedAmount = ws.bufferedAmount ?? 0;

  if (bufferedAmount >= WS_BACKPRESSURE_MAX_BUFFERED_BYTES) {
    safeClose(ws);
    return 'closed_backpressure';
  }

  if (priority === 'ephemeral' && bufferedAmount >= WS_BACKPRESSURE_HIGH_WATER_BYTES) {
    return 'dropped_ephemeral';
  }

  try {
    ws.send(payload);
    return 'sent';
  } catch {
    safeClose(ws);
    return 'send_error';
  }
}

function safeClose(ws: BackpressureWebSocket): void {
  try {
    ws.close(WS_BACKPRESSURE_CLOSE_CODE, WS_BACKPRESSURE_CLOSE_REASON);
  } catch {}
}
