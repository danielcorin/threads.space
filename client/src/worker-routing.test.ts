import { describe, expect, it } from 'vitest';
import { isClientRequest, requestForApi } from '../worker/routing.js';

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
});
