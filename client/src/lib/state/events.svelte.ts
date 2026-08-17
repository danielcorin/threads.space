import { auth } from '$lib/state/auth.svelte.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import { processes, type Process } from '$lib/state/processes.svelte.js';
import { inbox } from '$lib/state/inbox.svelte.js';
import { updateBadge } from '$lib/badge.js';
import { websocketOrigin } from '$lib/ws-url.js';

/**
 * Owner-scoped global event stream (`GET /events`). ONE socket for the whole app
 * that receives message events for EVERY channel/DM the user belongs to — not just
 * the one on screen. The per-channel socket (ThreadsSocket) only covers the channel
 * you're currently viewing, so this stream is what lets unread badges — the sidebar
 * dot/count AND the PWA app-icon count — light up for messages in channels you don't
 * have open.
 *
 * This consumer owns app-wide aggregate state: unread counters and the process list.
 * Message RENDERING stays owned by the per-channel socket, so nothing is double-added
 * to the timeline; for the channel you're actually viewing we skip the unread bump
 * (you're seeing it) and let channelSession keep last_read in sync.
 */

// Only final, user-visible messages count toward unread — mirrors the server's
// unread SQL and push policy. Keep this as an allow-list so a new trace/tool
// message type cannot silently start affecting badges.
function countsTowardUnread(messageType: string | undefined): boolean {
	return messageType === 'human' || messageType === 'response';
}

function mentionsCurrentUser(message: { mentions?: unknown } | undefined): boolean {
	const userId = auth.user?.id;
	if (!userId || !Array.isArray(message?.mentions)) return false;
	return message.mentions.some((mention: unknown) => {
		if (mention === userId) return true;
		if (!mention || typeof mention !== 'object') return false;
		const fields = mention as { userId?: unknown; user_id?: unknown };
		return fields.userId === userId || fields.user_id === userId;
	});
}

let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
let _generation = 0;
let _pingTimer: ReturnType<typeof setInterval> | null = null;
let _pingSentAt: number | null = null;
let _everConnected = false;

function eventsUrl(): string {
	return `${websocketOrigin()}/events`;
}

/**
 * Bump the unread badge for a new message that landed in a channel/DM the user
 * isn't currently viewing. The `/events` envelope tags every event with `channelId`
 * and `room {id, type}`; the canonical shape is {type:'message', ...} but we also
 * tolerate a nested {type:'new_message', message:{...}} for parity with the
 * per-channel handler.
 */
function handleMessageEvent(data: any) {
	if (data?.type !== 'message' && data?.type !== 'new_message') return;
	const m = data.type === 'new_message' ? (data.message ?? data) : data;
	const channelId: string | undefined = m.channelId ?? m.channel_id ?? data.channelId;
	if (!channelId) return;
	const senderId: string | null = m.userId ?? m.user_id ?? null;
	if (senderId && senderId === auth.user?.id) return;
	const messageType: string | undefined = m.messageType ?? m.message_type;
	if (!countsTowardUnread(messageType)) return;
	// You're looking at it right now (on this device) — no badge.
	if (channelId === channels.selectedId || channelId === dms.selectedId) return;

	const roomType = data.room?.type ?? m.room?.type;
	const dm = roomType === 'dm' ? dms.list.find((item) => item.id === channelId) : undefined;
	const channel = roomType === 'dm' ? undefined : channels.list.find((item) => item.id === channelId);
	const notificationTier = dm?.notifications ?? channel?.notifications ?? 'all';
	if (notificationTier === 'none') return;
	if (notificationTier === 'mentions' && !mentionsCurrentUser(m)) return;

	if (roomType === 'dm') dms.incrementUnread(channelId);
	else channels.incrementUnread(channelId);
	inbox.receive(m, {
		channelName: roomType === 'dm'
			? dm?.partner.display_name || dm?.partner.username || dm?.name || 'Direct message'
			: channel?.name || 'Channel',
		isDm: roomType === 'dm',
		dmPartnerId: dm?.partner.id ?? null,
		dmPartnerUsername: dm?.partner.username ?? null,
		dmPartnerDisplayName: dm?.partner.display_name ?? null,
	});
	updateBadge();
}

function handleAggregateEvent(data: unknown) {
	if (!data || typeof data !== 'object') return;
	const event = data as {
		type?: unknown;
		process?: Partial<Process>;
		id?: unknown;
		resolvedAt?: unknown;
		resolvedBy?: unknown;
	};

	if (event.type === 'process_created' || event.type === 'process_updated') {
		if (event.process) processes.updateFromEvent({ process: event.process });
		return;
	}

	if (event.type === 'message_resolved' && typeof event.id === 'string') {
		const resolvedAt = typeof event.resolvedAt === 'number'
			? event.resolvedAt
			: Math.floor(Date.now() / 1000);
		const resolvedBy = typeof event.resolvedBy === 'string' ? event.resolvedBy : null;
		processes.updateMessageResolution(event.id, resolvedAt, resolvedBy);
		processes.load();
		return;
	}

	if (event.type === 'message_unresolved' && typeof event.id === 'string') {
		processes.updateMessageResolution(event.id, null, null);
		processes.load();
	}
}

export const events = {
	/** Open the global events socket. Safe to call repeatedly; replaces any prior socket. */
	connect() {
		this.disconnect();
		const gen = ++_generation;
		const ws = new WebSocket(eventsUrl());
		_ws = ws;

		ws.onopen = () => {
			if (gen !== _generation) return;
			_reconnectAttempts = 0;
			if (_reconnectTimer) {
				clearTimeout(_reconnectTimer);
				_reconnectTimer = null;
			}
			startPingLoop(gen);
			// After a reconnect, messages delivered while we were down were missed by
			// the live increment path — resync unread from the server's truth. Skipped
			// on the first connect since mount already loads both lists.
			if (_everConnected) {
				channels.load();
				dms.load();
				inbox.load();
				processes.load();
			}
			_everConnected = true;
		};

		ws.onmessage = (event) => {
			if (gen !== _generation) return;
			try {
				const data = JSON.parse(event.data);
				if (data.type === 'pong') {
					_pingSentAt = null;
					return;
				}
				if (data.type === 'events.ready') return;
				handleMessageEvent(data);
				handleAggregateEvent(data);
			} catch {}
		};

		ws.onclose = () => {
			if (gen !== _generation) return;
			stopPingLoop();
			this.scheduleReconnect();
		};

		// Capture the socket: a stale socket's error must not close its successor.
		const sock = ws;
		sock.onerror = () => sock.close();
	},

	disconnect() {
		if (_reconnectTimer) {
			clearTimeout(_reconnectTimer);
			_reconnectTimer = null;
		}
		stopPingLoop();
		const sock = _ws;
		_ws = null;
		sock?.close();
	},

	/** Reconnect if the socket is gone or not open. Used on wake / network online. */
	reconnectIfNeeded() {
		if (_ws?.readyState === WebSocket.OPEN) return;
		this.connect();
	},

	/** @internal */
	scheduleReconnect() {
		if (_reconnectTimer) return;
		_reconnectAttempts++;
		// Exponential backoff with jitter, capped at 30s (same policy as ThreadsSocket).
		const cap = Math.min(30_000, 1000 * 2 ** Math.min(_reconnectAttempts - 1, 5));
		const delay = cap / 2 + Math.random() * (cap / 2);
		_reconnectTimer = setTimeout(() => {
			_reconnectTimer = null;
			this.connect();
		}, delay);
	},
};

function startPingLoop(gen: number) {
	stopPingLoop();
	// Client-initiated app-level keepalive: /events replies {type:'pong'} to our
	// {type:'ping'} (protocol ping/pong is unreliable through the edge proxy).
	_pingTimer = setInterval(() => {
		if (gen !== _generation) {
			stopPingLoop();
			return;
		}
		if (_ws?.readyState !== WebSocket.OPEN) return;
		// Zombie detection: after OS sleep a dead socket can stay OPEN forever. If the
		// previous ping never got a pong, force-close so onclose reconnects.
		if (_pingSentAt !== null) {
			_ws.close();
			return;
		}
		_pingSentAt = Date.now();
		try {
			_ws.send(JSON.stringify({ type: 'ping' }));
		} catch {}
	}, 30_000);
}

function stopPingLoop() {
	if (_pingTimer) {
		clearInterval(_pingTimer);
		_pingTimer = null;
	}
	_pingSentAt = null;
}
