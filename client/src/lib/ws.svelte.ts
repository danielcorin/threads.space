import { websocketOrigin } from '$lib/ws-url.js';

type MessageHandler = (data: any) => void;

export class ThreadsSocket {
	private ws: WebSocket | null = null;
	private handlers = new Map<string, Set<MessageHandler>>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private channelId: string | null = null;
	private _connected = $state(false);
	private _generation = 0;

	// --- Debug observables ---
	private _lastEventAt = $state<number | null>(null);
	private _reconnectAttempts = $state(0);
	private _lastCloseCode = $state<number | null>(null);
	private _lastCloseReason = $state<string | null>(null);
	private _wsUrl = $state<string | null>(null);
	private _readyState = $state<number>(WebSocket.CLOSED);
	private _lastPingRtt = $state<number | null>(null);
	private _pingRttSamples: number[] = [];
	private _pingTimer: ReturnType<typeof setTimeout> | null = null;
	private _pingSentAt: number | null = null;

	get connected() {
		return this._connected;
	}

	// --- Debug getters ---
	get lastEventAt() { return this._lastEventAt; }
	get reconnectAttempts() { return this._reconnectAttempts; }
	get lastCloseCode() { return this._lastCloseCode; }
	get lastCloseReason() { return this._lastCloseReason; }
	get wsUrl() { return this._wsUrl; }
	get readyState() { return this._readyState; }
	get lastPingRtt() { return this._lastPingRtt; }
	get avgPingRtt() {
		if (this._pingRttSamples.length === 0) return null;
		return Math.round(this._pingRttSamples.reduce((a, b) => a + b, 0) / this._pingRttSamples.length);
	}

	connect(channelId: string, isReconnect = false) {
		this.disconnect();
		this.channelId = channelId;
		const gen = ++this._generation;
		const wsUrl = `${websocketOrigin()}/ws/${channelId}`;
		this._wsUrl = wsUrl;
		this._readyState = WebSocket.CONNECTING;
		this.ws = new WebSocket(wsUrl);

		this.ws.onopen = () => {
			if (gen !== this._generation) return;
			this._connected = true;
			this._readyState = WebSocket.OPEN;
			this._reconnectAttempts = 0;
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
			this.startPingLoop(gen);
			// Messages broadcast while the socket was down are gone; let
			// subscribers (channel session) page the gap from the REST API.
			if (isReconnect) {
				this.dispatch({ type: 'reconnected', channelId });
			}
		};

		this.ws.onmessage = (event) => {
			if (gen !== this._generation) return;
			this._lastEventAt = Date.now();
			try {
				const data = JSON.parse(event.data);

				// Handle pong responses for RTT measurement
				if (data.type === 'pong' && this._pingSentAt) {
					const rtt = Date.now() - this._pingSentAt;
					this._lastPingRtt = rtt;
					this._pingRttSamples.push(rtt);
					if (this._pingRttSamples.length > 10) this._pingRttSamples.shift();
					this._pingSentAt = null;
					return;
				}

				this.dispatch(data);
			} catch (e) {
				console.error('WebSocket message parse error:', e);
			}
		};

		this.ws.onclose = (event) => {
			if (gen !== this._generation) return;
			this._connected = false;
			this._readyState = WebSocket.CLOSED;
			this._lastCloseCode = event.code;
			this._lastCloseReason = event.reason || null;
			this.stopPingLoop();
			this.scheduleReconnect();
		};

		// Capture the socket: a stale socket's error must not close its successor.
		const sock = this.ws;
		sock.onerror = () => {
			sock.close();
		};
	}

	private dispatch(data: any) {
		const handlers = this.handlers.get(data.type);
		if (handlers) {
			for (const handler of handlers) handler(data);
		}
		// Also fire wildcard handlers
		const wildcards = this.handlers.get('*');
		if (wildcards) {
			for (const handler of wildcards) handler(data);
		}
	}

	disconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.stopPingLoop();
		// Null the channel before closing: if the close event fires re-entrantly
		// it must not schedule a reconnect for a channel we're leaving.
		this.channelId = null;
		const sock = this.ws;
		this.ws = null;
		sock?.close();
		this._connected = false;
		this._readyState = WebSocket.CLOSED;
	}

	on(type: string, handler: MessageHandler) {
		if (!this.handlers.has(type)) this.handlers.set(type, new Set());
		this.handlers.get(type)!.add(handler);
		return () => this.handlers.get(type)?.delete(handler);
	}

	send(data: Record<string, unknown>) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		}
	}

	sendTypingStart(threadId: string | null = null) {
		this.send({ type: 'typing_start', threadId });
	}

	sendTypingStop(threadId: string | null = null) {
		this.send({ type: 'typing_stop', threadId });
	}

	sendMarkRead(messageId: string) {
		this.send({ type: 'mark_read', messageId });
	}

	/** Reconnect to the current channel if the socket is not open. Returns true if a reconnect was triggered. */
	reconnectIfNeeded(): boolean {
		if (!this.channelId) return false;
		if (this.ws?.readyState === WebSocket.OPEN) return false;
		this.connect(this.channelId, true);
		return true;
	}

	private scheduleReconnect() {
		if (this.reconnectTimer || !this.channelId) return;
		this._reconnectAttempts++;
		// Exponential backoff with jitter: 1s, 2s, 4s ... capped at 30s, each
		// randomized to 50-100% so reconnecting clients don't stampede the server.
		const cap = Math.min(30_000, 1000 * 2 ** Math.min(this._reconnectAttempts - 1, 5));
		const delay = cap / 2 + Math.random() * (cap / 2);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.channelId) this.connect(this.channelId, true);
		}, delay);
	}

	private startPingLoop(gen: number) {
		this.stopPingLoop();
		this._pingTimer = setInterval(() => {
			if (gen !== this._generation) { this.stopPingLoop(); return; }
			if (this.ws?.readyState !== WebSocket.OPEN) return;
			// Zombie detection: after OS sleep a dead socket can stay OPEN
			// forever. If the previous ping never got a pong, force-close so
			// the onclose path reconnects and refetches the gap.
			if (this._pingSentAt !== null) {
				this.ws.close();
				return;
			}
			this._pingSentAt = Date.now();
			this.ws.send(JSON.stringify({ type: 'ping' }));
		}, 30_000);
	}

	private stopPingLoop() {
		if (this._pingTimer) {
			clearInterval(this._pingTimer);
			this._pingTimer = null;
		}
		this._pingSentAt = null;
	}
}
