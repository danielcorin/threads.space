import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/auth.svelte.js', () => ({
	auth: { user: { id: 'me', username: 'me' } }
}));

vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		list: [] as any[],
		selectedId: null as string | null,
		load: vi.fn().mockResolvedValue(undefined),
		incrementUnread: vi.fn()
	}
}));

vi.mock('$lib/state/dms.svelte.js', () => ({
	dms: {
		list: [] as any[],
		selectedId: null as string | null,
		load: vi.fn().mockResolvedValue(undefined),
		incrementUnread: vi.fn()
	}
}));

vi.mock('$lib/state/processes.svelte.js', () => ({
	processes: {
		load: vi.fn().mockResolvedValue(undefined),
		updateFromEvent: vi.fn(),
		updateMessageResolution: vi.fn()
	}
}));

vi.mock('$lib/state/inbox.svelte.js', () => ({
	inbox: {
		load: vi.fn().mockResolvedValue(undefined),
		receive: vi.fn()
	}
}));

vi.mock('$lib/badge.js', () => ({
	updateBadge: vi.fn()
}));

vi.mock('$lib/ws-url.js', () => ({
	websocketOrigin: () => 'ws://threads.test'
}));

import { updateBadge } from '$lib/badge.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import { processes } from '$lib/state/processes.svelte.js';
import { inbox } from '$lib/state/inbox.svelte.js';
import { events } from './events.svelte.js';

class FakeWebSocket {
	static OPEN = 1;
	static instances: FakeWebSocket[] = [];

	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}

	close() {
		this.readyState = 3;
	}

	send() {}

	emit(data: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}

function currentSocket(): FakeWebSocket {
	events.connect();
	return FakeWebSocket.instances.at(-1)!;
}

function message(messageType?: string, overrides: Record<string, unknown> = {}) {
	return {
		type: 'message',
		id: crypto.randomUUID(),
		channelId: 'channel-1',
		userId: 'someone-else',
		threadId: null,
		room: { id: 'channel-1', type: 'channel' },
		...(messageType === undefined ? {} : { messageType }),
		...overrides,
	};
}

describe('global events', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket);
		(channels as any).list = [{ id: 'channel-1', notifications: 'all', unread_count: 0 }];
		(channels as any).selectedId = null;
		(dms as any).list = [];
		(dms as any).selectedId = null;
		vi.mocked(processes.load).mockClear();
		vi.mocked(processes.updateFromEvent).mockClear();
		vi.mocked(processes.updateMessageResolution).mockClear();
		vi.mocked(inbox.load).mockClear();
		vi.mocked(inbox.receive).mockClear();
	});

	afterEach(() => {
		events.disconnect();
		vi.unstubAllGlobals();
	});

	it('does not count progress, thinking, tool output, or unknown message types', () => {
		const socket = currentSocket();

		for (const type of ['progress', 'thinking', 'tool_output', 'tool_call', undefined]) {
			socket.emit(message(type));
		}

		expect(channels.incrementUnread).not.toHaveBeenCalled();
		expect(updateBadge).not.toHaveBeenCalled();
	});

	it('counts only human and response messages', () => {
		const socket = currentSocket();

		socket.emit(message('human'));
		socket.emit(message('response'));

		expect(channels.incrementUnread).toHaveBeenCalledTimes(2);
		expect(updateBadge).toHaveBeenCalledTimes(2);
		expect(inbox.receive).toHaveBeenCalledTimes(2);
	});

	it('counts final messages inside threads', () => {
		const socket = currentSocket();

		socket.emit(message('human', { threadId: 'thread-root' }));
		socket.emit(message('response', { threadId: 'thread-root' }));

		expect(channels.incrementUnread).toHaveBeenCalledTimes(2);
		expect(inbox.receive).toHaveBeenCalledTimes(2);
	});

	it('applies the channel notification tier to live unread counters', () => {
		const socket = currentSocket();
		const channel = (channels as any).list[0];

		channel.notifications = 'none';
		socket.emit(message('human'));

		channel.notifications = 'mentions';
		socket.emit(message('human'));
		socket.emit(message('human', { mentions: [{ userId: 'me', username: 'me' }] }));

		expect(channels.incrementUnread).toHaveBeenCalledTimes(1);
		expect(updateBadge).toHaveBeenCalledTimes(1);
	});

	it('routes global process lifecycle events to the process store', () => {
		const socket = currentSocket();
		const created = {
			type: 'process_created',
			channelId: 'channel-1',
			process: { id: 'process-1', channel_id: 'channel-1', status: 'running' }
		};
		const updated = {
			type: 'process_updated',
			channelId: 'channel-1',
			process: { id: 'process-1', channel_id: 'channel-1', status: 'done' }
		};

		socket.emit(created);
		socket.emit(updated);

		expect(processes.updateFromEvent).toHaveBeenNthCalledWith(1, { process: created.process });
		expect(processes.updateFromEvent).toHaveBeenNthCalledWith(2, { process: updated.process });
	});

	it('keeps process resolution metadata live from the global stream', () => {
		const socket = currentSocket();

		socket.emit({
			type: 'message_resolved',
			channelId: 'channel-1',
			id: 'message-1',
			resolvedAt: 123,
			resolvedBy: 'user-1'
		});
		socket.emit({
			type: 'message_unresolved',
			channelId: 'channel-1',
			id: 'message-1'
		});

		expect(processes.updateMessageResolution).toHaveBeenNthCalledWith(1, 'message-1', 123, 'user-1');
		expect(processes.updateMessageResolution).toHaveBeenNthCalledWith(2, 'message-1', null, null);
		expect(processes.load).toHaveBeenCalledTimes(2);
	});

	it('reloads processes after the global event stream reconnects', () => {
		const first = currentSocket();
		first.readyState = FakeWebSocket.OPEN;
		first.onopen?.();
		const callsAfterFirstConnection = vi.mocked(processes.load).mock.calls.length;

		const second = currentSocket();
		second.readyState = FakeWebSocket.OPEN;
		second.onopen?.();

		expect(processes.load).toHaveBeenCalledTimes(callsAfterFirstConnection + 1);
		expect(inbox.load).toHaveBeenCalledTimes(1);
	});
});
