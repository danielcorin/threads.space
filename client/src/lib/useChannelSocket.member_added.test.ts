import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/state/auth.svelte.js', () => ({
	auth: { user: { id: 'me' } }
}));

vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		list: [{ id: 'current-ch' }],
		load: vi.fn(),
		selectedId: 'current-ch',
		incrementUnread: vi.fn()
	}
}));

vi.mock('$lib/state/messages.svelte.js', () => ({
	messages: {
		addMessage: vi.fn(),
		incrementReplyCount: vi.fn(),
		updateMessage: vi.fn(),
		updateThreadProcessStatus: vi.fn()
	}
}));

vi.mock('$lib/state/thread.svelte.js', () => ({
	thread: {
		addReply: vi.fn(),
		updateReply: vi.fn()
	}
}));

vi.mock('$lib/state/processes.svelte.js', () => ({
	processes: {
		load: vi.fn(),
		addProcess: vi.fn(),
		updateProcess: vi.fn(),
		removeProcess: vi.fn()
	}
}));

vi.mock('$lib/state/board.svelte.js', () => ({
	board: {
		handleBoardUpdated: vi.fn(),
		handleCardCreated: vi.fn(),
		handleCardUpdated: vi.fn(),
		handleCardDeleted: vi.fn()
	}
}));

vi.mock('$lib/state/pins.svelte.js', () => ({
	pins: {
		handlePinned: vi.fn(),
		handleUnpinned: vi.fn()
	}
}));

vi.mock('$lib/badge.js', () => ({
	updateBadge: vi.fn()
}));

vi.mock('$lib/api.js', () => ({
	api: {
		channels: { markRead: vi.fn().mockResolvedValue(undefined) }
	}
}));

import { setupChannelSocket } from './useChannelSocket.js';
import { channels } from '$lib/state/channels.svelte.js';
import { messages } from '$lib/state/messages.svelte.js';
import { thread } from '$lib/state/thread.svelte.js';

type Handler = (data: any) => void;

function makeWs() {
	const handlers: Record<string, Handler> = {};
	return {
		on: (event: string, cb: Handler) => {
			handlers[event] = cb;
			return () => { delete handlers[event]; };
		},
		emit: (event: string, data: any) => handlers[event]?.(data)
	};
}

describe('useChannelSocket member_added', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(channels as any).list = [{ id: 'current-ch' }];
	});

	it('refreshes the channel list when I am added to a channel not in my sidebar', () => {
		const ws = makeWs();
		setupChannelSocket(ws as any, 'current-ch', () => [], () => {}, {});

		ws.emit('member_added', { channelId: 'new-ch', targetUserId: 'me' });

		expect(channels.load).toHaveBeenCalledTimes(1);
	});

	it('does not refresh when I am added to a channel already in my sidebar', () => {
		(channels as any).list = [{ id: 'current-ch' }, { id: 'new-ch' }];
		const ws = makeWs();
		setupChannelSocket(ws as any, 'current-ch', () => [], () => {}, {});

		ws.emit('member_added', { channelId: 'new-ch', targetUserId: 'me' });

		expect(channels.load).not.toHaveBeenCalled();
	});

	it('does not refresh when someone else is added', () => {
		const ws = makeWs();
		setupChannelSocket(ws as any, 'current-ch', () => [], () => {}, {});

		ws.emit('member_added', { channelId: 'new-ch', targetUserId: 'someone-else' });

		expect(channels.load).not.toHaveBeenCalled();
	});

	it("still fires onMemberAdded for the socket's own channel", () => {
		const onMemberAdded = vi.fn();
		const ws = makeWs();
		setupChannelSocket(ws as any, 'current-ch', () => [], () => {}, { onMemberAdded });

		ws.emit('member_added', { channelId: 'current-ch', targetUserId: 'someone-else', username: 'bob' });

		expect(onMemberAdded).toHaveBeenCalledTimes(1);
		expect(channels.load).not.toHaveBeenCalled();
	});

	it('applies thread title updates to the channel and open-thread stores', () => {
		const ws = makeWs();
		setupChannelSocket(ws as any, 'current-ch', () => [], () => {}, {});

		ws.emit('thread_title_updated', {
			channelId: 'current-ch',
			threadId: 'root-1',
			title: 'A readable title',
			updatedAt: 1234
		});

		const updates = {
			thread_title: 'A readable title',
			thread_title_updated_at: 1234
		};
		expect(messages.updateMessage).toHaveBeenCalledWith('root-1', updates);
		expect(thread.updateReply).toHaveBeenCalledWith('root-1', updates);
	});
});
