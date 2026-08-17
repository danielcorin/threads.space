/**
 * Build the URL the widget bridge fetches on behalf of a sandboxed widget.
 *
 * The `path` comes from widget-authored code via postMessage and is untrusted:
 * without validation a widget could send `/../../channels/<id>/messages` and
 * read arbitrary API routes with the viewing user's session. Returns null
 * unless the resolved URL stays under `<apiBase>/widgets/<widgetId>/data/`.
 */
export function buildWidgetDataUrl(apiBase: string, widgetId: string, path: unknown): string | null {
	if (typeof path !== 'string') return null;
	if (!path.startsWith('/') || path.startsWith('//')) return null;
	// Reject traversal outright, including encoded forms the server might decode.
	if (path.includes('..') || /%2e/i.test(path) || path.includes('\\')) return null;

	const raw = `${apiBase}/widgets/${widgetId}/data${path}`;
	// apiBase may be relative (dev) or absolute (production); a dummy base makes
	// both parseable. Absolute URLs keep their own origin.
	const dummyBase = 'https://widget-bridge.invalid';
	let resolved: URL;
	let expected: URL;
	try {
		resolved = new URL(raw, dummyBase);
		expected = new URL(`${apiBase}/widgets/${widgetId}/data/`, dummyBase);
	} catch {
		return null;
	}
	if (resolved.origin !== expected.origin) return null;
	if (!resolved.pathname.startsWith(expected.pathname)) return null;
	return raw;
}
