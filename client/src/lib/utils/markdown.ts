import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import { codeTheme } from '$lib/state/codeTheme.svelte.js';

// Register only the languages we need so the bundle doesn't pull in all ~100
// hljs grammars. typescript covers tsx, javascript covers jsx, xml covers
// html. svelte gets a separate registration that aliases to xml/javascript
// since hljs doesn't ship a dedicated svelte grammar.
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('svelte', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('diff', diff);

function highlightCode(code: string, lang: string | null): { html: string; language: string } {
	try {
		if (lang && hljs.getLanguage(lang)) {
			const result = hljs.highlight(code, { language: lang, ignoreIllegals: true });
			return { html: result.value, language: lang };
		}
		const auto = hljs.highlightAuto(code);
		return { html: auto.value, language: auto.language || 'plaintext' };
	} catch {
		// hljs threw on malformed input — fall back to escaped plain text.
		return { html: escapeHtml(code), language: 'plaintext' };
	}
}

/**
 * Extract message IDs from internal message links in text.
 * Matches URLs with `msg=<id>` query param (any origin).
 */
export function extractMessageLinks(text: string): string[] {
	const ids: string[] = [];
	// Match URLs containing msg= query param
	const urlRegex = /https?:\/\/[^\s<)]+[?&]msg=([a-zA-Z0-9_-]+)/g;
	let match;
	while ((match = urlRegex.exec(text)) !== null) {
		const msgId = match[1];
		if (msgId && !ids.includes(msgId)) {
			ids.push(msgId);
		}
	}
	return ids;
}

/**
 * Simple markdown renderer. Handles: bold, italic, strikethrough,
 * inline code, code blocks, links, and line breaks.
 * Returns HTML string (sanitized against XSS).
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function parseTableRow(row: string): string[] {
	// Split on | but trim leading/trailing pipes
	const trimmed = row.replace(/^\|/, '').replace(/\|$/, '');
	return trimmed.split('|').map(cell => cell.trim());
}

function getColumnAlignment(sep: string): 'left' | 'center' | 'right' {
	const trimmed = sep.trim();
	const left = trimmed.startsWith(':');
	const right = trimmed.endsWith(':');
	if (left && right) return 'center';
	if (right) return 'right';
	return 'left';
}

/**
 * Render inline markdown (code, bold, italic, strikethrough) for use inside
 * table cells. Does NOT handle block-level constructs (tables, line breaks,
 * code fences) or links/mentions/channels — cells are short and inline-only.
 */
export function renderInlineMarkdown(text: string): string {
	const parts = text.split(/(`[^`\n]+`)/g);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) {
				return `<code class="bg-[var(--color-bg-input)] rounded px-1 py-0.5 text-sm">${escapeHtml(part.slice(1, -1))}</code>`;
			}
			let html = escapeHtml(part);
			html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
			html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
			html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
			html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');
			html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
			return html;
		})
		.join('');
}

function renderTable(block: string): string {
	const lines = block.split('\n').filter(l => l.trim());
	if (lines.length < 2) return block;

	// Find separator row (contains only |, -, :, and spaces)
	const sepIndex = lines.findIndex(l => /^\|[\s|:-]+\|$/.test(l.trim()));
	if (sepIndex < 1) return block;

	const headerLines = lines.slice(0, sepIndex);
	const separatorCells = parseTableRow(lines[sepIndex]);
	const alignments = separatorCells.map(getColumnAlignment);
	const bodyLines = lines.slice(sepIndex + 1);

	let html = '<div class="md-table-wrap"><table class="md-table">';

	// Header
	html += '<thead>';
	for (const headerLine of headerLines) {
		const cells = parseTableRow(headerLine);
		html += '<tr>';
		cells.forEach((cell, i) => {
			const align = alignments[i] || 'left';
			html += `<th style="text-align:${align}">${renderInlineMarkdown(cell)}</th>`;
		});
		html += '</tr>';
	}
	html += '</thead>';

	// Body
	if (bodyLines.length > 0) {
		html += '<tbody>';
		for (const line of bodyLines) {
			const cells = parseTableRow(line);
			html += '<tr>';
			cells.forEach((cell, i) => {
				const align = alignments[i] || 'left';
				html += `<td style="text-align:${align}">${renderInlineMarkdown(cell)}</td>`;
			});
			html += '</tr>';
		}
		html += '</tbody>';
	}

	html += '</table></div>';
	return html;
}

export function renderMarkdown(text: string, knownUsernames?: Set<string>, knownChannelNames?: Set<string>): string {
	// Extract GFM tables BEFORE splitting on inline code/code fences. Cells
	// commonly contain inline code (e.g. `src/`) which would otherwise
	// fragment rows across split parts and prevent the table regex from ever
	// seeing a complete block. Render each table to HTML now and substitute
	// a placeholder that survives the rest of the pipeline; restore at end.
	const tablePlaceholders: string[] = [];
	// The table regex requires every row (header, separator, body) to end in
	// \n. Append a synthetic newline so tables typed without a trailing
	// newline still match — strip it back if we didn't extract anything.
	const hadTrailingNewline = text.endsWith('\n');
	const textWithNl = hadTrailingNewline ? text : text + '\n';
	const detabbed = textWithNl.replace(
		/(^|\n)((?:\|[^\n]+\|\n)+\|[-| :]+\|\n(?:\|[^\n]+\|\n?)*)/g,
		(_match, prefix: string, tableBlock: string) => {
			const i = tablePlaceholders.length;
			tablePlaceholders.push(renderTable(tableBlock.trim()));
			return `${prefix}\x00TABLE${i}\x00\n`;
		}
	);
	if (tablePlaceholders.length > 0) {
		text = detabbed;
	} else if (!hadTrailingNewline) {
		// No tables and we appended a newline — no-op, keep original text.
	}
	// Split code blocks first to avoid processing markdown inside them
	const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

	const processed = parts.map((part, i) => {
		// Odd indices are code blocks/inline code
		if (i % 2 === 1) {
			if (part.startsWith('```')) {
				const inner = part.slice(3, -3);
				// Capture optional language hint on the first line. The hint is
				// any leading [a-zA-Z0-9+_-]+ followed by a newline.
				const hintMatch = inner.match(/^([a-zA-Z0-9+_-]+)\n/);
				const lang = hintMatch ? hintMatch[1].toLowerCase() : null;
				const code = hintMatch ? inner.slice(hintMatch[0].length) : inner.replace(/^\n/, '');
				const { html: highlighted, language } = highlightCode(code, lang);
				const themeClass = codeTheme.className;
				return `<div class="code-block-wrapper"><pre class="bg-[var(--color-bg-input)] rounded px-3 py-2 my-1 overflow-x-auto text-sm"><code class="hljs language-${language} ${themeClass}">${highlighted}</code></pre><button class="code-copy-btn" aria-label="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>`;
			}
			return `<code class="bg-[var(--color-bg-input)] rounded px-1 py-0.5 text-sm">${escapeHtml(part.slice(1, -1))}</code>`;
		}

		let html = escapeHtml(part);

		// Bold: **text** or __text__
		html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

		// Italic: *text* or _text_
		html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
		html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');

		// Strikethrough: ~~text~~
		html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

		// Links: [text](url) — extract to placeholders so the bare-URL pass
		// below doesn't re-match the URL sitting inside href="..." and produce
		// nested <a> tags. Restored at the end.
		const linkPlaceholders: string[] = [];
		html = html.replace(
			/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
			(_match, text: string, url: string) => {
				const i = linkPlaceholders.length;
				linkPlaceholders.push(
					`<a href="${url}" target="_blank" rel="noopener" class="text-[var(--color-link)] hover:underline">${text}</a>`
				);
				return `\x00LINK${i}\x00`;
			}
		);

		// Mentions: @username — only highlight if username is a known user
		html = html.replace(
			/@([a-zA-Z0-9_-]+)/g,
			(_match, username) => {
				if (knownUsernames && knownUsernames.has(username)) {
					return `<span class="mention" data-mention-username="${username}">@${username}</span>`;
				}
				return `@${username}`;
			}
		);

		// Channel references: #channel-name — only highlight if channel name is known
		html = html.replace(
			/#([a-zA-Z0-9_-]+)/g,
			(_match, name) => {
				if (knownChannelNames && knownChannelNames.has(name)) {
					return `<span class="channel-ref">#${name}</span>`;
				}
				return `#${name}`;
			}
		);

		// Bare URLs (markdown links are placeholdered above, so this won't
		// re-wrap their URLs).
		html = html.replace(
			/(?<!\w)(https?:\/\/[^\s<]+)/g,
			'<a href="$1" target="_blank" rel="noopener" class="text-[var(--color-link)] hover:underline">$1</a>'
		);

		// Tables are pre-extracted at the top of renderMarkdown and
		// represented here by \x00TABLE<i>\x00 placeholders, so no in-pipeline
		// table detection is needed.

		// Line breaks
		html = html.replace(/\n/g, '<br>');

		// Restore markdown-link placeholders.
		for (let i = 0; i < linkPlaceholders.length; i++) {
			html = html.replace(`\x00LINK${i}\x00`, linkPlaceholders[i]);
		}

		return html;
	});

	let result = processed.join('');
	// Restore pre-rendered table HTML. Tables are block-level, so they sit
	// alongside any <br> the line-break pass introduced from the surrounding
	// newlines — that's fine and matches the prior behavior.
	for (let i = 0; i < tablePlaceholders.length; i++) {
		result = result.replace(`\x00TABLE${i}\x00`, tablePlaceholders[i]);
	}
	return result;
}
