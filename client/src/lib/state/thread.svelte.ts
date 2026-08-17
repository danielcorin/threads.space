import { API_BASE } from '$lib/api.js';
import { ui } from './ui.svelte.js';
import { compareMessages, mergeMessages, upsertMessage } from './messages.svelte.js';
import type { Message, Reaction } from './messages.svelte.js';

/** Deduplicate and sort messages by ID (ULID — lexicographic = chronological) */
function dedupeAndSort(msgs: Message[]): Message[] {
	const seen = new Map<string, Message>();
	for (const m of msgs) {
		seen.set(m.id, m);
	}
	return [...seen.values()].sort(compareMessages);
}

let _parentMessage = $state<Message | null>(null);
let _replies = $state<Message[]>([]);
let _loading = $state(false);
let _loadingMore = $state(false);
let _loadingNewer = $state(false);
let _hasMore = $state(false);
let _hasNewer = $state(false);
let _cursor = $state<string | null>(null);
let _afterCursor = $state<string | null>(null);
let _open = $state(false);
let _highlightReplyId = $state<string | null>(null);
let _loadError = $state(false);
let _loadGeneration = $state(0);

export const thread = {
	get parentMessage() {
		return _parentMessage;
	},
	get replies() {
		return _replies;
	},
	get loading() {
		return _loading;
	},
	get loadingMore() {
		return _loadingMore;
	},
	get loadingNewer() {
		return _loadingNewer;
	},
	get hasMore() {
		return _hasMore;
	},
	get hasNewer() {
		return _hasNewer;
	},
	get open() {
		return _open;
	},
	get highlightReplyId() {
		return _highlightReplyId;
	},
	set highlightReplyId(id: string | null) {
		_highlightReplyId = id;
	},
	get loadError() {
		return _loadError;
	},
	get loadGeneration() {
		return _loadGeneration;
	},

	async openThread(
		message: Message,
		options: { aroundReplyId?: string | null; highlightReplyId?: string | null } = {}
	) {
		// If this message is a reply, resolve to the thread root
		let rootMessage = message;
		if (message.thread_id) {
			try {
				const res = await fetch(`${API_BASE}/messages/${message.thread_id}`, {
					credentials: 'include'
				});
				if (res.ok) {
					rootMessage = (await res.json()) as Message;
				}
			} catch {
				// Fall back to the message itself
			}
		}
		ui.closeSplitPanel();
		ui.closePinsPanel();
		ui.closeDebugPanel();
		ui.closeSavedDraftsPanel();
		_parentMessage = rootMessage;
		_open = true;
		_loadGeneration += 1;
		_loading = true;
		_loadingMore = false;
		_loadingNewer = false;
		_loadError = false;
		_replies = [];
		_cursor = null;
		_afterCursor = null;
		_hasMore = false;
		_hasNewer = false;
		_highlightReplyId = options.highlightReplyId ?? null;
		try {
			const replyQuery = options.aroundReplyId
				? `around=${encodeURIComponent(options.aroundReplyId)}`
				: 'latest=true';
			const res = await fetch(`${API_BASE}/messages/${rootMessage.id}/replies?${replyQuery}`, {
				credentials: 'include'
			});
			if (!res.ok) throw new Error(`Server error: ${res.status}`);
			const data = (await res.json()) as {
				messages: Message[];
				cursor: string | null;
				afterCursor?: string | null;
				hasNewer?: boolean;
			};
			_replies = data.messages ?? [];
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_afterCursor = data.afterCursor ?? null;
			_hasNewer = data.hasNewer ?? false;
		} catch (err) {
			console.error('Failed to load thread replies:', err);
			_replies = [];
			_loadError = true;
			_afterCursor = null;
			_hasNewer = false;
		} finally {
			_loading = false;
		}
	},

	async loadLatest() {
		if (!_parentMessage) return;
		try {
			const response = await fetch(
				`${API_BASE}/messages/${_parentMessage.id}/replies?latest=true`,
				{ credentials: 'include' }
			);
			if (!response.ok) {
				throw new Error(`Server error: ${response.status}`);
			}
			const data = (await response.json()) as { messages: Message[]; cursor: string | null };
			_replies = data.messages ?? [];
			_cursor = data.cursor ?? null;
			_hasMore = (data.cursor ?? null) !== null;
			_afterCursor = null;
			_hasNewer = false;
			_loadingNewer = false;
			_loadError = false;
		} catch (err) {
			console.error('Failed to load latest replies:', err);
			_loadError = true;
		}
	},

	async loadMore() {
		if (!_parentMessage || !_cursor || _loadingMore) return;
		_loadingMore = true;
		_loadError = false;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		try {
			const response = await fetch(
				`${API_BASE}/messages/${_parentMessage.id}/replies?before=${encodeURIComponent(_cursor)}`,
				{ credentials: 'include', signal: controller.signal }
			);
			if (!response.ok) {
				throw new Error(`Server error: ${response.status}`);
			}
			const data = (await response.json()) as { messages: Message[]; cursor: string | null };
			_replies = dedupeAndSort([..._replies, ...data.messages]);
			_cursor = data.cursor;
			_hasMore = data.cursor !== null;
		} catch (err) {
			console.error('Failed to load more replies:', err);
			_loadError = true;
			// Keep _hasMore = true so retry is possible
		} finally {
			clearTimeout(timeout);
			_loadingMore = false;
		}
	},

	async loadNewer() {
		if (!_parentMessage || !_afterCursor || _loadingNewer || !_hasNewer) return;
		_loadingNewer = true;
		_loadError = false;
		try {
			const response = await fetch(
				`${API_BASE}/messages/${_parentMessage.id}/replies?after=${encodeURIComponent(_afterCursor)}`,
				{ credentials: 'include' }
			);
			if (!response.ok) {
				throw new Error(`Server error: ${response.status}`);
			}
			const data = (await response.json()) as {
				messages: Message[];
				afterCursor?: string | null;
				hasNewer?: boolean;
			};
			_replies = dedupeAndSort([..._replies, ...(data.messages ?? [])]);
			_afterCursor = data.afterCursor ?? null;
			_hasNewer = data.hasNewer ?? false;
		} catch (err) {
			console.error('Failed to load newer replies:', err);
			_loadError = true;
		} finally {
			_loadingNewer = false;
		}
	},

	async refreshLatest() {
		if (!_parentMessage || _loading) return;
		try {
			const parentId = _parentMessage.id;

			// Refresh parent message — surgically update only changed fields
			const parentRes = await fetch(`${API_BASE}/messages/${parentId}`, {
				credentials: 'include'
			});
			if (parentRes.ok) {
				const freshParent = (await parentRes.json()) as Message;
				// Use a single-element array wrapper to reuse mergeMessages for the parent
				mergeMessages([_parentMessage], [freshParent]);
			}

			// Refresh replies — surgically update changed fields, append new ones
			const repliesRes = await fetch(`${API_BASE}/messages/${parentId}/replies?latest=true`, {
				credentials: 'include'
			});
			if (repliesRes.ok) {
				const data = (await repliesRes.json()) as { messages: Message[]; cursor: string | null };
				mergeMessages(_replies, data.messages ?? []);
			}
		} catch (e) {
			console.error('Failed to refresh thread:', e);
		}
	},

	close() {
		_open = false;
		_parentMessage = null;
		_replies = [];
		_cursor = null;
		_hasMore = false;
		_afterCursor = null;
		_hasNewer = false;
		_highlightReplyId = null;
		_loadError = false;
		_loadingMore = false;
		_loadingNewer = false;
	},

	addReply(msg: Message) {
		if (_parentMessage && msg.thread_id === _parentMessage.id) {
			_replies = upsertMessage(_replies, msg);
		}
	},

	/** Replace the local temporary reply with the canonical API response. */
	replaceOptimisticReply(optimisticId: string, msg: Message) {
		if (!_parentMessage || msg.thread_id !== _parentMessage.id) return;
		_replies = upsertMessage(
			_replies.filter((message) => message.id !== optimisticId),
			msg
		);
	},

	markReplyFailed(messageId: string) {
		const idx = _replies.findIndex((message) => message.id === messageId);
		if (idx >= 0) {
			_replies[idx] = { ..._replies[idx], client_delivery_status: 'failed' };
		}
	},

	async sendReply(content: string, attachmentIds?: string[], idempotencyKey?: string) {
		if (!_parentMessage) return;
		const response = await fetch(`${API_BASE}/messages/${_parentMessage.id}/replies`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content, attachmentIds, idempotencyKey })
		});
		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: 'Failed to send' }));
			throw new Error(err.error || 'Failed to send reply');
		}
		return (await response.json()) as any;
	},

	updateReply(messageId: string, updates: Partial<Message>) {
		if (_parentMessage && _parentMessage.id === messageId) {
			_parentMessage = { ..._parentMessage, ...updates };
		}
		const idx = _replies.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			_replies[idx] = { ..._replies[idx], ...updates };
		}
	},

	removeReply(messageId: string) {
		if (_parentMessage && _parentMessage.id === messageId) {
			_parentMessage = { ..._parentMessage, deleted_at: Date.now() / 1000, content: null };
		}
		const idx = _replies.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			_replies[idx] = { ..._replies[idx], deleted_at: Date.now() / 1000, content: null };
		}
	},

	addReaction(messageId: string, emoji: string, userId: string, username: string) {
		// Update parent message if the reaction targets it
		if (_parentMessage && _parentMessage.id === messageId) {
			const reactions = [...(_parentMessage.reactions || [])];
			if (!reactions.find((r: Reaction) => r.emoji === emoji && r.userId === userId)) {
				reactions.push({ emoji, userId, username });
			}
			_parentMessage = { ..._parentMessage, reactions };
		}
		const idx = _replies.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _replies[idx];
			const reactions = [...(msg.reactions || [])];
			if (!reactions.find((r: Reaction) => r.emoji === emoji && r.userId === userId)) {
				reactions.push({ emoji, userId, username });
			}
			_replies[idx] = { ...msg, reactions };
		}
	},

	updateProcessStatus(messageId: string, processId: string, status: string, inputTokens?: number, outputTokens?: number, cacheCreationInputTokens?: number, cacheReadInputTokens?: number, errorText?: string | null) {
		const tokenUpdate = (inputTokens !== undefined || outputTokens !== undefined)
			? { process_input_tokens: inputTokens ?? 0, process_output_tokens: outputTokens ?? 0 }
			: {};
		const cacheTokenUpdate = (cacheCreationInputTokens !== undefined || cacheReadInputTokens !== undefined)
			? { process_cache_creation_input_tokens: cacheCreationInputTokens ?? 0, process_cache_read_input_tokens: cacheReadInputTokens ?? 0 }
			: {};
		// Carry error text on terminal status events. Clear on non-error transitions
		// so retries don't show stale errors.
		const errorUpdate: Partial<{ process_error_text: string | null }> =
			status === 'error'
				? { process_error_text: errorText ?? null }
				: (status === 'done' || status === 'killed' || status === 'restarted' || status === 'processing' || status === 'queued')
				? { process_error_text: null }
				: {};
		if (_parentMessage && _parentMessage.id === messageId) {
			_parentMessage = { ..._parentMessage, process_id: processId, process_status: status, ...tokenUpdate, ...cacheTokenUpdate, ...errorUpdate };
		}
		const idx = _replies.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			_replies[idx] = { ..._replies[idx], process_id: processId, process_status: status, ...tokenUpdate, ...cacheTokenUpdate, ...errorUpdate };
		}
	},

	removeReaction(messageId: string, emoji: string, userId: string) {
		// Update parent message if the reaction targets it
		if (_parentMessage && _parentMessage.id === messageId) {
			const reactions = (_parentMessage.reactions || []).filter(
				(r: Reaction) => !(r.emoji === emoji && r.userId === userId)
			);
			_parentMessage = { ..._parentMessage, reactions };
		}
		const idx = _replies.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			const msg = _replies[idx];
			const reactions = (msg.reactions || []).filter(
				(r: Reaction) => !(r.emoji === emoji && r.userId === userId)
			);
			_replies[idx] = { ...msg, reactions };
		}
	}
};
