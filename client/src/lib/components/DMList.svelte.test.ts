import { render } from 'vitest-browser-svelte';
import { expect, test, vi, describe, beforeEach } from 'vitest';

const mockDms: any[] = [];
let mockSelectedId: string | null = null;

vi.mock('$lib/state/dms.svelte.js', () => ({
	dms: {
		get list() { return mockDms; },
		get selectedId() { return mockSelectedId; },
		get loading() { return false; },
		select: vi.fn(),
		hide: vi.fn(),
	}
}));

vi.mock('$lib/state/ui.svelte.js', () => ({
	ui: {
		get isMobile() { return false; },
		closeSidebar: vi.fn()
	}
}));

const mockOnlineUsers = new Set<string>();
const mockActiveChannelIds = new Set<string>();

vi.mock('$lib/state/presence.svelte.js', () => ({
	presence: {
		isOnline: (id: string) => mockOnlineUsers.has(id),
	}
}));

vi.mock('$lib/state/processes.svelte.js', () => ({
	processes: {
		get activeChannelIds() { return mockActiveChannelIds; }
	}
}));

vi.mock('$lib/useLongPressDrag.js', () => ({
	createLongPressDrag: () => ({
		onMouseDown: vi.fn(),
		onTouchStart: vi.fn(),
		onTouchMove: vi.fn(),
		onTouchEnd: vi.fn(),
		onTouchCancel: vi.fn(),
	})
}));

import DMList from './DMList.svelte';

function makeDm(overrides: Partial<any> = {}): any {
	return {
		id: 'dm-1',
		name: 'test-dm',
		is_dm: 1,
		is_private: 1,
		dm_partner_id: 'user-1',
		created_at: 0,
		position: 0,
		has_unread: 0,
		unread_count: 0,
		last_read_message_id: null,
		last_message_content: null,
		last_message_at: null,
		partner: {
			id: 'user-1',
			username: 'alice',
			display_name: 'Alice',
			name_color: null,
			role: 'user',
		},
		...overrides,
	};
}

describe('DMList', () => {
	beforeEach(() => {
		mockDms.length = 0;
		mockSelectedId = null;
		mockOnlineUsers.clear();
		mockActiveChannelIds.clear();
	});

	test('renders human DM partner without restart controls', async () => {
		mockDms.push(makeDm());
		const screen = render(DMList, { props: { onnewdm: vi.fn() } });

		await expect.element(screen.getByText('Alice')).toBeInTheDocument();
		expect(screen.getByText('Alice').element().closest('button'))
			.toHaveAttribute('data-sidebar-conversation-id', 'dm-1');
		expect(screen.container.querySelector('[title="Restart bot"], [title="Bot offline"]')).toBeNull();
	});

	test('renders bot DM partner without restart controls', async () => {
		mockDms.push(makeDm({
			id: 'dm-bot',
			partner: { id: 'bot-1', username: 'filae', display_name: 'Filae', name_color: null, role: 'bot' },
		}));
		mockOnlineUsers.add('bot-1');
		const screen = render(DMList, { props: { onnewdm: vi.fn() } });

		await expect.element(screen.getByText('Filae')).toBeInTheDocument();
		expect(screen.container.querySelector('[title="Restart bot"], [title="Bot offline"]')).toBeNull();
	});

	test('colors a bot DM indicator amber while the bot is responding', async () => {
		mockDms.push(makeDm({
			id: 'dm-bot',
			partner: { id: 'bot-1', username: 'filae', display_name: 'Filae', name_color: null, role: 'bot' },
		}));
		mockOnlineUsers.add('bot-1');
		mockActiveChannelIds.add('dm-bot');

		const screen = render(DMList, { props: { onnewdm: vi.fn() } });

		const indicator = screen.getByTitle('Bot is responding');
		await expect.element(indicator).toBeInTheDocument();
		expect(indicator.element().firstElementChild).toHaveClass('bg-[#f59e0b]');
	});

	test('does not show a human DM as responding when its channel has an active process', async () => {
		mockDms.push(makeDm());
		mockOnlineUsers.add('user-1');
		mockActiveChannelIds.add('dm-1');

		const screen = render(DMList, { props: { onnewdm: vi.fn() } });

		await expect.element(screen.getByText('Alice')).toBeInTheDocument();
		expect(screen.container.querySelector('[title="Bot is responding"]')).toBeNull();
		expect(screen.container.querySelector('.bg-green-500')).not.toBeNull();
	});
});
