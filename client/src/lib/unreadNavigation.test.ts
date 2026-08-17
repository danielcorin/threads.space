import { describe, expect, it } from 'vitest';
import {
	buildConversationNavigationOrder,
	findUnreadConversation,
	unreadNavigationDirection,
} from './unreadNavigation.js';

describe('unread conversation navigation', () => {
	it('matches pinned, folder, unfiled, ephemeral, and DM sidebar order', () => {
		const channels = [
			{ id: 'unfiled', unread_count: 1 },
			{ id: 'ephemeral', is_ephemeral: 1, unread_count: 1 },
			{ id: 'folder-b', unread_count: 1 },
			{ id: 'feedback', unread_count: 1 },
			{ id: 'folder-a', unread_count: 1 },
		];
		const folders = [{ channels: ['folder-a', 'folder-b'] }];
		const dms = [{ id: 'dm', unread_count: 1 }];

		expect(buildConversationNavigationOrder(channels, folders, dms, ['feedback']))
			.toEqual([
				{ id: 'feedback', kind: 'channel', unread: true },
				{ id: 'folder-a', kind: 'channel', unread: true },
				{ id: 'folder-b', kind: 'channel', unread: true },
				{ id: 'unfiled', kind: 'channel', unread: true },
				{ id: 'ephemeral', kind: 'channel', unread: true },
				{ id: 'dm', kind: 'dm', unread: true },
			]);
	});

	it('moves forward and backward from a read current conversation', () => {
		const items = [
			{ id: 'first', kind: 'channel' as const, unread: true },
			{ id: 'current', kind: 'channel' as const, unread: false },
			{ id: 'last', kind: 'dm' as const, unread: true },
		];

		expect(findUnreadConversation(items, 'current', 1)?.id).toBe('last');
		expect(findUnreadConversation(items, 'current', -1)?.id).toBe('first');
	});

	it('wraps at both ends and skips the current conversation', () => {
		const items = [
			{ id: 'first', kind: 'channel' as const, unread: true },
			{ id: 'middle', kind: 'channel' as const, unread: false },
			{ id: 'last', kind: 'dm' as const, unread: true },
		];

		expect(findUnreadConversation(items, 'last', 1)?.id).toBe('first');
		expect(findUnreadConversation(items, 'first', -1)?.id).toBe('last');
		expect(findUnreadConversation([
			{ id: 'current', kind: 'channel', unread: true },
		], 'current', 1)).toBeNull();
	});

	it('starts at the directional edge when no conversation is selected', () => {
		const items = [
			{ id: 'first', kind: 'channel' as const, unread: true },
			{ id: 'last', kind: 'dm' as const, unread: true },
		];

		expect(findUnreadConversation(items, null, 1)?.id).toBe('first');
		expect(findUnreadConversation(items, null, -1)?.id).toBe('last');
	});

	it('accepts only the exact option-shift-arrow shortcut', () => {
		const event = {
			key: 'ArrowDown',
			altKey: true,
			shiftKey: true,
			metaKey: false,
			ctrlKey: false,
			defaultPrevented: false,
		};

		expect(unreadNavigationDirection(event)).toBe(1);
		expect(unreadNavigationDirection({ ...event, key: 'ArrowUp' })).toBe(-1);
		expect(unreadNavigationDirection({ ...event, shiftKey: false })).toBeNull();
		expect(unreadNavigationDirection({ ...event, metaKey: true })).toBeNull();
		expect(unreadNavigationDirection({ ...event, defaultPrevented: true })).toBeNull();
	});
});
