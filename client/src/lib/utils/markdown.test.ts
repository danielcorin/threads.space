import { describe, expect, test } from 'vitest';
import { extractMessageLinks, renderMarkdown } from './markdown.js';

describe('extractMessageLinks', () => {
	test('extracts message IDs from URLs with msg param', () => {
		const text = 'Check out https://example.com/channel?msg=abc123 for details';
		expect(extractMessageLinks(text)).toEqual(['abc123']);
	});

	test('extracts multiple unique IDs', () => {
		const text =
			'See https://example.com?msg=id1 and https://example.com?msg=id2';
		expect(extractMessageLinks(text)).toEqual(['id1', 'id2']);
	});

	test('deduplicates message IDs', () => {
		const text =
			'https://example.com?msg=same and https://other.com?msg=same';
		expect(extractMessageLinks(text)).toEqual(['same']);
	});

	test('returns empty array when no links', () => {
		expect(extractMessageLinks('no links here')).toEqual([]);
	});
});

describe('renderMarkdown', () => {
	test('renders bold text', () => {
		expect(renderMarkdown('**hello**')).toContain('<strong>hello</strong>');
	});

	test('renders italic text', () => {
		expect(renderMarkdown('*hello*')).toContain('<em>hello</em>');
	});

	test('renders strikethrough', () => {
		expect(renderMarkdown('~~removed~~')).toContain('<s>removed</s>');
	});

	test('renders inline code without processing markdown inside', () => {
		const result = renderMarkdown('use `**not bold**` here');
		expect(result).toContain('<code');
		expect(result).not.toContain('<strong>not bold</strong>');
	});

	test('escapes HTML to prevent XSS', () => {
		const result = renderMarkdown('<script>alert("xss")</script>');
		expect(result).not.toContain('<script>');
		expect(result).toContain('&lt;script&gt;');
	});

	test('highlights known @mentions', () => {
		const users = new Set(['alice']);
		const result = renderMarkdown('hello @alice', users);
		expect(result).toContain('class="mention"');
		expect(result).toContain('data-mention-username="alice"');
	});

	test('does not highlight unknown @mentions', () => {
		const users = new Set(['alice']);
		const result = renderMarkdown('hello @bob', users);
		expect(result).not.toContain('class="mention"');
	});

	test('renders markdown link as a single clean anchor (no nested <a>)', () => {
		const result = renderMarkdown('[Qwen on HF](https://huggingface.co/Qwen)');
		// One opening anchor, one closing anchor — not two of either.
		expect(result.match(/<a /g)?.length).toBe(1);
		expect(result.match(/<\/a>/g)?.length).toBe(1);
		expect(result).toContain('href="https://huggingface.co/Qwen"');
		expect(result).toContain('>Qwen on HF</a>');
		// The URL should not appear twice (would indicate the bare-URL pass
		// re-wrapped the URL inside the existing <a href="...">).
		expect(result.match(/https:\/\/huggingface\.co\/Qwen/g)?.length).toBe(1);
	});

	test('renders bare URL as a single anchor', () => {
		const result = renderMarkdown('see https://example.com here');
		expect(result.match(/<a /g)?.length).toBe(1);
		expect(result).toContain('href="https://example.com"');
	});

	test('handles markdown link followed by bare URL without cross-contamination', () => {
		const result = renderMarkdown(
			'[docs](https://a.com) and also https://b.com'
		);
		expect(result.match(/<a /g)?.length).toBe(2);
		expect(result.match(/<\/a>/g)?.length).toBe(2);
	});

	test('renders a simple GFM table', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |\n';
		const result = renderMarkdown(md);
		expect(result).toContain('<table class="md-table">');
		expect(result).toContain('<th');
		expect(result).toContain('>A</th>');
		expect(result).toContain('>B</th>');
		expect(result).toContain('>1</td>');
		expect(result).toContain('>2</td>');
	});

	test('renders a table with inline code inside cells', () => {
		const md =
			'| Layer | Dir | LOC |\n' +
			'|---|---|---|\n' +
			'| Agent | `src/` | 25,616 |\n' +
			'| Web | `packages/filae-web/` | 3,327 |\n';
		const result = renderMarkdown(md);
		// Table structure must survive inline code in cells (the original bug).
		expect(result).toContain('<table class="md-table">');
		expect(result).toContain('>Layer</th>');
		expect(result).toContain('>Dir</th>');
		expect(result).toContain('>LOC</th>');
		// Inline code inside cells should render as <code>, not raw backticks.
		expect(result).toContain('<code');
		expect(result).toContain('>src/</code>');
		expect(result).toContain('>packages/filae-web/</code>');
		// And the row data should still be there.
		expect(result).toContain('>Agent</td>');
		expect(result).toContain('>25,616</td>');
		// The whole table must be inside the table wrapper — no stray pipes.
		expect(result).not.toMatch(/\|\s*Agent/);
	});

	test('renders a table with bold inside cells', () => {
		const md =
			'| Name | Status |\n|---|---|\n| **alpha** | done |\n';
		const result = renderMarkdown(md);
		expect(result).toContain('<table class="md-table">');
		expect(result).toContain('<strong>alpha</strong>');
	});

	test('renders a table without a trailing newline', () => {
		const md = '| A | B |\n|---|---|\n| 1 | 2 |';
		const result = renderMarkdown(md);
		expect(result).toContain('<table class="md-table">');
		expect(result).toContain('>1</td>');
		expect(result).toContain('>2</td>');
	});

	test('fenced code block with language hint is syntax-highlighted', () => {
		const md = '```typescript\nconst x: number = 42;\n```';
		const result = renderMarkdown(md);
		expect(result).toContain('class="hljs');
		expect(result).toContain('language-typescript');
		// hljs wraps tokens in <span class="hljs-..."> elements
		expect(result).toMatch(/<span class="hljs-[a-z]+/);
	});

	test('fenced code block with no language hint is auto-detected', () => {
		// Use a recognizable JS snippet so highlightAuto picks something.
		const md = '```\nfunction add(a, b) { return a + b; }\n```';
		const result = renderMarkdown(md);
		expect(result).toContain('class="hljs');
		// Auto-detect should still produce token spans for a real language.
		expect(result).toMatch(/<span class="hljs-[a-z]+/);
	});

	test('fenced code block with unknown language hint falls back without crashing', () => {
		const md = '```not-a-real-language\nhello world\n```';
		const result = renderMarkdown(md);
		expect(result).toContain('class="hljs');
		// Plain content should still be present (possibly inside hljs spans).
		expect(result).toContain('hello');
		expect(result).toContain('world');
	});

	test('inline single-backtick code is NOT syntax-highlighted', () => {
		const result = renderMarkdown('use `const x = 1` here');
		expect(result).toContain('<code');
		// Inline code should not get the hljs class or token spans.
		expect(result).not.toContain('class="hljs');
		expect(result).not.toMatch(/<span class="hljs-[a-z]+/);
	});

	test('fenced code block applies the active theme class', () => {
		const md = '```js\nconst x = 1;\n```';
		const result = renderMarkdown(md);
		// Default theme is monokai-sublime — its class form is theme-monokai-sublime.
		expect(result).toContain('theme-monokai-sublime');
	});
});
