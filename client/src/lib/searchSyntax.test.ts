import { describe, it, expect } from 'vitest';
import { parse } from './searchSyntax.js';

describe('searchSyntax.parse', () => {
	it('returns empty for empty input', () => {
		const result = parse('');
		expect(result.filters).toEqual({});
		expect(result.freeText).toBe('');
		expect(result.tokens).toEqual([]);
	});

	it('returns empty for whitespace-only input', () => {
		const result = parse('   ');
		expect(result.filters).toEqual({});
		expect(result.freeText).toBe('');
		expect(result.tokens).toEqual([]);
	});

	it('parses free text only', () => {
		const result = parse('hello world');
		expect(result.freeText).toBe('hello world');
		expect(result.filters).toEqual({});
		expect(result.tokens).toHaveLength(2);
		expect(result.tokens[0]).toEqual({ type: 'freeWord', value: 'hello', raw: 'hello' });
		expect(result.tokens[1]).toEqual({ type: 'freeWord', value: 'world', raw: 'world' });
	});

	it('parses a single operator', () => {
		const result = parse('in:general');
		expect(result.filters).toEqual({ channel: 'general' });
		expect(result.freeText).toBe('');
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]).toEqual({ type: 'operator', key: 'in', value: 'general', raw: 'in:general' });
	});

	it('parses multiple operators', () => {
		const result = parse('in:random from:alice after:7d');
		expect(result.filters).toEqual({ channel: 'random', from: 'alice', since: expect.any(String) });
		expect(result.freeText).toBe('');
	});

	it('parses quoted phrases as free text', () => {
		const result = parse('"hello world"');
		expect(result.freeText).toBe('"hello world"');
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]).toEqual({ type: 'quotedPhrase', value: 'hello world', raw: '"hello world"' });
	});

	it('handles mixed operators and free text', () => {
		const result = parse('in:general hello world from:bob');
		expect(result.filters).toEqual({ channel: 'general', from: 'bob' });
		expect(result.freeText).toBe('hello world');
	});

	it('handles mixed with quoted phrases', () => {
		const result = parse('in:dev "exact match" from:alice foo');
		expect(result.filters).toEqual({ channel: 'dev', from: 'alice' });
		expect(result.freeText).toBe('"exact match" foo');
	});

	it('treats unknown operators as free words', () => {
		const result = parse('unknown:value hello');
		expect(result.filters).toEqual({});
		expect(result.freeText).toBe('unknown:value hello');
		expect(result.tokens[0]).toEqual({ type: 'freeWord', value: 'unknown:value', raw: 'unknown:value' });
	});

	it('handles malformed operator (key: with no value)', () => {
		const result = parse('in: hello');
		// "in:" with no value is treated as free word
		expect(result.freeText).toBe('in: hello');
		expect(result.filters).toEqual({});
	});

	it('maps in: to channel filter', () => {
		expect(parse('in:general').filters.channel).toBe('general');
	});

	it('maps from: to from filter', () => {
		expect(parse('from:alice').filters.from).toBe('alice');
	});

	it('maps before: to until filter (ISO date)', () => {
		const result = parse('before:2024-01-15');
		expect(result.filters.until).toBe('2024-01-15');
	});

	it('maps after: to since filter (ISO date)', () => {
		const result = parse('after:2024-06-01');
		expect(result.filters.since).toBe('2024-06-01');
	});

	it('resolves before:yesterday to ISO date', () => {
		const result = parse('before:yesterday');
		// Should be a valid ISO date string
		expect(result.filters.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('resolves after:7d to ISO date 7 days ago', () => {
		const result = parse('after:7d');
		const d = new Date();
		d.setDate(d.getDate() - 7);
		const expected = d.toISOString().slice(0, 10);
		expect(result.filters.since).toBe(expected);
	});

	it('resolves after:30d to ISO date 30 days ago', () => {
		const result = parse('after:30d');
		const d = new Date();
		d.setDate(d.getDate() - 30);
		const expected = d.toISOString().slice(0, 10);
		expect(result.filters.since).toBe(expected);
	});

	it('parses has: with single value', () => {
		const result = parse('has:link');
		expect(result.filters.has).toBe('link');
	});

	it('parses has: with multiple comma-separated values', () => {
		const result = parse('has:link,reaction,file');
		expect(result.filters.has).toBe('link,reaction,file');
	});

	it('handles has: combined with other filters and free text', () => {
		const result = parse('in:general has:file important doc');
		expect(result.filters).toEqual({ channel: 'general', has: 'file' });
		expect(result.freeText).toBe('important doc');
	});

	it('handles duplicate operators (last wins)', () => {
		const result = parse('in:general in:random');
		expect(result.filters.channel).toBe('random');
	});

	it('preserves token order', () => {
		const result = parse('hello in:general world');
		expect(result.tokens).toHaveLength(3);
		expect(result.tokens[0].type).toBe('freeWord');
		expect(result.tokens[1].type).toBe('operator');
		expect(result.tokens[2].type).toBe('freeWord');
	});

	it('handles quoted phrase with operators inside (not parsed as ops)', () => {
		const result = parse('"in:general hello"');
		expect(result.filters).toEqual({});
		expect(result.freeText).toBe('"in:general hello"');
	});

	it('handles unclosed quote as a phrase to end of string', () => {
		const result = parse('"unclosed phrase');
		expect(result.freeText).toBe('"unclosed phrase"');
		expect(result.tokens[0]).toEqual({ type: 'quotedPhrase', value: 'unclosed phrase', raw: '"unclosed phrase"' });
	});
});
