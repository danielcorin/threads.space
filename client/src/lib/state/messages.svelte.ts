import { api } from '$lib/api.js';

export function compareMessages(a: Message, b: Message): number {
	const aOptimistic = !!a.client_delivery_status;
	const bOptimistic = !!b.client_delivery_status;
	if (aOptimistic !== bOptimistic) return aOptimistic ? 1 : -1;
	if (aOptimistic && bOptimistic && a.created_at !== b.created_at) {
		return a.created_at - b.created_at;
	}
	return a.id.localeCompare(b.id);
}

/** Deduplicate and sort persisted ULIDs chronologically, with local rows last. */
function dedupeAndSort(msgs: Message[]): Message[] {
	const seen = new Map<string, Message>();
	for (const m of msgs) {
		seen.set(m.id, m);
	}
	return [...seen.values()].sort(compareMessages);
}

function isOptimisticMessage(message: Message): boolean {
	return message.client_delivery_status === 'sending' || message.client_delivery_status === 'failed';
}

/**
 * Match a server echo to the local row that was rendered before the request
 * completed. Sends from one composer are delivered in order, so the first
 * same-author/content match is the corresponding optimistic message even when
 * several requests are in flight.
 */
function findOptimisticMatch(messages: Message[], incoming: Message): number {
	if (isOptimisticMessage(incoming)) return -1;
	return messages.findIndex((candidate) =>
		isOptimisticMessage(candidate) &&
		candidate.channel_id === incoming.channel_id &&
		candidate.thread_id === incoming.thread_id &&
		candidate.user_id === incoming.user_id &&
		candidate.content === incoming.content
	);
}

function mergeMessage(existing: Message, incoming: Message): Message {
	const merged = { ...existing, ...incoming };
	// A WebSocket event can omit hydrated arrays that arrive in the POST
	// response shortly afterward. Do not make optimistic attachments or an
	// already-rendered reaction set blink out in between.
	if (existing.attachments?.length && !incoming.attachments?.length) {
		merged.attachments = existing.attachments;
	}
	if (existing.reactions?.length && !incoming.reactions?.length) {
		merged.reactions = existing.reactions;
	}
	if (!isOptimisticMessage(incoming)) {
		delete merged.client_delivery_status;
		delete merged.client_idempotency_key;
	}
	return merged;
}

export function upsertMessage(existing: Message[], incoming: Message): Message[] {
	let idx = existing.findIndex((message) => message.id === incoming.id);
	if (idx < 0) idx = findOptimisticMatch(existing, incoming);
	if (idx < 0) return dedupeAndSort([...existing, incoming]);

	const next = existing.slice();
	next[idx] = mergeMessage(existing[idx], incoming);
	return dedupeAndSort(next);
}

/** Keys checked when detecting whether a message changed */
const TRACKED_KEYS: (keyof Message)[] = [
	'content',
	'edited_at',
	'deleted_at',
	'thread_title',
	'thread_title_updated_at',
	'reply_count',
	'process_status',
	'process_id',
	'process_input_tokens',
	'process_output_tokens',
	'process_cache_creation_input_tokens',
	'process_cache_read_input_tokens',
	'process_error_text',
	'thread_process_id',
	'thread_process_status',
	'message_type'
];

/** Compare JSON-serialised value for array/object fields */
const JSON_COMPARED_KEYS: (keyof Message)[] = ['reactions', 'attachments', 'linkPreviews', 'metadata'];

/**
 * Surgically merge `fresh` messages into `existing` array, mutating only the
 * individual properties that changed so Svelte 5 fine-grained reactivity
 * can skip re-rendering unchanged message components.
 *
 * Returns true if anything was added or changed.
 */
export function mergeMessages(existing: Message[], fresh: Message[]): boolean {
	const existingById = new Map<string, number>();
	for (let i = 0; i < existing.length; i++) {
		existingById.set(existing[i].id, i);
	}

	let changed = false;
	const newMessages: Message[] = [];

	for (const freshMsg of fresh) {
		const idx = existingById.get(freshMsg.id);
		if (idx === undefined) {
			const optimisticIdx = findOptimisticMatch(existing, freshMsg);
			if (optimisticIdx >= 0) {
				const optimisticId = existing[optimisticIdx].id;
				existing[optimisticIdx] = mergeMessage(existing[optimisticIdx], freshMsg);
				existingById.delete(optimisticId);
				existingById.set(freshMsg.id, optimisticIdx);
				changed = true;
				continue;
			}
		}
		if (idx === undefined) {
			newMessages.push(freshMsg);
			changed = true;
			continue;
		}

		// Surgically update only changed scalar fields
		const target = existing[idx];
		for (const key of TRACKED_KEYS) {
			if (target[key] !== freshMsg[key]) {
				(target as any)[key] = freshMsg[key];
				changed = true;
			}
		}
		// Update JSON-compared fields only when serialisation differs
		for (const key of JSON_COMPARED_KEYS) {
			if (JSON.stringify(target[key]) !== JSON.stringify(freshMsg[key])) {
				(target as any)[key] = freshMsg[key];
				changed = true;
			}
		}
		// Copy over display fields that may arrive later
		for (const key of ['username', 'display_name', 'name_color', 'avatar_url'] as (keyof Message)[]) {
			if (freshMsg[key] !== undefined && target[key] !== freshMsg[key]) {
				(target as any)[key] = freshMsg[key];
				changed = true;
			}
		}
	}

	if (newMessages.length > 0) {
		// Insert new messages and re-sort
		existing.push(...newMessages);
		existing.sort(compareMessages);
	}

	return changed;
}

export interface Reaction {
	emoji: string;
	userId: string;
	username: string;
}

export interface Attachment {
	id: string;
	filename: string;
	contentType: string;
	sizeBytes: number;
	url: string;
}

export interface LinkPreview {
	url: string;
	urlHash: string;
	title: string | null;
	description: string | null;
	imageUrl: string | null;
	siteName: string | null;
}

export interface Message {
	id: string;
	channel_id: string;
	is_dm?: number | boolean;
	user_id: string | null;
	content: string | null;
	thread_id: string | null;
	thread_title?: string | null;
	thread_title_updated_at?: number | null;
	type: 'message' | 'system';
	edited_at: number | null;
	deleted_at: number | null;
	created_at: number;
	username?: string;
	display_name?: string | null;
	name_color?: string | null;
	avatar_url?: string | null;
	reactions?: Reaction[];
	reply_count?: number;
	attachments?: Attachment[];
	linkPreviews?: LinkPreview[];
	process_id?: string | null;
	process_status?: string | null;
	process_input_tokens?: number;
	process_output_tokens?: number;
	process_cache_creation_input_tokens?: number;
	process_cache_read_input_tokens?: number;
	process_error_text?: string | null;
	thread_process_id?: string | null;
	thread_process_status?: string | null;
	pinned?: number;
	/** Unix seconds when a channel member marked this thread resolved; null/absent = unresolved. */
	resolved_at?: number | null;
	resolved_by?: string | null;
	message_type?: string;
	/** Client-only state for a row rendered before its create request settles. */
	client_delivery_status?: 'sending' | 'failed';
	/** Client-only correlation key; never persisted as message metadata. */
	client_idempotency_key?: string;
	metadata?: {
		/** Id of the message that triggered this agent run; set on agent step
		 * messages (progress / tool_output / thinking) so the client can collapse
		 * a whole run into one AgentSteps block anchored to its trigger. */
		trigger_id?: string;
		memories?: Array<{ label: string; content: string; relevance?: string }>;
		memory_searches?: Array<{ query: string; count?: number }>;
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
		tokenUsage?: { input: number; output: number };
		/** Model used to generate this message (set by tela when responding via DM picker). */
		response_model?: string;
		/** Model requested by the user for this incoming message (set by client picker). */
		model?: string;
	} | null;
}

interface ChannelCache {
	messages: Message[];
	cursor: string | null;
	hasMore: boolean;
	afterCursor: string | null;
	hasNewer: boolean;
}

const FETCH_TIMEOUT_MS = 15_000;

let _messages = $state<Message[]>([]);
let _loading = $state(false);
let _loadingMore = $state(false);
let _loadingNewer = $state(false);
let _hasMore = $state(false);
let _hasNewer = $state(false);
let _cursor = $state<string | null>(null);
let _afterCursor = $state<string | null>(null);
let _channelId = $state<string | null>(null);
/** True when the initial load for the current channel failed (show retry, not "No messages yet"). */
let _loadError = $state(false);
/** Incremented whenever a channel load is requested so the UI can apply initial scroll even from cache. */
let _loadGeneration = $state(0);
/** The ID of the first unread message after an anchored load. Null = no anchor / scroll to bottom. */
let _firstUnreadId = $state<string | null>(null);
type PendingAnchorLoad = { anchorId: string; showUnreadDivider: boolean };

const _pendingAnchorLoads = new Map<string, PendingAnchorLoad>();
/** Set of channel IDs where the unread divider has been dismissed this session. */
const _dismissedDividers = new Set<string>();

const _cache = new Map<string, ChannelCache>();
// Bound memory: a long session touching many channels would otherwise grow
// the cache (and each channel's scrollback array) without limit.
const MAX_CACHED_CHANNELS = 20;
const MAX_CACHED_MESSAGES = 200;

function _fetchWithTimeout<T>(promise: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Fetch timeout')), FETCH_TIMEOUT_MS);
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

function _updateCache(channelId: string) {
	// Trim long scrollback; adjust the cursor so loadMore can re-fetch the
	// trimmed range instead of skipping past it.
	let messages = _messages;
	let cursor = _cursor;
	let hasMore = _hasMore;
	if (messages.length > MAX_CACHED_MESSAGES) {
		messages = messages.slice(-MAX_CACHED_MESSAGES);
		cursor = messages[0]?.id ?? null;
		hasMore = true;
	}
	// LRU: re-insert to refresh recency, evict the oldest entry over the cap
	_cache.delete(channelId);
	_cache.set(channelId, {
		messages,
		cursor,
		hasMore,
		afterCursor: _afterCursor,
		hasNewer: _hasNewer,
	});
	if (_cache.size > MAX_CACHED_CHANNELS) {
		const oldest = _cache.keys().next().value;
		if (oldest !== undefined) _cache.delete(oldest);
	}
}

function _syncCache() {
	if (_channelId) {
		_updateCache(_channelId);
	}
}

async function _refreshInBackground(channelId: string) {
	try {
		const data = await api.messages.list(channelId);
		if (_channelId !== channelId) return;
		const fresh = data.messages as Message[];

		if (mergeMessages(_messages, fresh)) {
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_syncCache();
		}
	} catch (e) {
		console.error('Failed to refresh messages in background:', e);
	}
}

export const messages = {
	get list() {
		return _messages;
	},
	get loading() {
		return _loading;
	},
	get loadingMore() {
		return _loadingMore;
	},
	get hasMore() {
		return _hasMore;
	},
	get hasNewer() {
		return _hasNewer;
	},
	get loadingNewer() {
		return _loadingNewer;
	},
	get channelId() {
		return _channelId;
	},
	get loadError() {
		return _loadError;
	},
	get loadGeneration() {
		return _loadGeneration;
	},
	get firstUnreadId() {
		return _firstUnreadId;
	},

	requestAnchorLoad(channelId: string, anchorId: string, options: { showUnreadDivider?: boolean } = {}) {
		_pendingAnchorLoads.set(channelId, {
			anchorId,
			showUnreadDivider: options.showUnreadDivider ?? false,
		});
	},

	consumeAnchorLoad(channelId: string) {
		const anchorLoad = _pendingAnchorLoads.get(channelId) ?? null;
		if (anchorLoad) _pendingAnchorLoads.delete(channelId);
		return anchorLoad;
	},

	async load(channelId: string) {
		_channelId = channelId;
		_loadGeneration += 1;

		// Check cache first. Do not reuse an anchored mid-history cache for a
		// normal load: that state is created by jump-to-unread and has newer
		// messages beyond the current window. Once unread is cleared, reopening the
		// DM/channel should fetch the latest page and scroll to the bottom instead
		// of restoring the stale middle-of-history window.
		const cached = _cache.get(channelId);
		if (cached && !cached.hasNewer) {
			_messages = cached.messages;
			_cursor = cached.cursor;
			_hasMore = cached.hasMore;
			_afterCursor = cached.afterCursor;
			_hasNewer = cached.hasNewer;
			_loading = false;
			_loadError = false;
			_firstUnreadId = null;
			// Refresh in background without blocking
			_refreshInBackground(channelId);
			return;
		}

		_loading = true;
		_loadError = false;
		_messages = [];
		_cursor = null;
		_hasMore = false;
		_afterCursor = null;
		_hasNewer = false;
		_firstUnreadId = null;
		try {
			const data = await _fetchWithTimeout(api.messages.list(channelId));
			if (_channelId !== channelId) return;
			_messages = data.messages as Message[];
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_updateCache(channelId);
		} catch (e) {
			console.error('Failed to load messages:', e);
			if (_channelId === channelId) _loadError = true;
		} finally {
			if (_channelId === channelId) _loading = false;
		}
	},

	/** Retry the initial load for the current channel after a failure. */
	async retryLoad() {
		if (!_channelId) return;
		await this.load(_channelId);
	},

	/** Re-fetch the latest page of messages without clearing existing state. Used for foreground refresh. */
	async refreshLatest() {
		if (!_channelId || _loading) return;
		const channelId = _channelId;
		try {
			const data = await api.messages.list(channelId);
			// The user may have switched channels while the fetch was in
			// flight — merging would splice channel A's messages into B.
			if (_channelId !== channelId) return;
			const fresh = data.messages as Message[];

			if (mergeMessages(_messages, fresh)) {
				_syncCache();
			}
		} catch (e) {
			console.error('Failed to refresh messages:', e);
		}
	},

	/**
	 * Page forward from the newest cached message until caught up. Used after a
	 * WS reconnect: anything broadcast while the socket was down never reached
	 * us, so refreshLatest's single page may not cover the gap.
	 */
	async catchUp() {
		if (!_channelId || _loading) return;
		const channelId = _channelId;
		// Anchored mid-history view: the user is paging forward explicitly via
		// loadNewer; the gap beyond the window is fetched there.
		if (_hasNewer) return;
		const last = _messages[_messages.length - 1]?.id;
		if (!last) {
			await this.refreshLatest();
			return;
		}
		let after = last;
		// Bounded loop as a safety net against a pathological gap
		for (let page = 0; page < 50; page++) {
			const data = await api.messages.listAfter(channelId, after);
			if (_channelId !== channelId) return;
			const fresh = data.messages as Message[];
			if (fresh.length > 0) {
				mergeMessages(_messages, fresh);
				_syncCache();
			}
			if (!data.hasNewer || !data.afterCursor) break;
			after = data.afterCursor;
		}
	},

	async loadMore() {
		if (!_channelId || !_cursor || _loadingMore) return;
		_loadingMore = true;
		try {
			const data = await api.messages.list(_channelId, _cursor);
			// Prepend older messages
			_messages = dedupeAndSort([...(data.messages as Message[]), ..._messages]);
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_syncCache();
		} finally {
			_loadingMore = false;
		}
	},

	/** Load messages anchored around a message ID (for jump-to-unread and jump-to-message). */
	async loadAround(channelId: string, anchorId: string, options: { showUnreadDivider?: boolean } = {}) {
		_pendingAnchorLoads.delete(channelId);
		const showUnreadDivider = options.showUnreadDivider ?? true;
		_channelId = channelId;
		_loadGeneration += 1;
		_loading = true;
		_loadError = false;
		_messages = [];
		_cursor = null;
		_hasMore = false;
		_afterCursor = null;
		_hasNewer = false;
		_firstUnreadId = null;
		try {
			const data = await _fetchWithTimeout(api.messages.listAround(channelId, anchorId));
			if (_channelId !== channelId) return;
			_messages = data.messages as Message[];
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_afterCursor = data.afterCursor ?? null;
			_hasNewer = data.hasNewer ?? false;

			if (showUnreadDivider) {
				// Find the first message strictly after the anchor
				const anchorIdx = _messages.findIndex((m) => m.id === anchorId);
				if (anchorIdx >= 0 && anchorIdx < _messages.length - 1) {
					const unreadId = _messages[anchorIdx + 1].id;
					if (!_dismissedDividers.has(channelId)) {
						_firstUnreadId = unreadId;
					}
				}
			}
			_updateCache(channelId);
		} catch (e) {
			console.error('Failed to load messages around anchor:', e);
			// Fallback to normal load — but only if the user is still on this
			// channel; otherwise we'd hijack their navigation.
			if (_channelId === channelId) {
				await this.load(channelId);
			}
		} finally {
			if (_channelId === channelId) _loading = false;
		}
	},

	/** Load newer messages (forward pagination from anchored mid-history view). */
	async loadNewer() {
		if (!_channelId || !_afterCursor || _loadingNewer || !_hasNewer) return;
		_loadingNewer = true;
		try {
			const data = await api.messages.listAfter(_channelId, _afterCursor);
			const fresh = data.messages as Message[];
			_messages = dedupeAndSort([..._messages, ...fresh]);
			_afterCursor = data.afterCursor ?? null;
			_hasNewer = data.hasNewer ?? false;
			_syncCache();
		} finally {
			_loadingNewer = false;
		}
	},

	/** Dismiss the unread divider for the current channel. */
	dismissDivider() {
		if (_channelId) {
			_dismissedDividers.add(_channelId);
		}
		_firstUnreadId = null;
	},

	async send(
		channelId: string,
		content: string,
		threadId?: string,
		attachmentIds?: string[],
		metadata?: Record<string, unknown>,
		idempotencyKey?: string
	) {
		return (await api.messages.send(channelId, content, threadId, attachmentIds, metadata, idempotencyKey)) as Message;
	},

	async edit(messageId: string, content: string) {
		await api.messages.edit(messageId, content);
	},

	async remove(messageId: string) {
		await api.messages.delete(messageId);
	},

	addMessage(msg: Message) {
		if (msg.channel_id === _channelId && !msg.thread_id) {
			_messages = upsertMessage(_messages, msg);
			_syncCache();
		}
	},

	/** Replace the local temporary row with the canonical API response. */
	replaceOptimisticMessage(optimisticId: string, msg: Message) {
		if (msg.channel_id !== _channelId || msg.thread_id) return;
		_messages = upsertMessage(
			_messages.filter((message) => message.id !== optimisticId),
			msg
		);
		_syncCache();
	},

	markMessageFailed(messageId: string) {
		const idx = _messages.findIndex((message) => message.id === messageId);
		if (idx >= 0) {
			_messages[idx] = { ..._messages[idx], client_delivery_status: 'failed' };
			_syncCache();
		}
	},

	updateMessage(messageId: string, updates: Partial<Message>) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			_messages[idx] = { ..._messages[idx], ...updates };
			_syncCache();
		}
	},

	removeMessage(messageId: string) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			_messages[idx] = { ..._messages[idx], deleted_at: Date.now() / 1000, content: null };
			_syncCache();
		}
	},

	addReaction(messageId: string, emoji: string, userId: string, username: string) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _messages[idx];
			const reactions = [...(msg.reactions || [])];
			if (!reactions.find((r) => r.emoji === emoji && r.userId === userId)) {
				reactions.push({ emoji, userId, username });
			}
			_messages[idx] = { ...msg, reactions };
			_syncCache();
		}
	},

	incrementReplyCount(messageId: string) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _messages[idx];
			_messages[idx] = { ...msg, reply_count: (msg.reply_count || 0) + 1 };
			_syncCache();
		}
	},

	decrementReplyCount(messageId: string) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _messages[idx];
			_messages[idx] = { ...msg, reply_count: Math.max(0, (msg.reply_count || 0) - 1) };
			_syncCache();
		}
	},

	updateProcessStatus(messageId: string, processId: string, status: string, inputTokens?: number, outputTokens?: number, cacheCreationInputTokens?: number, cacheReadInputTokens?: number, errorText?: string | null) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const update: Partial<Message> = { process_id: processId, process_status: status };
			if (inputTokens !== undefined || outputTokens !== undefined) {
				update.process_input_tokens = inputTokens ?? 0;
				update.process_output_tokens = outputTokens ?? 0;
			}
			if (cacheCreationInputTokens !== undefined || cacheReadInputTokens !== undefined) {
				update.process_cache_creation_input_tokens = cacheCreationInputTokens ?? 0;
				update.process_cache_read_input_tokens = cacheReadInputTokens ?? 0;
			}
			// Carry error text on terminal status events. Clear it on non-error transitions
			// so retries don't show stale errors.
			if (status === 'error') {
				update.process_error_text = errorText ?? null;
			} else if (status === 'done' || status === 'killed' || status === 'restarted' || status === 'processing' || status === 'queued') {
				update.process_error_text = null;
			}
			_messages[idx] = { ..._messages[idx], ...update };
			_syncCache();
		}
	},

	updateThreadProcessStatus(parentMessageId: string, processId: string, status: string) {
		const idx = _messages.findIndex((m) => m.id === parentMessageId);
		if (idx >= 0) {
			_messages[idx] = { ..._messages[idx], thread_process_id: processId, thread_process_status: status };
			_syncCache();
		}
	},

	removeReaction(messageId: string, emoji: string, userId: string) {
		const idx = _messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _messages[idx];
			const reactions = (msg.reactions || []).filter(
				(r) => !(r.emoji === emoji && r.userId === userId)
			);
			_messages[idx] = { ...msg, reactions };
			_syncCache();
		}
	},

	/**
	 * Reset the active message view. Preserves the per-channel cache so prior
	 * scrollback is still there when navigating back to a channel/DM in the
	 * same session — closing a DM shouldn't clear other channels' history.
	 * Use {@link clearAll} for logout / full reset.
	 */
	clear() {
		_pendingAnchorLoads.clear();
		_messages = [];
		_channelId = null;
		_loadGeneration += 1;
		_loadError = false;
		_cursor = null;
		_hasMore = false;
		_afterCursor = null;
		_hasNewer = false;
		_firstUnreadId = null;
	},

	/** Drop all per-channel caches in addition to active state. Use on logout. */
	clearAll() {
		this.clear();
		_cache.clear();
	}
};
