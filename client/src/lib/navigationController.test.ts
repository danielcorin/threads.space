import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	channelId: null as string | null,
	dmId: null as string | null,
	channels: [] as Array<{ id: string; has_unread: number; unread_count: number }>,
	dms: [] as Array<{ id: string; has_unread: number; unread_count: number }>,
	folders: [] as Array<{ channels: string[] }>,
	push: vi.fn(),
	back: vi.fn(),
	forward: vi.fn(),
	channelSelect: vi.fn((id: string | null) => { mocks.channelId = id; }),
	dmSelect: vi.fn((id: string | null) => { mocks.dmId = id; }),
	ensureLoaded: vi.fn().mockResolvedValue(undefined),
	threadClose: vi.fn(),
	setView: vi.fn(),
}));

vi.mock('$lib/api.js', () => ({
	api: {
		messages: { get: vi.fn() },
		channels: { get: vi.fn() },
	}
}));

vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		get selectedId() { return mocks.channelId; },
		get list() { return mocks.channels; },
		select: mocks.channelSelect,
		ensureLoaded: mocks.ensureLoaded,
		removeLocal: vi.fn(),
	}
}));

vi.mock('$lib/state/dms.svelte.js', () => ({
	dms: {
		get selectedId() { return mocks.dmId; },
		get list() { return mocks.dms; },
		select: mocks.dmSelect,
		load: vi.fn(),
		openDM: vi.fn(),
	}
}));

vi.mock('$lib/state/messages.svelte.js', () => ({
	messages: {
		requestAnchorLoad: vi.fn(),
		consumeAnchorLoad: vi.fn(),
		loadAround: vi.fn(),
	}
}));

vi.mock('$lib/state/navigation.svelte.js', () => ({
	navigation: {
		navigating: false,
		push: mocks.push,
		back: mocks.back,
		forward: mocks.forward,
	}
}));

vi.mock('$lib/state/thread.svelte.js', () => ({
	thread: {
		open: true,
		close: mocks.threadClose,
		openThread: vi.fn(),
	}
}));

vi.mock('$lib/state/ui.svelte.js', () => ({
	ui: { setView: mocks.setView }
}));

vi.mock('$lib/state/folders.svelte.js', () => ({
	folders: {
		get list() { return mocks.folders; },
	}
}));

import { NavigationController } from './navigationController.js';

const controller = new NavigationController({ setHighlightMessageId: vi.fn() });

describe('NavigationController page entries', () => {
	beforeEach(() => {
		mocks.channelId = null;
		mocks.dmId = null;
		mocks.channels = [];
		mocks.dms = [];
		mocks.folders = [];
		vi.clearAllMocks();
	});

	it('jumps between unread channels and DMs in either direction', () => {
		mocks.channelId = 'current';
		mocks.channels = [
			{ id: 'first', has_unread: 1, unread_count: 1 },
			{ id: 'current', has_unread: 0, unread_count: 0 },
		];
		mocks.dms = [{ id: 'dm-unread', has_unread: 1, unread_count: 2 }];

		expect(controller.goToUnread(1)).toMatchObject({ id: 'dm-unread', kind: 'dm' });
		expect(mocks.dmSelect).toHaveBeenCalledWith('dm-unread');
		expect(mocks.setView).toHaveBeenCalledWith('channels');
		expect(mocks.threadClose).toHaveBeenCalledOnce();

		mocks.channelId = null;
		mocks.dmId = 'dm-unread';
		expect(controller.goToUnread(-1)).toMatchObject({ id: 'first', kind: 'channel' });
		expect(mocks.channelSelect).toHaveBeenCalledWith('first');
	});

	it('does nothing when no other conversation is unread', () => {
		mocks.channelId = 'current';
		mocks.channels = [{ id: 'current', has_unread: 1, unread_count: 1 }];

		expect(controller.goToUnread(1)).toBeNull();
		expect(mocks.setView).not.toHaveBeenCalled();
	});

	it.each(['inbox', 'processes'] as const)('records and restores the %s page', async (view) => {
		const entry = { view, channelId: null, dmId: null, threadMessageId: null };
		controller.recordCurrentSelection(entry);
		expect(mocks.push).toHaveBeenCalledWith(entry);

		mocks.channelId = 'general';
		mocks.dmId = 'dm-1';
		await controller.openEntry(entry);

		expect(mocks.channelSelect).toHaveBeenCalledWith(null);
		expect(mocks.dmSelect).toHaveBeenCalledWith(null);
		expect(mocks.threadClose).toHaveBeenCalledOnce();
		expect(mocks.setView).toHaveBeenCalledWith(view);
	});

	it('does not record an empty conversation view', () => {
		controller.recordCurrentSelection({
			view: 'channels',
			channelId: null,
			dmId: null,
			threadMessageId: null,
		});

		expect(mocks.push).not.toHaveBeenCalled();
	});

	it('restores Feedback as a normal channel page', async () => {
		mocks.dmId = 'dm-1';
		const entry = {
			view: 'channels',
			channelId: 'feedback',
			dmId: null,
			threadMessageId: null,
		} as const;

		controller.recordCurrentSelection(entry);
		expect(mocks.push).toHaveBeenCalledWith(entry);
		await controller.openEntry(entry);

		expect(mocks.setView).toHaveBeenCalledWith('channels');
		expect(mocks.ensureLoaded).toHaveBeenCalledWith('feedback');
		expect(mocks.channelSelect).toHaveBeenCalledWith('feedback');
		expect(mocks.dmSelect).toHaveBeenCalledWith(null);
	});
});
