import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	markRead: vi.fn(),
	reply: vi.fn(),
	channelDecrement: vi.fn(),
	dmDecrement: vi.fn(),
}));

vi.mock('$lib/api.js', () => ({
	api: {
		inbox: { list: mocks.list },
		messages: { markRead: mocks.markRead, reply: mocks.reply },
	}
}));

vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: { decrementUnread: mocks.channelDecrement }
}));

vi.mock('$lib/state/dms.svelte.js', () => ({
	dms: { decrementUnread: mocks.dmDecrement }
}));

import { inbox } from './inbox.svelte.js';

function message(overrides: Record<string, unknown> = {}) {
	return {
		id: 'message-1',
		channel_id: 'channel-1',
		channel_name: 'general',
		is_dm: 0,
		user_id: 'sender-1',
		content: 'hello',
		thread_id: null,
		type: 'message',
		edited_at: null,
		deleted_at: null,
		created_at: 1,
		...overrides,
	};
}

describe('inbox state', () => {
	beforeEach(() => {
		inbox.clear();
		vi.clearAllMocks();
		mocks.list.mockResolvedValue({ messages: [message()], total: 1, cursor: null });
		mocks.markRead.mockResolvedValue({ ok: true });
		mocks.reply.mockResolvedValue({ id: 'reply-1' });
	});

	it('loads messages without acknowledging them', async () => {
		await inbox.load();

		expect(inbox.total).toBe(1);
		expect(inbox.list.map((item) => item.id)).toEqual(['message-1']);
		expect(mocks.markRead).not.toHaveBeenCalled();
	});

	it('removes only the acknowledged message and updates its channel count', async () => {
		mocks.list.mockResolvedValue({
			messages: [message(), message({ id: 'message-2' })],
			total: 2,
			cursor: null,
		});
		await inbox.load();
		await inbox.markRead('message-1');

		expect(inbox.list.map((item) => item.id)).toEqual(['message-2']);
		expect(inbox.total).toBe(1);
		expect(mocks.channelDecrement).toHaveBeenCalledWith('channel-1');
	});

	it('acknowledges a message only after its reply succeeds', async () => {
		await inbox.load();
		await inbox.reply('message-1', 'reply text');

		expect(mocks.reply).toHaveBeenCalledWith('message-1', 'reply text', expect.any(String));
		expect(mocks.markRead).toHaveBeenCalledWith('message-1');
		expect(inbox.total).toBe(0);
	});

	it('keeps the message unread when its reply fails', async () => {
		mocks.reply.mockRejectedValueOnce(new Error('send failed'));
		await inbox.load();

		await expect(inbox.reply('message-1', 'reply text')).rejects.toThrow('send failed');
		expect(mocks.markRead).not.toHaveBeenCalled();
		expect(inbox.total).toBe(1);
	});
});
