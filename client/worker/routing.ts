const API_PREFIX = '/api';
const SHARE_TARGET_PATH = '/share-target';

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

/**
 * The manifest's share_target posts here. sw.js normally answers it; this is
 * the fallback when no service worker controls the page. Text fields survive
 * the redirect into the app, files do not.
 */
export async function shareTargetRedirect(request: Request): Promise<Response | null> {
	if (request.method !== 'POST' || new URL(request.url).pathname !== SHARE_TARGET_PATH) {
		return null;
	}

	const params = new URLSearchParams({ 'share-target': '1' });
	try {
		const form = await request.formData();
		for (const key of ['title', 'text', 'url']) {
			const value = form.get(key);
			if (typeof value === 'string' && value) params.set(key, value);
		}
	} catch {
		// Malformed body: still land in the app.
	}
	return Response.redirect(new URL(`/?${params}`, request.url).href, 303);
}
