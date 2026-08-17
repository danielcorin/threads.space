import { api, setUnauthorizedHandler, UnauthorizedError } from '$lib/api.js';
import type { LoginResponse } from '$lib/api.js';

export interface User {
	id: string;
	username: string;
	email: string | null;
	email_verified_at: number | null;
	display_name: string | null;
	name_color: string | null;
	code_theme: string | null;
	avatar_url: string | null;
	role: string | null;
	ephemeral_bot_id: string | null;
	is_admin: number;
	created_at: number;
}

let _user = $state<User | null>(null);
let _checked = $state(false);

function persistUser(user: User) {
	_user = user;
	_checked = true;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem('threads_user', JSON.stringify(user));
	}
}

// Any 401 means the session is dead: drop the cached user so the layout
// effect redirects to /login instead of leaving a frozen app.
setUnauthorizedHandler(() => {
	if (_user === null) return;
	_user = null;
	_checked = true;
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem('threads_user');
	}
});

export const auth = {
	get user() {
		return _user;
	},
	get checked() {
		return _checked;
	},
	get loggedIn() {
		return _user !== null;
	},

	setUser(user: User | null) {
		_user = user;
		_checked = true;
	},

	async login(username: string, password: string): Promise<LoginResponse> {
		const result = await api.login(username, password);
		if (result.next === 'complete') persistUser(result as User);
		return result;
	},

	async completeMfa(code: string): Promise<User> {
		const result = await api.completeMfa(code);
		const user = result as User;
		persistUser(user);
		return user;
	},

	updateDisplayName(displayName: string | null) {
		if (_user) {
			_user = { ..._user, display_name: displayName };
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('threads_user', JSON.stringify(_user));
			}
		}
	},

	updateNameColor(nameColor: string | null) {
		if (_user) {
			_user = { ..._user, name_color: nameColor };
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('threads_user', JSON.stringify(_user));
			}
		}
	},

	updateEmail(email: string | null, emailVerifiedAt: number | null) {
		if (_user) {
			_user = { ..._user, email, email_verified_at: emailVerifiedAt };
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('threads_user', JSON.stringify(_user));
			}
		}
	},

	updateEphemeralBotId(ephemeralBotId: string | null) {
		if (_user) {
			_user = { ..._user, ephemeral_bot_id: ephemeralBotId };
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('threads_user', JSON.stringify(_user));
			}
		}
	},

	logout() {
		// Fire-and-forget: server-side session deletion is best-effort, so don't
		// block the redirect on it. Awaiting this round-trip froze logout on a
		// cold worker / stalled network — clear local state and navigate now.
		api.logout().catch(() => {
			// ignore errors during logout
		});
		_user = null;
		if (typeof localStorage !== 'undefined') {
			localStorage.removeItem('threads_user');
			localStorage.removeItem('threads_last_channel');
		}
		// Hard navigation, not goto(): module-level stores (message caches,
		// channels, DMs) still hold this user's data, and the next login on
		// this tab must not see any of it. A full reload resets everything.
		if (typeof location !== 'undefined') {
			location.href = '/login';
		}
	},

	/**
	 * Check if we have a valid session. We restore the cached user from
	 * localStorage and verify it by hitting an authenticated endpoint.
	 */
	async checkSession(): Promise<boolean> {
		if (typeof localStorage !== 'undefined') {
			const cached = localStorage.getItem('threads_user');
			if (cached) {
				try {
					// Verify the session cookie is still valid by fetching channels
					await api.channels.list();
					_user = JSON.parse(cached);
					_checked = true;
					return true;
				} catch (e) {
					const status = (e as Error & { status?: number }).status;
					if (e instanceof UnauthorizedError || status === 403) {
						// The session is actually dead — drop the cached user.
						localStorage.removeItem('threads_user');
					} else {
						// Transient failure (offline, timeout, 5xx): keep the cached
						// user and proceed optimistically; a real 401 later resets auth.
						try {
							_user = JSON.parse(cached);
							_checked = true;
							return true;
						} catch {
							localStorage.removeItem('threads_user');
						}
					}
				}
			}
		}
		_checked = true;
		return false;
	}
};
