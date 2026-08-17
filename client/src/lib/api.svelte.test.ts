import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, UnauthorizedError } from './api.js';
import { auth, type User } from './state/auth.svelte.js';

const testUser: User = {
	id: 'u1',
	username: 'dan',
	email: 'dan@example.com',
	email_verified_at: 1,
	display_name: null,
	name_color: null,
	code_theme: null,
	avatar_url: null,
	role: null,
	ephemeral_bot_id: null,
	is_admin: 0,
	created_at: 0
};

function stubFetch(status: number, body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status }))
	);
}

describe('api request auth handling', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		auth.setUser(null);
		localStorage.removeItem('threads_user');
	});

	it('throws UnauthorizedError and resets auth on 401', async () => {
		auth.setUser(testUser);
		localStorage.setItem('threads_user', JSON.stringify(testUser));

		stubFetch(401, { error: 'Unauthorized' });

		await expect(api.channels.list()).rejects.toBeInstanceOf(UnauthorizedError);
		expect(auth.loggedIn).toBe(false);
		expect(localStorage.getItem('threads_user')).toBeNull();
	});

	it('keeps auth state on 500 errors', async () => {
		auth.setUser(testUser);
		stubFetch(500, { error: 'boom' });

		let caught: unknown;
		try {
			await api.channels.list();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(UnauthorizedError);
		expect(auth.loggedIn).toBe(true);
	});

	it('requests an email change with password re-authorization', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({
			ok: true,
			verified: false,
			pendingEmail: 'new@example.com',
			expiresAt: 123,
		}), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(api.users.requestEmailChange('new@example.com', 'current-password')).resolves.toMatchObject({
			pendingEmail: 'new@example.com',
		});
		expect(fetchMock).toHaveBeenCalledWith('/api/users/me/email/change', expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ email: 'new@example.com', currentPassword: 'current-password' }),
		}));
	});

	it('updates the cached verified email after confirmation', () => {
		auth.setUser(testUser);
		auth.updateEmail('verified@example.com', 123);

		expect(auth.user).toMatchObject({ email: 'verified@example.com', email_verified_at: 123 });
		expect(JSON.parse(localStorage.getItem('threads_user') ?? '{}')).toMatchObject({
			email: 'verified@example.com',
			email_verified_at: 123,
		});
	});
});

describe('checkSession startup resilience', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		auth.setUser(null);
		localStorage.removeItem('threads_user');
	});

	it('keeps the cached user when the verification request fails transiently', async () => {
		localStorage.setItem('threads_user', JSON.stringify(testUser));
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new TypeError('Failed to fetch'); // offline
		}));

		const ok = await auth.checkSession();
		expect(ok).toBe(true);
		expect(auth.loggedIn).toBe(true);
		expect(localStorage.getItem('threads_user')).not.toBeNull();
	});

	it('keeps the cached user on a 500', async () => {
		localStorage.setItem('threads_user', JSON.stringify(testUser));
		stubFetch(500, { error: 'boom' });

		const ok = await auth.checkSession();
		expect(ok).toBe(true);
		expect(auth.loggedIn).toBe(true);
	});

	it('drops the cached user on 401', async () => {
		localStorage.setItem('threads_user', JSON.stringify(testUser));
		stubFetch(401, { error: 'Unauthorized' });

		const ok = await auth.checkSession();
		expect(ok).toBe(false);
		expect(auth.loggedIn).toBe(false);
		expect(localStorage.getItem('threads_user')).toBeNull();
	});
});
