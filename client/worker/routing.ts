const API_PREFIX = '/api';

const CLIENT_ASSET_PATHS = new Set([
	'/apple-touch-icon.png',
	'/favicon.png',
	'/favicon.svg',
	'/manifest.webmanifest',
	'/og-image.png',
	'/sw.js'
]);

export function isClientRequest(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;

	const { pathname } = new URL(request.url);
	return (
		pathname === '/' ||
		pathname === '/login' ||
		pathname === '/login/' ||
		pathname.startsWith('/_app/') ||
		pathname.startsWith('/icon-') ||
		CLIENT_ASSET_PATHS.has(pathname)
	);
}

/** Translate the combined Worker's public /api mount to the API Worker's root. */
export function requestForApi(request: Request): Request {
	const url = new URL(request.url);
	if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
		return request;
	}

	url.pathname = url.pathname.slice(API_PREFIX.length) || '/';
	return new Request(url, request);
}
