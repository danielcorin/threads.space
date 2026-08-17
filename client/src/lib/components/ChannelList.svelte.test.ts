import { render } from 'vitest-browser-svelte';
import { expect, test, vi, describe, beforeEach } from 'vitest';

const mockSidebarState = vi.hoisted(() => ({
	channels: [] as Array<{
		id: string;
		name: string;
		description: string | null;
		is_private: number;
		has_unread: number;
		unread_count: number;
		is_ephemeral?: number;
	}>,
	unfiledChannelIds: [] as string[],
	folders: [] as Array<{ id: string; name: string; collapsed: number; channels: string[] }>,
	activeChannelIds: new Set<string>()
}));

// Mock all the stores ChannelList depends on
vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		get list() { return mockSidebarState.channels; },
		get loading() { return false; },
		get selectedId() { return null; },
		select: vi.fn(),
	}
}));

vi.mock('$lib/state/folders.svelte.js', () => ({
	folders: {
		get list() { return mockSidebarState.folders; },
		get unfiledChannelIds() { return mockSidebarState.unfiledChannelIds; },
		toggleCollapsed: vi.fn((folderId: string) => {
			const folder = mockSidebarState.folders.find((item) => item.id === folderId);
			if (folder) folder.collapsed = folder.collapsed ? 0 : 1;
		}),
		moveChannel: vi.fn(),
		moveFolder: vi.fn(),
		rename: vi.fn(),
		delete: vi.fn(),
		create: vi.fn(),
	},
}));

vi.mock('$lib/state/drafts.svelte.js', () => ({
	drafts: {
		has: vi.fn(() => false)
	}
}));

vi.mock('$lib/state/processes.svelte.js', () => ({
	processes: {
		get activeChannelIds() { return mockSidebarState.activeChannelIds; }
	}
}));

vi.mock('$lib/state/ui.svelte.js', () => ({
	ui: {
		get isMobile() { return false; },
		closeSidebar: vi.fn()
	}
}));

import ChannelList from './ChannelList.svelte';

describe('ChannelList', () => {
	beforeEach(() => {
		mockSidebarState.channels = [];
		mockSidebarState.unfiledChannelIds = [];
		mockSidebarState.folders = [];
		mockSidebarState.activeChannelIds.clear();
		vi.clearAllMocks();
	});

	test('expands a collapsed folder to reveal a hotkey-selected channel', async () => {
		mockSidebarState.channels = [{
			id: 'channel-1',
			name: 'general',
			description: null,
			is_private: 0,
			has_unread: 1,
			unread_count: 1
		}];
		mockSidebarState.folders = [{
			id: 'folder-1',
			name: 'Work',
			collapsed: 1,
			channels: ['channel-1']
		}];

		render(ChannelList, {
			props: {
				oncreate: vi.fn(),
				onbrowse: vi.fn(),
				revealRequest: { conversationId: 'channel-1', requestId: 1 }
			}
		});

		await vi.waitFor(() => {
			expect(mockSidebarState.folders[0].collapsed).toBe(0);
		});
	});

	test('renders "Channels" header text', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect
			.element(screen.getByText('Channels', { exact: true }))
			.toBeInTheDocument();
	});

	test('shows "No channels yet" when channel list is empty', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect
			.element(screen.getByText('No channels yet'))
			.toBeInTheDocument();
	});

	test('renders "Browse channels" button', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect
			.element(screen.getByText('Browse channels'))
			.toBeInTheDocument();
	});

	test('clicking browse calls onbrowse', async () => {
		const onbrowse = vi.fn();
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse }
		});

		await screen.getByText('Browse channels').click();
		expect(onbrowse).toHaveBeenCalled();
	});

	test('create channel button is present', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect
			.element(screen.getByTitle('Create channel'))
			.toBeInTheDocument();
	});

	test('colors the channel icon amber while an agent process is active', async () => {
		mockSidebarState.channels = [{
			id: 'channel-1',
			name: 'general',
			description: null,
			is_private: 0,
			has_unread: 0,
			unread_count: 0
		}];
		mockSidebarState.unfiledChannelIds = ['channel-1'];
		mockSidebarState.activeChannelIds.add('channel-1');

		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect.element(screen.getByText('general', { exact: true })).toBeInTheDocument();
		expect(screen.container.querySelector('.channel-icon-running')).not.toBeNull();
	});

	test('keeps the default channel icon color when no agent process is active', async () => {
		mockSidebarState.channels = [{
			id: 'channel-1',
			name: 'general',
			description: null,
			is_private: 0,
			has_unread: 0,
			unread_count: 0
		}];
		mockSidebarState.unfiledChannelIds = ['channel-1'];

		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect.element(screen.getByText('general', { exact: true })).toBeInTheDocument();
		expect(screen.container.querySelector('.channel-icon-running')).toBeNull();
	});

	test('clicking create channel calls oncreate', async () => {
		const oncreate = vi.fn();
		const screen = render(ChannelList, {
			props: { oncreate, onbrowse: vi.fn() }
		});

		await screen.getByTitle('Create channel').click();
		expect(oncreate).toHaveBeenCalled();
	});

	test('new folder button is present', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await expect
			.element(screen.getByTitle('New folder'))
			.toBeInTheDocument();
	});

	test('clicking new folder shows folder name input', async () => {
		const screen = render(ChannelList, {
			props: { oncreate: vi.fn(), onbrowse: vi.fn() }
		});

		await screen.getByTitle('New folder').click();

		await expect
			.element(screen.getByPlaceholder('Folder name'))
			.toBeInTheDocument();
	});

	test('copies a channel link and name from the channel context menu', async () => {
		mockSidebarState.channels = [{
			id: 'channel-1',
			name: 'general',
			description: null,
			is_private: 0,
			has_unread: 0,
			unread_count: 0
		}];
		mockSidebarState.unfiledChannelIds = ['channel-1'];

		const writeText = vi.fn().mockResolvedValue(undefined);
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText }
		});

		try {
			const screen = render(ChannelList, {
				props: { oncreate: vi.fn(), onbrowse: vi.fn() }
			});
			const channelName = screen.getByText('general', { exact: true });

			channelName.element().dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true,
				clientX: 10,
				clientY: 10
			}));
			await screen.getByText('Copy channel link').click();
			expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}?channel=channel-1`);

			channelName.element().dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true,
				clientX: 10,
				clientY: 10
			}));
			await screen.getByText('Copy channel name').click();
			expect(writeText).toHaveBeenLastCalledWith('general');
		} finally {
			if (clipboardDescriptor) {
				Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
			} else {
				delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
			}
		}
	});
});
