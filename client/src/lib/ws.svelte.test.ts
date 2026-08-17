import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThreadsSocket } from './ws.svelte.js';

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code: 1006, reason: '' });
	}

	// --- test helpers ---
	simulateOpen() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	simulateMessage(obj: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}

	lastSentOfType(type: string): boolean {
		return this.sent.some((s) => JSON.parse(s).type === type);
	}
}

describe('ThreadsSocket resilience', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('schedules a reconnect after an unclean close and emits "reconnected" on reopen', () => {
		const socket = new ThreadsSocket();
		const reconnected = vi.fn();
		socket.on('reconnected', reconnected);

		socket.connect('chan-1');
		const first = FakeWebSocket.instances[0];
		first.simulateOpen();
		expect(socket.connected).toBe(true);

		// Network blip: unclean close
		first.close();
		expect(socket.connected).toBe(false);

		// Backoff delay for the first attempt is at most 1s
		vi.advanceTimersByTime(1_000);
		expect(FakeWebSocket.instances.length).toBe(2);

		FakeWebSocket.instances[1].simulateOpen();
		expect(reconnected).toHaveBeenCalledWith({ type: 'reconnected', channelId: 'chan-1' });
	});

	it('does not emit "reconnected" on a fresh connect', () => {
		const socket = new ThreadsSocket();
		const reconnected = vi.fn();
		socket.on('reconnected', reconnected);

		socket.connect('chan-1');
		FakeWebSocket.instances[0].simulateOpen();
		expect(reconnected).not.toHaveBeenCalled();
	});

	it('connects directly to the local API worker instead of the Vite websocket proxy', () => {
		const socket = new ThreadsSocket();

		socket.connect('chan-1');

		const host = location.hostname === '::1' ? '[::1]' : location.hostname;
		expect(FakeWebSocket.instances[0].url).toBe(`ws://${host}:8788/ws/chan-1`);
	});

	it('uses exponential backoff between reconnect attempts', () => {
		const socket = new ThreadsSocket();
		socket.connect('chan-1');
		const first = FakeWebSocket.instances[0];
		first.simulateOpen();
		first.close();

		// Attempt 1: cap 1s
		vi.advanceTimersByTime(1_000);
		expect(FakeWebSocket.instances.length).toBe(2);
		// Connection fails again (never opens, just closes)
		FakeWebSocket.instances[1].close();

		// Attempt 2: cap 2s — after only 0.9s no new socket may exist yet
		// (minimum delay is cap/2 = 1s)
		vi.advanceTimersByTime(900);
		expect(FakeWebSocket.instances.length).toBe(2);
		vi.advanceTimersByTime(1_100);
		expect(FakeWebSocket.instances.length).toBe(3);
	});

	it('force-closes a zombie socket when a ping gets no pong by the next tick', () => {
		const socket = new ThreadsSocket();
		socket.connect('chan-1');
		const ws = FakeWebSocket.instances[0];
		ws.simulateOpen();

		// First ping tick
		vi.advanceTimersByTime(30_000);
		expect(ws.lastSentOfType('ping')).toBe(true);

		// No pong arrives. Next tick must force-close the zombie.
		vi.advanceTimersByTime(30_000);
		expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
		expect(socket.connected).toBe(false);
	});

	it('keeps the socket open when pongs arrive', () => {
		const socket = new ThreadsSocket();
		socket.connect('chan-1');
		const ws = FakeWebSocket.instances[0];
		ws.simulateOpen();

		vi.advanceTimersByTime(30_000);
		ws.simulateMessage({ type: 'pong' });
		vi.advanceTimersByTime(30_000);
		expect(ws.readyState).toBe(FakeWebSocket.OPEN);
		expect(socket.connected).toBe(true);
		// Two pings sent, no close
		expect(ws.sent.filter((s) => JSON.parse(s).type === 'ping').length).toBe(2);
	});

	it('a stale socket error does not close its successor', () => {
		const socket = new ThreadsSocket();
		socket.connect('chan-1');
		const first = FakeWebSocket.instances[0];

		// Switch channels: a second socket replaces the first
		socket.connect('chan-2');
		const second = FakeWebSocket.instances[1];
		second.simulateOpen();

		// The stale socket errors late
		first.onerror?.();
		expect(second.readyState).toBe(FakeWebSocket.OPEN);
		expect(socket.connected).toBe(true);
	});
});
