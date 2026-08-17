import { describe, it, expect } from 'vitest';
import { groupReactions, formatFileSize } from './messageDisplay.js';

describe('groupReactions', () => {
	it('groups by emoji preserving first-seen order', () => {
		const groups = groupReactions([
			{ emoji: '👍', userId: 'u1', username: 'dan' },
			{ emoji: '🎉', userId: 'u2', username: 'tela' },
			{ emoji: '👍', userId: 'u2', username: 'tela' }
		]);
		expect(groups).toEqual([
			{ emoji: '👍', users: ['dan', 'tela'], userIds: ['u1', 'u2'] },
			{ emoji: '🎉', users: ['tela'], userIds: ['u2'] }
		]);
	});

	it('handles undefined and empty input', () => {
		expect(groupReactions(undefined)).toEqual([]);
		expect(groupReactions([])).toEqual([]);
	});
});

describe('formatFileSize', () => {
	it('formats bytes, KB, and MB', () => {
		expect(formatFileSize(500)).toBe('500B');
		expect(formatFileSize(2048)).toBe('2KB');
		expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5MB');
	});
});
