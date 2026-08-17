import { describe, expect, it } from 'vitest';
import { normalizeMfaCode } from './mfa-code.js';

describe('normalizeMfaCode', () => {
	it('keeps only the first six digits', () => {
		expect(normalizeMfaCode('12a 34-5678')).toBe('123456');
	});

	it('supports an empty value', () => {
		expect(normalizeMfaCode('abc')).toBe('');
	});
});
