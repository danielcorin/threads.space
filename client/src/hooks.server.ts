import type { Handle } from '@sveltejs/kit';

const csp = [
	"default-src 'self'",
	[
		"connect-src 'self'",
		'https://cdn.jsdelivr.net',
		'http://localhost:*',
		'ws://localhost:*',
	].join(' '),
	"frame-src 'self'",
	"frame-ancestors 'self'",
	"img-src 'self' blob: data: https:",
	"media-src 'self' blob: https:",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
	"font-src 'self' data:",
	"base-uri 'self'",
	"form-action 'self'",
].join('; ');

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('Content-Security-Policy', csp);
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	return response;
};
