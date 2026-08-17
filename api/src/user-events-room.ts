import { DurableObject } from 'cloudflare:workers';
import { credentialMetaFromUrl, dispatchChatRoomAction, type ConnectionMeta } from './chat-room-actions.js';
import { eventPriority, sendWithBackpressure } from './lib/ws-backpressure.js';
import type { Env } from './types.js';

interface UserEventsAttachment extends ConnectionMeta {
  scope: 'global-events';
}

/**
 * Owner-scoped event stream. One DO instance per user (idFromName(userId)) holds
 * that user's `/events` socket(s) and receives events for ALL of their channels.
 *
 * Fan-in is push-on-publish: publishChannelEvent delegates to ChatRoom, which
 * queries channel membership and RPCs `deliver()` on each member's
 * UserEventsRoom. There is no subscription registry; membership in D1 is the
 * routing table.
 */
export class UserEventsRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const meta: UserEventsAttachment = {
      scope: 'global-events',
      userId: url.searchParams.get('userId')!,
      username: url.searchParams.get('username')!,
      displayName: url.searchParams.get('displayName'),
      nameColor: url.searchParams.get('nameColor') || null,
      role: url.searchParams.get('role') || null,
      ...credentialMetaFromUrl(url),
    };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [meta.userId, meta.credentialId]);
    server.serializeAttachment(meta);
    server.send(JSON.stringify({ type: 'events.ready' }));
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
      // The owner-scoped socket is intended for agents; keep ephemeral UI typing
      // controls on the per-room socket.
      onTypingStart: () => {},
      onTypingStop: () => {},
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }

  async webSocketError(ws: WebSocket) {
    ws.close();
  }

  /**
   * RPC entry point for the fan-in. ChatRoom calls this for each channel member.
   * Enriches the envelope with channel context and delivers to the user's
   * socket(s) under backpressure.
   */
  async deliver(channelId: string, message: Record<string, unknown>): Promise<number> {
    let sent = 0;
    const event = await this.withRoomMetadata(channelId, message);
    const payload = JSON.stringify(event);
    const priority = eventPriority(typeof event.type === 'string' ? event.type : 'unknown');

    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.getMeta(ws);
      if (!meta?.credentialId || !meta.credentialExpiresAt) {
        try { ws.close(4001, 'Reconnect required'); } catch {}
        continue;
      }
      if (meta.credentialExpiresAt <= Math.floor(Date.now() / 1000)) {
        try { ws.close(4001, 'Credential expired'); } catch {}
        continue;
      }
      if (sendWithBackpressure(ws, payload, priority) === 'sent') sent++;
    }
    return sent;
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

  private async withRoomMetadata(channelId: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const channel = await this.env.DB.prepare('SELECT is_dm FROM channels WHERE id = ?')
      .bind(channelId)
      .first<{ is_dm: number }>();
    const threadId = message.threadId ?? message.thread_id ?? null;
    return {
      ...message,
      channelId,
      room: { id: channelId, type: channel?.is_dm ? 'dm' : 'channel' },
      threadId,
    };
  }

  private getMeta(ws: WebSocket): ConnectionMeta | null {
    return ws.deserializeAttachment() as UserEventsAttachment | null;
  }
}
