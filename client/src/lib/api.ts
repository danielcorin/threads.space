export interface Widget {
	id: string;
	name: string;
	description: string | null;
	icon: string;
	created_by: string;
	created_at: string;
	updated_at: string | null;
}

import type { ApiChannel, ApiChannelBrowseItem, ApiChannelListItem, ApiInboxPage, ApiMessage, ApiMessagePage } from './api-types.js';

export const API_BASE = import.meta.env.VITE_API_URL || '/api';

export type ApiTokenScope =
	| 'threads:read'
	| 'threads:write'
	| 'users:provision'
	| 'tokens:manage';

export interface CurrentUserResponse {
	id: string;
	username: string;
	email: string | null;
	email_verified_at: number | null;
	pending_email: string | null;
	email_verification_expires_at: number | null;
	display_name: string | null;
	name_color: string | null;
	code_theme: string | null;
	role: string | null;
	ephemeral_bot_id: string | null;
	bot_capabilities: unknown;
}

export interface EmailVerificationResponse {
	ok: true;
	verified: boolean;
	email?: string | null;
	pendingEmail: string | null;
	expiresAt: number | null;
}

export interface MfaSetup {
	secret: string;
	otpauthUri: string;
	expiresAt?: number;
}

export interface AuthenticatedUserResponse {
	id: string;
	username: string;
	email: string | null;
	email_verified_at: number | null;
	display_name: string | null;
	name_color: string | null;
	code_theme: string | null;
	avatar_url: string | null;
	role: string | null;
	bot_capabilities_json: string | null;
	ephemeral_bot_id: string | null;
	is_admin: number;
	created_at: number;
}

export type LoginResponse =
	| (AuthenticatedUserResponse & { next: 'complete' })
	| { next: 'verify_mfa' }
	| { next: 'enroll_mfa'; setup: MfaSetup };

export interface MySecurityResponse {
	mfaEnabled: boolean;
	mfaRequired: boolean;
	enrollmentExpiresAt: number | null;
	email: string | null;
	emailVerified: boolean;
}

export interface WorkspaceSecurityUser {
	id: string;
	username: string;
	display_name: string | null;
	email: string | null;
	email_verified_at: number | null;
	is_admin: number;
	mfa_enabled: number;
}

export interface WorkspaceSecurityResponse {
	requireMfaForHumans: boolean;
	enrolledHumans: number;
	totalHumans: number;
	unverifiedHumans: number;
	users: WorkspaceSecurityUser[];
}

/** Thrown for 401 responses: the session is gone, not a transient failure. */
export class UnauthorizedError extends Error {
	constructor(message = 'Unauthorized') {
		super(message);
		this.name = 'UnauthorizedError';
	}
}

// Registered by the auth store; called once per 401 so an expired session
// resets auth state (and the layout effect redirects to /login) instead of
// leaving a frozen app whose requests all silently fail.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
	onUnauthorized = fn;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(options.headers as Record<string, string>)
		},
		...options
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: res.statusText }));
		if (res.status === 401) {
			onUnauthorized?.();
			throw new UnauthorizedError(error.error || res.statusText);
		}
		const err = new Error(error.error || res.statusText) as Error & { status?: number };
		err.status = res.status;
		throw err;
	}
	return res.json();
}

export const api = {
	login: (username: string, password: string) =>
		request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

	completeMfa: (code: string) =>
		request<AuthenticatedUserResponse & { next: 'complete' }>('/auth/mfa/complete', {
			method: 'POST',
			body: JSON.stringify({ code })
		}),

	cancelMfa: () => request<{ ok: true }>('/auth/mfa/cancel', { method: 'POST' }),

	logout: () => request('/auth/logout', { method: 'POST' }),

	channels: {
		list: () => request<ApiChannelListItem[]>('/channels'),
		browse: () => request<ApiChannelBrowseItem[]>('/channels/browse'),
		get: (id: string) => request<ApiChannel>(`/channels/${id}`),
		create: (name: string, description?: string, isPrivate?: boolean) =>
			request('/channels', {
				method: 'POST',
				body: JSON.stringify({ name, description, isPrivate })
			}),
		createEphemeral: () =>
			request<any>('/channels/ephemeral', { method: 'POST', body: '{}' }),
		archive: (id: string) =>
			request<{ ok: boolean; archived_at: number }>(`/channels/${id}/archive`, { method: 'POST' }),
		unarchive: (id: string) =>
			request<{ ok: boolean; archived_at: null }>(`/channels/${id}/archive`, { method: 'DELETE' }),
		promote: (id: string, name: string) =>
			request<{ ok: boolean; id: string; channelId: string; name: string }>(`/channels/${id}/promote`, {
				method: 'POST',
				body: JSON.stringify({ name })
			}),
		update: (id: string, data: { name?: string; description?: string; processing_mode?: string; board_enabled?: number; auto_respond_bot_id?: string | null }) =>
			request(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
		delete: (id: string) => request(`/channels/${id}`, { method: 'DELETE' }),
		join: (id: string) => request(`/channels/${id}/join`, { method: 'POST' }),
		leave: (id: string) => request(`/channels/${id}/leave`, { method: 'POST' }),
		leaveMembership: (id: string) => request<{ ok: boolean }>(`/channels/${id}/membership`, { method: 'DELETE' }),
		members: (id: string) => request<any[]>(`/channels/${id}/members`),
		addMember: (channelId: string, userIdOrUsername: string) =>
			request(`/channels/${channelId}/members`, {
				method: 'POST',
				body: JSON.stringify({ userId: userIdOrUsername })
			}),
		addMemberByUsername: (channelId: string, username: string) =>
			request(`/channels/${channelId}/members`, {
				method: 'POST',
				body: JSON.stringify({ username })
			}),
		removeMember: (channelId: string, userId: string) =>
			request(`/channels/${channelId}/members/${userId}`, { method: 'DELETE' }),
		markRead: (channelId: string) =>
			request(`/channels/${channelId}/read`, { method: 'POST' }),
		getDraft: (channelId: string) =>
			request<{ content: string; attachments: Array<{ id: string; filename: string; contentType: string; sizeBytes: number; url: string }> }>(`/channels/${channelId}/draft`),
		saveDraft: (channelId: string, content: string, attachmentIds?: string[]) =>
			request(`/channels/${channelId}/draft`, {
				method: 'PUT',
				body: JSON.stringify({ content, attachment_ids: attachmentIds })
			}),
		pins: (channelId: string) =>
			request<any[]>(`/channels/${channelId}/pins`),
		pin: (channelId: string, messageId: string) =>
			request(`/channels/${channelId}/pins`, {
				method: 'POST',
				body: JSON.stringify({ messageId })
			}),
		unpin: (channelId: string, messageId: string) =>
			request(`/channels/${channelId}/pins/${messageId}`, { method: 'DELETE' }),
		updateNotifications: (channelId: string, tier: 'all' | 'mentions' | 'none') =>
			request<{ ok: boolean; tier: string }>(`/channels/${channelId}/notifications`, {
				method: 'PATCH',
				body: JSON.stringify({ tier })
			})
	},

	markRead: (channelId: string) =>
		request(`/channels/${channelId}/read`, { method: 'POST' }),

	uploads: {
		upload: async (file: File): Promise<{ id: string; filename: string; contentType: string; sizeBytes: number; url: string }> => {
			const formData = new FormData();
			formData.append('file', file);
			const res = await fetch(`${API_BASE}/uploads`, {
				method: 'POST',
				credentials: 'include',
				body: formData,
			});
			if (!res.ok) {
				const error = await res.json().catch(() => ({ error: res.statusText }));
				throw new Error(error.error || res.statusText);
			}
			return res.json();
		},
	},

	// Voice-to-text: POST a recorded audio clip; the server runs it through
	// Workers AI Whisper and returns the transcription for the composer.
	transcribe: async (audio: Blob): Promise<{ text: string }> => {
		const res = await fetch(`${API_BASE}/transcribe`, {
			method: 'POST',
			credentials: 'include',
			// Forward the recorder's mime type so the server's audio/* check passes
			// and Whisper knows the container; fall back for browsers that omit it.
			headers: { 'Content-Type': audio.type || 'audio/webm' },
			body: audio,
		});
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: res.statusText }));
			throw new Error(error.error || res.statusText);
		}
		return res.json();
	},

		messages: {
		list: (channelId: string, cursor?: string) =>
			request<ApiMessagePage>(
				`/channels/${channelId}/messages?view=conversation${cursor ? `&cursor=${cursor}` : ''}`
			),
		listAround: (channelId: string, around: string) =>
			request<ApiMessagePage>(`/channels/${channelId}/messages?view=conversation&around=${around}`),
		listAfter: (channelId: string, after: string) =>
			request<ApiMessagePage>(`/channels/${channelId}/messages?view=conversation&after=${after}`),
		send: (
			channelId: string,
			content: string,
			threadId?: string,
			attachmentIds?: string[],
			metadata?: Record<string, unknown>,
			idempotencyKey?: string
		) =>
			request<ApiMessage>(`/channels/${channelId}/messages`, {
				method: 'POST',
				body: JSON.stringify({ content, threadId, attachmentIds, metadata, idempotencyKey })
			}),
		edit: (id: string, content: string) =>
			request(`/messages/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) }),
		delete: (id: string) => request(`/messages/${id}`, { method: 'DELETE' }),
		resolve: (id: string) =>
			request<{ ok: boolean; resolved_at: number; resolved_by: string }>(`/messages/${id}/resolve`, { method: 'POST' }),
		unresolve: (id: string) => request(`/messages/${id}/resolve`, { method: 'DELETE' }),
		setThreadTitle: (id: string, title: string) =>
			request<{ ok: true; applied: boolean; thread_id: string; thread_title: string; thread_title_updated_at: number }>(
				`/messages/${id}/thread-title`,
				{ method: 'PUT', body: JSON.stringify({ title }) }
			),
			get: (id: string) => request<ApiMessage>(`/messages/${id}`),
			markRead: (id: string) =>
				request<{ ok: true }>(`/messages/${id}/read`, { method: 'POST' }),
			reply: (id: string, content: string, idempotencyKey?: string) =>
				request<ApiMessage>(`/messages/${id}/replies`, {
					method: 'POST',
					body: JSON.stringify({ content, idempotencyKey })
				}),
		},

		inbox: {
			list: (cursor?: string) =>
				request<ApiInboxPage>(
					`/inbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
				),
		},

	reactions: {
		add: (messageId: string, emoji: string) =>
			request(`/messages/${messageId}/reactions`, {
				method: 'POST',
				body: JSON.stringify({ emoji })
			}),
		remove: (messageId: string, emoji: string) =>
			request(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
				method: 'DELETE'
			})
	},

	drafts: {
		list: () => request<{ channel_ids: string[] }>('/drafts')
	},

	savedDrafts: {
		list: (channelId: string) =>
			request<{ id: string; channel_id: string; user_id: string; content: string; created_at: string; updated_at: string; scheduled_at: string | null }[]>(`/channels/${channelId}/saved-drafts`),
		create: (channelId: string, content: string) =>
			request<{ id: string; channel_id: string; user_id: string; content: string; created_at: string; updated_at: string; scheduled_at: string | null }>(`/channels/${channelId}/saved-drafts`, {
				method: 'POST',
				body: JSON.stringify({ content })
			}),
		delete: (draftId: string) =>
			request<{ ok: boolean }>(`/saved-drafts/${draftId}`, { method: 'DELETE' }),
		schedule: (draftId: string, scheduledAt: string) =>
			request<{ id: string; channel_id: string; user_id: string; content: string; created_at: string; updated_at: string; scheduled_at: string | null }>(`/saved-drafts/${draftId}/schedule`, {
				method: 'PATCH',
				body: JSON.stringify({ scheduled_at: scheduledAt })
			}),
		unschedule: (draftId: string) =>
			request<{ id: string; channel_id: string; user_id: string; content: string; created_at: string; updated_at: string; scheduled_at: null }>(`/saved-drafts/${draftId}/schedule`, {
				method: 'PATCH',
				body: JSON.stringify({ scheduled_at: null })
			}),
	},

	users: {
		security: () => request<MySecurityResponse>('/users/me/security'),
		startMfaEnrollment: (currentPassword: string) =>
			request<MfaSetup & { expiresAt: number }>('/users/me/mfa/enrollment', {
				method: 'POST',
				body: JSON.stringify({ currentPassword })
			}),
		confirmMfaEnrollment: (code: string) =>
			request<{ ok: true; mfaEnabled: true }>('/users/me/mfa/enrollment/confirm', {
				method: 'POST',
				body: JSON.stringify({ code })
			}),
		disableMfa: (currentPassword: string, code: string) =>
			request<{ ok: true; mfaEnabled: false }>('/users/me/mfa', {
				method: 'DELETE',
				body: JSON.stringify({ currentPassword, code })
			}),
		updateProfile: (data: { displayName?: string; nameColor?: string | null; codeTheme?: string | null; ephemeralBotId?: string | null }) =>
			request<any>('/users/me', {
				method: 'PATCH',
				body: JSON.stringify(data)
			}),
		updateDisplayName: (displayName: string) =>
			request<any>('/users/me', {
				method: 'PATCH',
				body: JSON.stringify({ displayName })
			}),
		changePassword: (currentPassword: string, newPassword: string) =>
			request<{ ok: boolean }>('/auth/change-password', {
				method: 'POST',
				body: JSON.stringify({ currentPassword, newPassword })
			}),
		requestEmailChange: (email: string, currentPassword: string) =>
			request<EmailVerificationResponse>('/users/me/email/change', {
				method: 'POST',
				body: JSON.stringify({ email, currentPassword })
			}),
		resendEmailVerification: () =>
			request<EmailVerificationResponse>('/users/me/email/verification/resend', {
				method: 'POST'
			}),
		create: (data: { username: string; password: string; email?: string; displayName?: string; role?: 'human' | 'bot' }) =>
			request<{
				id: string;
				username: string;
				email: string | null;
				displayName: string | null;
				emailVerificationSent: boolean;
				emailVerificationExpiresAt: number | null;
			}>('/users', {
				method: 'POST',
				body: JSON.stringify(data)
			}),
		createApiToken: (
			name: string,
			scopes: ApiTokenScope[],
			expiresInDays: number | null
		) =>
			request<{
				token: string;
				id: string;
				name: string;
				scopes: ApiTokenScope[];
				expires_at: number | null;
			}>('/users/me/api-tokens', {
				method: 'POST',
				body: JSON.stringify({ name, scopes, expires_in_days: expiresInDays })
			}),
		listApiTokens: () =>
			request<{
				tokens: {
					id: string;
					name: string;
					scopes: ApiTokenScope[];
					expires_at: number | null;
					created_at: number;
					last_used_at: number | null;
				}[];
			}>('/users/me/api-tokens'),
		revokeApiToken: (id: string) =>
			request<{ ok: boolean; connections_closed: number }>(`/users/me/api-tokens/${id}`, { method: 'DELETE' }),
		search: (query: string, channelId?: string) =>
			request<any[]>(
				`/users/search?q=${encodeURIComponent(query)}${channelId ? `&channel=${channelId}` : ''}`
			),
		listBots: () =>
			request<{ id: string; username: string; display_name: string | null; name_color: string | null; avatar_url: string | null }[]>(
				'/users/bots'
			),
		me: () => request<CurrentUserResponse>('/users/me'),
		frequentEmojis: () => request<string[]>('/users/me/frequent-emojis')
	},

	workspace: {
		security: () => request<WorkspaceSecurityResponse>('/workspace/security'),
		updateSecurity: (requireMfaForHumans: boolean, currentPassword: string, code?: string) =>
			request<WorkspaceSecurityResponse>('/workspace/security', {
				method: 'PATCH',
				body: JSON.stringify({ requireMfaForHumans, currentPassword, code })
			}),
		resetUserMfa: (userId: string, currentPassword: string, code?: string) =>
			request<{ ok: true; targetUserId: string }>(`/users/${userId}/mfa`, {
				method: 'DELETE',
				body: JSON.stringify({ currentPassword, code })
			})
	},

	mentions: () =>
		request<{ messages: any[] }>('/mentions'),

	search: (
		query: string,
		opts: {
			channelId?: string;
			fromUserId?: string;
			since?: number;
			until?: number;
			has?: string;
			offset?: number;
			limit?: number;
		} = {}
	) => {
		const params = new URLSearchParams({ q: query });
		if (opts.channelId) params.set('channel', opts.channelId);
		if (opts.fromUserId) params.set('from', opts.fromUserId);
		if (opts.since != null) params.set('since', String(opts.since));
		if (opts.until != null) params.set('until', String(opts.until));
		if (opts.has) params.set('has', opts.has);
		if (opts.offset != null) params.set('offset', String(opts.offset));
		if (opts.limit != null) params.set('limit', String(opts.limit));
		return request<{
			results: any[];
			total: number;
			hasMore: boolean;
			offset: number;
			limit: number;
		}>(`/search?${params.toString()}`);
	},

	widgets: {
		listForChannel: (channelId: string) =>
			request<Widget[]>(`/channels/${channelId}/widgets`),
		addToChannel: (channelId: string, widgetId: string) =>
			request(`/channels/${channelId}/widgets`, { method: 'POST', body: JSON.stringify({ widgetId }) }),
		removeFromChannel: (channelId: string, widgetId: string) =>
			request(`/channels/${channelId}/widgets/${widgetId}`, { method: 'DELETE' }),
	},

	dms: {
		list: () => request<any[]>('/dms'),
		createOrGet: (userId: string) =>
			request<any>('/dms', { method: 'POST', body: JSON.stringify({ userId }) }),
		hide: (id: string) =>
			request<{ ok: boolean }>(`/dms/${id}/hide`, { method: 'PATCH' }),
		reorder: (items: { id: string; position: number }[]) =>
			request<{ ok: boolean }>('/dms/reorder', { method: 'PUT', body: JSON.stringify({ items }) })
	},

	folders: {
		list: () => request<any[]>('/folders'),
		create: (name: string) =>
			request('/folders', { method: 'POST', body: JSON.stringify({ name }) }),
		update: (id: string, data: { name?: string; position?: number; collapsed?: number }) =>
			request(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
		delete: (id: string) =>
			request(`/folders/${id}`, { method: 'DELETE' }),
		addChannel: (folderId: string, channelId: string, position?: number) =>
			request(`/folders/${folderId}/channels`, {
				method: 'POST',
				body: JSON.stringify({ channelId, position })
			}),
		removeChannel: (folderId: string, channelId: string) =>
			request(`/folders/${folderId}/channels/${channelId}`, { method: 'DELETE' }),
		reorder: (data: { folders?: { id: string; position: number }[]; items?: { folderId: string; channelId: string; position: number }[] }) =>
			request('/folders/reorder', { method: 'PUT', body: JSON.stringify(data) }),
	},

	boards: {
		get: (channelId: string) =>
			request<{ board: any; cards: any[] }>(`/channels/${channelId}/board`),
		create: (channelId: string) =>
			request<any>(`/channels/${channelId}/board`, { method: 'POST' }),
		createCard: (channelId: string, data: { title: string; description?: string; assignee?: string; priority?: string; column_key?: string }) =>
			request<any>(`/channels/${channelId}/board/cards`, { method: 'POST', body: JSON.stringify(data) }),
		updateCard: (cardId: string, data: { title?: string; description?: string; column_key?: string; assignee?: string | null; priority?: string; position?: number }) =>
			request<any>(`/boards/cards/${cardId}`, { method: 'PUT', body: JSON.stringify(data) }),
		deleteCard: (cardId: string) =>
			request<{ ok: boolean }>(`/boards/cards/${cardId}`, { method: 'DELETE' }),
	},

	processes: {
		list: (status?: string) =>
			request<{ processes: any[] }>(`/processes${status ? `?status=${encodeURIComponent(status)}` : ''}`),
		// Cooperative cancel: marks the run killed and signals the owning agent
		// over WebSocket + webhook so it can stop on its own.
		kill: (id: string) => request<{ ok: boolean }>(`/processes/${id}`, { method: 'DELETE' }),
		killAll: () =>
			request<{ cleaned: number; process_ids: string[] }>('/processes/kill-all', { method: 'POST' })
	}
};
