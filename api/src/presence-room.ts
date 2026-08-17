import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';
import { credentialMetaFromUrl } from './chat-room-actions.js';

const GRACE_PERIOD_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MISSED_PINGS_LIMIT = 2;

interface WsAttachment {
  missedPings: number;
  credentialId: string;
  credentialExpiresAt: number;
  // Last click/keystroke heartbeat from this client, ms epoch. Absent until the
  // first real input — a merely-connected socket is not "active" (see
  // getActiveUserIds). Survives hibernation via the socket attachment.
  lastActivityAt?: number;
}

// A user counts as "active" (and so is excluded from push) if any of their open
// clients reported input within this window. Matches the client-facing 60s idle
// rule; far larger than the client's activity heartbeat throttle.
const ACTIVE_WINDOW_MS = 60_000;

export class PresenceRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Auto-respond to client-initiated app-level keepalive pings WITHOUT waking
    // the DO (no webSocketMessage invocation, no hibernation break). Bots send
    // {type:"ping"} to detect half-open sockets; the runtime replies {type:"pong"}.
    // Protocol-level WS ping/pong is unreliable through Cloudflare's edge proxy,
    // so keepalive is app-level JSON on both the channel and presence paths.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'pong' }),
      ),
    );
  }

  async fetch(request: Request): Promise<Response> {
    return await this.fetchImpl(request);
  }

  private async fetchImpl(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // REST: GET /presence?userIds=a,b,c
    if (request.headers.get('Upgrade') !== 'websocket') {
      return this.handlePresenceQuery(url);
    }

    // WebSocket upgrade
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return new Response('Missing userId', { status: 400 });
    }
    const credential = credentialMetaFromUrl(url);

    const wasOnline = this.isUserOnline(userId);
    const hadGrace = await this.hasGrace(userId);
    if (hadGrace) await this.clearGrace(userId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with userId as tag — survives hibernation, enables tag-based lookup
    this.ctx.acceptWebSocket(server, [userId, credential.credentialId]);
    server.serializeAttachment({
      missedPings: 0,
      credentialId: credential.credentialId,
      credentialExpiresAt: credential.credentialExpiresAt,
    } as WsAttachment);

    // Broadcast online only if user had no active connections
    if (!wasOnline) {
      this.broadcast({ type: 'presence_update', userId, online: true }, server);
    }

    // Send snapshot of who's currently online (active connections only)
    const users: Record<string, boolean> = {};
    for (const uid of this.getOnlineUserIds()) {
      if (uid !== userId) users[uid] = true;
    }
    try {
      server.send(JSON.stringify({ type: 'presence_snapshot', users }));
    } catch {}

    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    try {
      const data = JSON.parse(message);
      if (data.type === 'pong') {
        const att = ws.deserializeAttachment() as WsAttachment;
        att.missedPings = 0;
        ws.serializeAttachment(att);
      } else if (data.type === 'activity') {
        // Click/keystroke heartbeat from an actively-used client. Record it so
        // push-send can suppress notifications for users interacting right now.
        // Note: a pong is a keepalive, not user input — it must NOT count here.
        const att = ws.deserializeAttachment() as WsAttachment | null;
        if (!att?.credentialId) {
          ws.close(4001, 'Reconnect required');
          return;
        }
        att.lastActivityAt = Date.now();
        ws.serializeAttachment(att);
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket) {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.handleDisconnect(ws);
  }

  async alarm() {
    const now = Date.now();

    // 1. Expire grace timers
    for (const [key, expiresAt] of await this.ctx.storage.list<number>({ prefix: 'grace:' })) {
      if (now >= expiresAt) {
        const userId = key.slice(6); // 'grace:'.length === 6
        if (!this.isUserOnline(userId)) {
          this.broadcast({ type: 'presence_update', userId, online: false });
        }
        await this.ctx.storage.delete(key);
      }
    }

    // 2. Heartbeat — ping all connected sockets
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att?.credentialId || !att.credentialExpiresAt) {
        try { ws.close(4001, 'Reconnect required'); } catch {}
        continue;
      }
      if (att.credentialExpiresAt <= Math.floor(now / 1000)) {
        try { ws.close(4001, 'Credential expired'); } catch {}
        continue;
      }
      if (att.missedPings >= MISSED_PINGS_LIMIT) {
        try { ws.close(1000, 'Heartbeat timeout'); } catch {}
        continue;
      }
      att.missedPings++;
      ws.serializeAttachment(att);
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }

    // 3. Schedule next alarm if still needed
    await this.scheduleNextAlarm();
  }

  /**
   * RPC: deliver an app event to specific users over their presence sockets.
   * Used for user-targeted notifications (member_added, channel_deleted)
   * that previously fanned out through every channel DO the user had joined.
   */
  async sendToUsers(userIds: string[], event: Record<string, unknown>): Promise<void> {
    const msg = JSON.stringify(event);
    for (const userId of userIds) {
      for (const ws of this.ctx.getWebSockets(userId)) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  async disconnectCredential(credentialId: string, reason = 'Credential revoked'): Promise<number> {
    let disconnected = 0;
    for (const ws of this.ctx.getWebSockets(credentialId)) {
      try {
        ws.close(4001, reason);
        disconnected++;
      } catch {}
    }
    return disconnected;
  }

  /**
   * RPC: user IDs with a click/keystroke heartbeat within the idle window on ANY
   * of their open clients. push-send suppresses notifications for these users —
   * they're actively using the app somewhere, so a push would be redundant (the
   * unread badge covers it). Fail-open: a client that has only connected (no
   * input) is NOT active, so an idle-but-open tab no longer silences the user's
   * phone — the original bug this replaced.
   */
  async getActiveUserIds(): Promise<string[]> {
    const now = Date.now();
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      const lastActivityAt = att?.lastActivityAt;
      if (typeof lastActivityAt !== 'number' || now - lastActivityAt >= ACTIVE_WINDOW_MS) continue;
      const tags = this.ctx.getTags(ws);
      if (tags.length) ids.add(tags[0]);
    }
    return [...ids];
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async handlePresenceQuery(url: URL): Promise<Response> {
    const param = url.searchParams.get('userIds');
    if (!param) {
      return new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const ids = param.split(',').filter(Boolean);
    const online = this.getOnlineUserIds();
    const result: Record<string, boolean> = {};
    for (const id of ids) result[id] = online.has(id);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDisconnect(ws: WebSocket) {
    const tags = this.ctx.getTags(ws);
    if (!tags.length) return;
    const userId = tags[0];

    // WS is still in getWebSockets() during close/error — filter it out
    const others = this.ctx.getWebSockets(userId).filter((s) => s !== ws);
    if (others.length === 0) {
      await this.setGrace(userId);
    }
  }

  private getOnlineUserIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.length) ids.add(tags[0]);
    }
    return ids;
  }

  private isUserOnline(userId: string): boolean {
    return this.ctx.getWebSockets(userId).length > 0;
  }

  private broadcast(data: Record<string, unknown>, exclude?: WebSocket) {
    const msg = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  // Grace timer persistence — survives hibernation via DO storage + alarms
  private async setGrace(userId: string) {
    await this.ctx.storage.put(`grace:${userId}`, Date.now() + GRACE_PERIOD_MS);
    await this.ensureAlarm();
  }

  private async clearGrace(userId: string) {
    await this.ctx.storage.delete(`grace:${userId}`);
  }

  private async hasGrace(userId: string): Promise<boolean> {
    return (await this.ctx.storage.get(`grace:${userId}`)) !== undefined;
  }

  private async ensureAlarm() {
    let needed = Date.now() + HEARTBEAT_INTERVAL_MS;
    for (const [, exp] of await this.ctx.storage.list<number>({ prefix: 'grace:' })) {
      if (exp < needed) needed = exp;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > needed) {
      await this.ctx.storage.setAlarm(needed);
    }
  }

  private async scheduleNextAlarm() {
    const grace = await this.ctx.storage.list<number>({ prefix: 'grace:' });
    if (this.ctx.getWebSockets().length === 0 && grace.size === 0) return;
    let next = Date.now() + HEARTBEAT_INTERVAL_MS;
    for (const [, exp] of grace) {
      if (exp < next) next = exp;
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 50));
  }
}
