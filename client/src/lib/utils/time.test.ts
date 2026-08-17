import { describe, expect, test } from 'vitest';
import { dateKey, formatDateSeparator, formatTime } from './time.js';

describe('dateKey', () => {
	test('formats a timestamp as YYYY-MM-DD', () => {
		// 2025-03-15 12:00:00 UTC
		const ts = new Date('2025-03-15T12:00:00Z').getTime() / 1000;
		const key = dateKey(ts);
		// Result depends on local timezone, but format should be YYYY-MM-DD
		expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('pads single-digit month and day', () => {
		// 2025-01-05 12:00:00 UTC
		const ts = new Date('2025-01-05T12:00:00Z').getTime() / 1000;
		const key = dateKey(ts);
		expect(key).toMatch(/^\d{4}-0\d-0\d$/);
	});
});

describe('formatDateSeparator', () => {
	test('returns "Today" for today\'s date', () => {
		const now = Date.now() / 1000;
		expect(formatDateSeparator(now)).toBe('Today');
	});

	test('returns "Yesterday" for yesterday', () => {
		const yesterday = Date.now() / 1000 - 86400;
		expect(formatDateSeparator(yesterday)).toBe('Yesterday');
	});
});

describe('formatTime', () => {
	test('returns just time for today', () => {
		const now = Date.now() / 1000;
		const result = formatTime(now);
		// Should not contain "Yesterday" or a date
		expect(result).not.toContain('Yesterday');
		// Should contain a colon (time format like "3:45 PM")
		expect(result).toContain(':');
	});

	test('includes "Yesterday" for yesterday\'s timestamp', () => {
		const yesterday = Date.now() / 1000 - 86400;
		const result = formatTime(yesterday);
		expect(result).toContain('Yesterday');
	});
});
