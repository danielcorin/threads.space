import { API_BASE } from '$lib/api.js';
import { websocketOrigin } from '$lib/ws-url.js';

/** Reactive presence state — tracks which users are online via a dedicated WebSocket. */

let _online = $state<Record<string, boolean>>({});
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _reconnectAttempts = 0;
let _generation = 0;
let _lastServerEventAt = 0;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;
let _lastActivitySentAt = 0;

// The server heartbeats every 30s; three missed pings means the socket is a
// post-sleep zombie that still reports OPEN.
const STALE_SOCKET_MS = 90_000;

export const presence = {
	/** Check if a user is online */
	isOnline(userId: string): boolean {
		return !!_online[userId];
	},

	/** Connect to the presence WebSocket */
	connect() {
		this.disconnect();
		const gen = ++_generation;
		// Let the first input after a (re)connect re-confirm activity immediately.
		_lastActivitySentAt = 0;

		const wsUrl = `${websocketOrigin()}/ws/presence`;

		const ws = new WebSocket(wsUrl);
		_ws = ws;
		_lastServerEventAt = Date.now();
		this.startWatchdog(gen);

		ws.onopen = () => {
			if (gen !== _generation) return;
			_reconnectAttempts = 0;
			_lastServerEventAt = Date.now();
			if (_reconnectTimer) {
				clearTimeout(_reconnectTimer);
				_reconnectTimer = null;
			}
		};

		ws.onmessage = (event) => {
			if (gen !== _generation) return;
			_lastServerEventAt = Date.now();
			try {
				const data = JSON.parse(event.data);
				if (data.type === 'ping') {
					ws.send(JSON.stringify({ type: 'pong' }));
					return;
				}
				if (data.type === 'presence_snapshot') {
					// Merge snapshot into state
					const users = data.users as Record<string, boolean>;
					_online = { ..._online, ...users };
					return;
				}
				if (data.type === 'presence_update') {
					_online = { ..._online, [data.userId]: data.online };
				}
			} catch {}
		};

		ws.onclose = () => {
			if (gen !== _generation) return;
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			ws.close();
		};
	},

	/** Disconnect from presence WebSocket */
	disconnect() {
		if (_reconnectTimer) {
			clearTimeout(_reconnectTimer);
			_reconnectTimer = null;
		}
		if (_watchdogTimer) {
			clearInterval(_watchdogTimer);
			_watchdogTimer = null;
		}
		_ws?.close();
		_ws = null;
		_online = {};
	},

	/**
	 * Report user input (a click or keystroke) so the server marks this client
	 * "active" and withholds push notifications while the app is in use. Liveness
	 * is global — this rides the always-connected presence socket, so being active
	 * in any channel (or none) suppresses push everywhere for this user. Throttled
	 * to a trickle: the server's idle window (60s) dwarfs this interval, so one
	 * heartbeat per window is plenty. No-op until the presence socket is open.
	 */
	sendActivity() {
		if (_ws?.readyState !== WebSocket.OPEN) return;
		const now = Date.now();
		if (now - _lastActivitySentAt < 15_000) return;
		_lastActivitySentAt = now;
		try {
			_ws.send(JSON.stringify({ type: 'activity' }));
		} catch {}
	},

	/** Reconnect if the socket is gone or not open. Used on wake / network online. */
	reconnectIfNeeded() {
		if (_ws?.readyState === WebSocket.OPEN) return;
		this.connect();
	},

	/** Seed presence from a batch REST fetch */
	async seed(userIds: string[]) {
		if (userIds.length === 0) return;
		try {
			const res = await fetch(`${API_BASE}/presence?userIds=${userIds.join(',')}`, {
				credentials: 'include',
			});
			if (res.ok) {
				const data = (await res.json()) as Record<string, boolean>;
				_online = { ..._online, ...data };
			}
		} catch {}
	},

	/** @internal */
	scheduleReconnect() {
		if (_reconnectTimer) return;
		_reconnectAttempts++;
		// Exponential backoff with jitter, capped at 30s (same policy as ThreadsSocket)
		const cap = Math.min(30_000, 1000 * 2 ** Math.min(_reconnectAttempts - 1, 5));
		const delay = cap / 2 + Math.random() * (cap / 2);
		_reconnectTimer = setTimeout(() => {
			_reconnectTimer = null;
			this.connect();
		}, delay);
	},

	/** @internal Force-close zombie sockets that stopped receiving server heartbeats. */
	startWatchdog(gen: number) {
		if (_watchdogTimer) clearInterval(_watchdogTimer);
		_watchdogTimer = setInterval(() => {
			if (gen !== _generation) return;
			if (_ws?.readyState === WebSocket.OPEN && Date.now() - _lastServerEventAt > STALE_SOCKET_MS) {
				_ws.close();
			}
		}, 30_000);
	},
};
