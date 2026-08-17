/**
 * Universal search syntax parser.
 *
 * Tokenizes input respecting double-quoted phrases and classifies each token
 * as an operator (key:value), quoted phrase, or free word.
 *
 * Supported operators:
 *   in:<channel>        → filters.channel
 *   from:<user>         → filters.from
 *   before:<date|rel>   → filters.until  (ISO date string)
 *   after:<date|rel>    → filters.since  (ISO date string)
 *   has:<v1,v2,...>     → filters.has    (CSV: link, reaction, file)
 *
 * Relative date shortcuts: yesterday, 7d, 30d, 90d
 */

export type Token =
	| { type: 'operator'; key: string; value: string; raw: string }
	| { type: 'quotedPhrase'; value: string; raw: string }
	| { type: 'freeWord'; value: string; raw: string };

export interface ParseResult {
	filters: Record<string, string>;
	freeText: string;
	tokens: Token[];
}

const KNOWN_OPERATORS = new Set(['in', 'from', 'before', 'after', 'has']);

const OPERATOR_MAP: Record<string, string> = {
	in: 'channel',
	from: 'from',
	before: 'until',
	after: 'since',
	has: 'has',
};

function resolveDate(value: string): string {
	if (value === 'yesterday') {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return d.toISOString().slice(0, 10);
	}
	const match = value.match(/^(\d+)d$/);
	if (match) {
		const days = parseInt(match[1], 10);
		const d = new Date();
		d.setDate(d.getDate() - days);
		return d.toISOString().slice(0, 10);
	}
	// Already an ISO date or pass-through
	return value;
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length) {
		// Skip whitespace
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}

		// Quoted phrase
		if (input[i] === '"') {
			let end = input.indexOf('"', i + 1);
			if (end === -1) end = input.length;
			const value = input.slice(i + 1, end);
			if (value.length > 0) {
				tokens.push({ type: 'quotedPhrase', value, raw: `"${value}"` });
			}
			i = end + 1;
			continue;
		}

		// Bare word (may be operator key:value or free word)
		let end = i;
		while (end < input.length && !/\s/.test(input[end])) end++;
		const word = input.slice(i, end);

		const colonIdx = word.indexOf(':');
		if (colonIdx > 0) {
			const key = word.slice(0, colonIdx).toLowerCase();
			const value = word.slice(colonIdx + 1);
			if (KNOWN_OPERATORS.has(key) && value.length > 0) {
				tokens.push({ type: 'operator', key, value, raw: word });
			} else {
				// Unknown operator or empty value → free word
				tokens.push({ type: 'freeWord', value: word, raw: word });
			}
		} else {
			tokens.push({ type: 'freeWord', value: word, raw: word });
		}
		i = end;
	}

	return tokens;
}

export function parse(input: string): ParseResult {
	const tokens = tokenize(input);
	const filters: Record<string, string> = {};
	const freeTextParts: string[] = [];

	for (const token of tokens) {
		if (token.type === 'operator') {
			const filterKey = OPERATOR_MAP[token.key];
			let value = token.value;
			// Resolve relative dates for before/after
			if (token.key === 'before' || token.key === 'after') {
				value = resolveDate(value);
			}
			filters[filterKey] = value;
		} else if (token.type === 'quotedPhrase') {
			freeTextParts.push(`"${token.value}"`);
		} else {
			freeTextParts.push(token.value);
		}
	}

	return {
		filters,
		freeText: freeTextParts.join(' '),
		tokens,
	};
}
