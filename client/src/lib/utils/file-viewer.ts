/**
 * File viewer type detection. Picks the right sub-renderer for an
 * attachment based on MIME type with extension-based fallbacks for
 * `application/octet-stream` and ambiguous types.
 */

export type ViewerType =
	| 'audio'
	| 'pdf'
	| 'markdown'
	| 'csv'
	| 'json'
	| 'text'
	| 'unsupported';

const TEXT_EXTENSIONS = new Set([
	'txt',
	'log',
	'ts',
	'tsx',
	'js',
	'jsx',
	'mjs',
	'cjs',
	'py',
	'rs',
	'go',
	'java',
	'c',
	'cpp',
	'cc',
	'h',
	'hpp',
	'sh',
	'bash',
	'zsh',
	'yml',
	'yaml',
	'toml',
	'ini',
	'cfg',
	'conf',
	'svelte',
	'vue',
	'html',
	'htm',
	'css',
	'scss',
	'sass',
	'less',
	'sql',
	'rb',
	'php',
	'kt',
	'swift',
	'r',
	'lua',
	'pl',
	'el',
	'env',
	'gitignore',
	'dockerignore',
]);

function getExtension(filename: string): string {
	const idx = filename.lastIndexOf('.');
	if (idx < 0 || idx === filename.length - 1) return '';
	return filename.slice(idx + 1).toLowerCase();
}

export function detectViewerType(contentType: string, filename: string): ViewerType {
	const ct = (contentType || '').toLowerCase();
	const ext = getExtension(filename);

	// Strong matches by content type first.
	if (ct.startsWith('audio/')) return 'audio';
	if (ct === 'application/pdf') return 'pdf';
	if (ct === 'text/markdown' || ct === 'text/x-markdown') return 'markdown';
	if (ct === 'text/csv' || ct === 'text/tab-separated-values') return 'csv';
	if (ct === 'application/json' || ct.endsWith('+json')) return 'json';

	// Extension-based matches (handles application/octet-stream and
	// generic text/plain dumps where the MIME doesn't carry the format).
	if (ext === 'md' || ext === 'markdown') return 'markdown';
	if (ext === 'csv' || ext === 'tsv') return 'csv';
	if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json';
	if (ext === 'pdf') return 'pdf';

	if (ct.startsWith('text/')) return 'text';
	if (TEXT_EXTENSIONS.has(ext)) return 'text';

	// XML/SVG/HTML often arrive sanitized as octet-stream — keep as text
	// when the extension hints at a text format.
	if (ct === 'application/xml' || ct === 'text/xml') return 'text';
	if (ext === 'xml' || ext === 'svg') return 'text';

	return 'unsupported';
}
