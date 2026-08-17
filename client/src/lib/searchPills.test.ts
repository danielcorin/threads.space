import { describe, it, expect } from 'vitest';
import {
	pillFilters,
	resolveDate,
	getCurrentToken,
	resolveChannelId,
	pillLabel,
	resolveHistoryQueryIds,
	type Pill
} from './searchPills.js';

const channels = [
	{ id: 'c1', name: 'general' },
	{ id: 'c2', name: 'random' }
];
const dms = [
	{ id: 'd1', partner: { id: 'u9', username: 'tela', display_name: 'Tela' } },
	{ id: 'd2', partner: { id: 'u7', username: 'dan', display_name: null } }
];

function pill(key: string, value: string, displayValue?: string): Pill {
	return { key, value, raw: `${key}:${value}`, displayValue };
}

describe('pillFilters', () => {
	it('maps operators to API filter keys', () => {
		const f = pillFilters([
			pill('in', 'c1'),
			pill('from', 'u7'),
			pill('before', '2026-01-01'),
			pill('after', '7d'),
			pill('has', 'link')
		]);
		expect(f).toEqual({
			channel: 'c1',
			from: 'u7',
			until: '2026-01-01',
			since: '7d',
			has: 'link'
		});
	});
});

describe('resolveDate', () => {
	const now = new Date('2026-06-09T12:00:00Z');

	it('resolves yesterday and Nd presets relative to now', () => {
		const yesterday = Number(resolveDate('yesterday', now));
		expect(yesterday).toBe(Math.floor(new Date('2026-06-08T12:00:00Z').getTime() / 1000));
		const week = Number(resolveDate('7d', now));
		expect(week).toBe(Math.floor(new Date('2026-06-02T12:00:00Z').getTime() / 1000));
	});

	it('resolves ISO dates to local midnight epoch seconds', () => {
		expect(resolveDate('2026-01-02', now)).toBe(
			String(Math.floor(new Date('2026-01-02T00:00:00').getTime() / 1000))
		);
	});

	it('passes through unrecognized values', () => {
		expect(resolveDate('1751234567', now)).toBe('1751234567');
	});
});

describe('getCurrentToken', () => {
	it('returns the trailing operator token', () => {
		expect(getCurrentToken('hello in:gen')).toEqual({ prefix: 'in', value: 'gen' });
		expect(getCurrentToken('FROM:dan')).toEqual({ prefix: 'from', value: 'dan' });
	});

	it('returns null for plain text or unknown operators', () => {
		expect(getCurrentToken('hello world')).toBeNull();
		expect(getCurrentToken('foo bar:baz')).toBeNull();
		expect(getCurrentToken('')).toBeNull();
	});
});

describe('resolveChannelId', () => {
	it('resolves channel names case-insensitively', () => {
		expect(resolveChannelId('GENERAL', channels, dms)).toBe('c1');
	});

	it('resolves DM partner display names', () => {
		expect(resolveChannelId('tela', channels, dms)).toBe('d1');
	});

	it('falls through to the raw name', () => {
		expect(resolveChannelId('nonexistent', channels, dms)).toBe('nonexistent');
	});
});

describe('pillLabel', () => {
	it('labels channels with # and DMs/users with @', () => {
		expect(pillLabel(pill('in', 'c1'), channels, dms)).toBe('#general');
		expect(pillLabel(pill('in', 'd1'), channels, dms)).toBe('@Tela');
		expect(pillLabel(pill('from', 'u7'), channels, dms)).toBe('@dan');
		expect(pillLabel(pill('from', 'u-unknown', 'someone'), channels, dms)).toBe('@someone');
		expect(pillLabel(pill('has', 'link'), channels, dms)).toBe('link');
	});
});

describe('resolveHistoryQueryIds', () => {
	it('rewrites in:/from: ids to names known from current state', () => {
		expect(resolveHistoryQueryIds('hello in:c1 from:u9', channels, dms)).toBe(
			'hello in:general from:Tela'
		);
	});

	it('leaves unknown ids untouched', () => {
		expect(resolveHistoryQueryIds('in:gone', channels, dms)).toBe('in:gone');
	});
});
