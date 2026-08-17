import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const mockInbox = vi.hoisted(() => ({
	list: [] as any[],
	total: 0,
	load: vi.fn().mockResolvedValue(undefined),
	loadMore: vi.fn().mockResolvedValue(undefined),
	markRead: vi.fn().mockResolvedValue(undefined),
	reply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/state/inbox.svelte.js', () => ({
	inbox: {
		get list() { return mockInbox.list; },
		get total() { return mockInbox.total; },
		get loading() { return false; },
		get loadingMore() { return false; },
		get hasMore() { return false; },
		get loadError() { return false; },
		get loaded() { return true; },
		load: mockInbox.load,
		loadMore: mockInbox.loadMore,
		markRead: mockInbox.markRead,
		reply: mockInbox.reply,
	}
}));

vi.mock('$lib/utils/markdown.js', () => ({
	renderMarkdown: (content: string) => content,
}));

import InboxPage from './InboxPage.svelte';

function message(overrides: Record<string, unknown> = {}) {
	return {
		id: 'message-1',
		channel_id: 'channel-1',
		channel_name: 'general',
		is_dm: 0,
		dm_partner_id: null,
		user_id: 'sender-1',
		username: 'alice',
		display_name: 'Alice',
		name_color: null,
		content: 'Inbox message body',
		thread_id: 'thread-root',
		type: 'message',
		edited_at: null,
		deleted_at: null,
		created_at: Math.floor(Date.now() / 1000),
		attachments: [],
		...overrides,
	};
}

describe('InboxPage', () => {
	beforeEach(() => {
		mockInbox.list = [message()];
		mockInbox.total = 1;
		vi.clearAllMocks();
	});

	it('loads without acknowledging messages and identifies thread replies', async () => {
		const screen = render(InboxPage);

		await expect.element(screen.getByText('Inbox message body')).toBeInTheDocument();
		await expect.element(screen.getByText('#general · Thread')).toBeInTheDocument();
		expect(mockInbox.load).toHaveBeenCalledOnce();
		expect(mockInbox.markRead).not.toHaveBeenCalled();
	});

	it('marks an individual message read', async () => {
		const screen = render(InboxPage);
		await screen.getByText('Mark read').click();

		expect(mockInbox.markRead).toHaveBeenCalledWith('message-1');
	});

	it('sends an inline reply through the Inbox action', async () => {
		const screen = render(InboxPage);
		await screen.getByText('Reply', { exact: true }).click();
		await screen.getByPlaceholder('Write a reply…').fill('Following up');
		await screen.getByText('Send reply').click();

		expect(mockInbox.reply).toHaveBeenCalledWith('message-1', 'Following up');
	});
});
