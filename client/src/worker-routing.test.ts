import { describe, expect, it } from 'vitest';
import { isClientRequest, requestForApi, shareTargetRedirect } from '../worker/routing.js';

describe('combined Worker routing', () => {
	it('strips only the complete public /api path segment', async () => {
		const input = new Request('https://threads.example/api/auth/login?next=%2F', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Test': 'preserved' },
			body: JSON.stringify({ username: 'admin' })
		});
		const routed = requestForApi(input);

		expect(routed.url).toBe('https://threads.example/auth/login?next=%2F');
		expect(routed.method).toBe('POST');
		expect(routed.headers.get('X-Test')).toBe('preserved');
		expect(await routed.json()).toEqual({ username: 'admin' });
		expect(requestForApi(new Request('https://threads.example/api')).url).toBe(
			'https://threads.example/'
		);
		expect(requestForApi(new Request('https://threads.example/apis/status')).url).toBe(
			'https://threads.example/apis/status'
		);
	});

	it('keeps the app shell and static assets on the asset binding', () => {
		expect(isClientRequest(new Request('https://threads.example/'))).toBe(true);
		expect(isClientRequest(new Request('https://threads.example/login'))).toBe(true);
		expect(isClientRequest(new Request('https://threads.example/_app/immutable/app.js'))).toBe(true);
		expect(isClientRequest(new Request('https://threads.example/api/auth/login'))).toBe(false);
		expect(isClientRequest(new Request('https://threads.example/mcp'))).toBe(false);
	});

	it('redirects share-sheet posts into the app with their text fields', async () => {
		const form = new FormData();
		form.set('title', 'An article');
		form.set('url', 'https://example.com/a?b=1');
		form.set('files', new File(['x'], 'x.txt'));
		const response = await shareTargetRedirect(
			new Request('https://threads.example/share-target', { method: 'POST', body: form })
		);

		expect(response?.status).toBe(303);
		const location = new URL(response!.headers.get('Location')!);
		expect(location.origin).toBe('https://threads.example');
		expect(location.pathname).toBe('/');
		expect(location.searchParams.get('share-target')).toBe('1');
		expect(location.searchParams.get('title')).toBe('An article');
		expect(location.searchParams.get('url')).toBe('https://example.com/a?b=1');
		expect(location.searchParams.has('files')).toBe(false);

		expect(await shareTargetRedirect(new Request('https://threads.example/share-target'))).toBeNull();
		expect(
			await shareTargetRedirect(new Request('https://threads.example/api/messages', { method: 'POST' }))
		).toBeNull();
	});
});
