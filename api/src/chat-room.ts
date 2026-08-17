import { DurableObject } from 'cloudflare:workers';
import { credentialMetaFromUrl, dispatchChatRoomAction, type ConnectionMeta } from './chat-room-actions.js';
import type { Env } from './types.js';

export class ChatRoom extends DurableObject<Env> {
  // Keyed by userId. threadId is null for main-channel typing, or the parent
  // message id when the user is typing in a thread.
  private typingUsers = new Map<string, { timer: ReturnType<typeof setTimeout>; threadId: string | null }>();

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId')!;
    const username = url.searchParams.get('username')!;
    const displayName = url.searchParams.get('displayName');
    const nameColor = url.searchParams.get('nameColor') || null;
    const role = url.searchParams.get('role') || null;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const meta: ConnectionMeta = {
      userId,
      username,
      displayName,
      nameColor,
      role,
      ...credentialMetaFromUrl(url),
    };
    this.ctx.acceptWebSocket(server, [userId, meta.credentialId]);
    server.serializeAttachment(meta);

    // Broadcast join
    this.broadcast({ type: 'user_joined', userId, username }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const meta = this.getMeta(ws);
    if (!meta) return;
    await dispatchChatRoomAction({
      env: this.env,
      ws,
      meta,
      message,
      onTypingStart: (socket, socketMeta, threadId) => this.handleTypingStart(socket, socketMeta, threadId),
      onTypingStop: (socket, socketMeta, threadId) => this.handleTypingStop(socket, socketMeta, threadId),
      // Background work (push, unfurl) for WS-sent messages rides on the DO's
      // waitUntil — without it handleSendMessage skips all of it.
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }

  async webSocketClose(ws: WebSocket) {
    const meta = this.getMeta(ws);
    if (meta) {
      // If they disconnect mid-typing, clear the indicator for everyone else.
      const wasTyping = this.typingUsers.get(meta.userId);
      this.clearTyping(meta.userId);
      if (wasTyping) {
        this.broadcast({ type: 'user_stopped_typing', userId: meta.userId, threadId: wasTyping.threadId }, ws);
      }
      this.broadcast({ type: 'user_left', userId: meta.userId }, ws);
    }
  }

  async webSocketError(ws: WebSocket) {
    ws.close();
  }

  // Lower-level adapter called by publishChannelEvent for channel-scoped events.
  // When excludeRoles is provided, connections whose role is in the set are skipped.
  async broadcastMessage(
    channelId: string,
    message: Record<string, unknown>,
    excludeRoles?: string[],
    botSender?: { mentionedUserIds: string[] },
  ) {
    // Legacy per-channel leg: directly-connected /ws/:channelId sockets.
    this.broadcast(message, undefined, excludeRoles ? new Set(excludeRoles) : undefined, botSender);
    // Global leg: fan the event into every member's owner-scoped /events stream.
    await this.broadcastGlobalEvents(channelId, message, excludeRoles, botSender);
  }

  // Fan a channel event out to every current member's UserEventsRoom. Membership
  // in D1 is the routing table — no subscription registry. Offline members' DOs
  // simply hold no sockets, so deliver() is a cheap no-op. The same excludeRoles
  // / bot-mention filtering as the local broadcast is applied here.
  private async broadcastGlobalEvents(
    channelId: string,
    message: Record<string, unknown>,
    excludeRoles?: string[],
    botSender?: { mentionedUserIds: string[] },
  ): Promise<void> {
    const excludedRoles = excludeRoles ? new Set(excludeRoles) : null;
    const mentionedSet = botSender ? new Set(botSender.mentionedUserIds) : null;
    const members = await this.env.DB.prepare(`
      SELECT cm.user_id, u.role
      FROM channel_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND cm.left_at IS NULL
    `).bind(channelId).all<{ user_id: string; role: string }>();

    await Promise.all((members.results ?? []).map(async (member) => {
      if (excludedRoles?.has(member.role)) return;
      if (mentionedSet && member.role === 'bot' && !mentionedSet.has(member.user_id)) return;
      const room = this.env.USER_EVENTS_ROOM.get(this.env.USER_EVENTS_ROOM.idFromName(member.user_id));
      await room.deliver(channelId, message);
    }));
  }

  // Send a message to a specific user's connections only.
  async sendToUser(userId: string, message: Record<string, unknown>): Promise<number> {
    let sent = 0;
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.getMeta(ws);
      if (meta?.userId !== userId) continue;
      try { ws.send(payload); sent++; } catch {}
    }
    return sent;
  }

  // Disconnect all currently connected WebSocket clients for a user.
  async disconnectUser(userId: string, reason = 'Removed from channel'): Promise<number> {
    let disconnected = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.getMeta(ws);
      if (meta?.userId !== userId) continue;
      try {
        ws.close(1000, reason);
        disconnected++;
      } catch {}
    }
    return disconnected;
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

  // Close every connection — used when the channel is deleted so sockets
  // don't linger attached to a room whose data is gone.
  async closeAllConnections(reason = 'Channel deleted'): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
        closed++;
      } catch {}
    }
    return closed;
  }

  private getMeta(ws: WebSocket): ConnectionMeta | null {
    return ws.deserializeAttachment() as ConnectionMeta | null;
  }

  private broadcast(
    data: Record<string, unknown>,
    exclude?: WebSocket,
    excludeRoles?: Set<string>,
    botSender?: { mentionedUserIds: string[] },
  ) {
    const message = JSON.stringify(data);
    const mentionedSet = botSender ? new Set(botSender.mentionedUserIds) : undefined;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const meta = this.getMeta(ws);
      if (!meta?.credentialId || !meta.credentialExpiresAt) {
        try { ws.close(4001, 'Reconnect required'); } catch {}
        continue;
      }
      if (meta.credentialExpiresAt <= Math.floor(Date.now() / 1000)) {
        try { ws.close(4001, 'Credential expired'); } catch {}
        continue;
      }
      if (excludeRoles && meta?.role && excludeRoles.has(meta.role)) continue;
      if (mentionedSet && meta?.role === 'bot' && !mentionedSet.has(meta.userId)) continue;
      try { ws.send(message); } catch {}
    }
  }

  private handleTypingStart(ws: WebSocket, meta: ConnectionMeta, threadId: string | null) {
    // If the user was already typing somewhere else (e.g. switched from the
    // main channel into a thread), tell everyone they stopped there first.
    const existing = this.typingUsers.get(meta.userId);
    if (existing) {
      clearTimeout(existing.timer);
      if (existing.threadId !== threadId) {
        this.broadcast({ type: 'user_stopped_typing', userId: meta.userId, threadId: existing.threadId });
      }
    }

    // Set auto-expire
    const timer = setTimeout(() => {
      this.typingUsers.delete(meta.userId);
      this.broadcast({ type: 'user_stopped_typing', userId: meta.userId, threadId });
    }, 8000);
    this.typingUsers.set(meta.userId, { timer, threadId });

    this.broadcast({ type: 'user_typing', userId: meta.userId, username: meta.username, threadId }, ws);
  }

  private handleTypingStop(ws: WebSocket, meta: ConnectionMeta, threadId: string | null) {
    // Prefer the context we recorded on start; fall back to what the client sent.
    const recordedThreadId = this.typingUsers.get(meta.userId)?.threadId ?? threadId;
    this.clearTyping(meta.userId);
    this.broadcast({ type: 'user_stopped_typing', userId: meta.userId, threadId: recordedThreadId }, ws);
  }

  private clearTyping(userId: string) {
    const entry = this.typingUsers.get(userId);
    if (entry) {
      clearTimeout(entry.timer);
      this.typingUsers.delete(userId);
    }
  }
}
