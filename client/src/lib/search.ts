// Client-side helpers for search result rendering.
// Kept in sync with server: packages/threads/api/src/routes/search.ts

// Sentinel characters the server wraps around matched tokens in the snippet()
// output. We HTML-escape the whole snippet first (since it contains raw DB
// content), then replace sentinels with <mark>/</mark>.
const MARK_START = '\u0002MS\u0002';
const MARK_END = '\u0002ME\u0002';

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Convert a server-returned snippet string (with sentinel-wrapped match terms)
 * into safe HTML where only <mark> tags are allowed. All other content is
 * HTML-escaped.
 */
export function renderSnippet(snippet: string | null | undefined, fallback = ''): string {
	if (!snippet) return escapeHtml(fallback);
	return escapeHtml(snippet)
		.split(MARK_START)
		.join('<mark>')
		.split(MARK_END)
		.join('</mark>');
}
