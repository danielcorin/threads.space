import { auth } from '$lib/state/auth.svelte.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import { messages, type LinkPreview, type Message } from '$lib/state/messages.svelte.js';
import { thread } from '$lib/state/thread.svelte.js';
import { board } from '$lib/state/board.svelte.js';
import { pins } from '$lib/state/pins.svelte.js';
import { api } from '$lib/api.js';
import type { ThreadsSocket } from '$lib/ws.svelte.js';

/**
 * Sets up all WebSocket event handlers for a channel connection.
 * Returns an object with a reactive `typingUsers` array and a `cleanup` function.
 *
 * Intended to be called inside a `$effect` block that reacts to channel changes.
 */
/** Drop typing entries with no fresh typing_start after this long (covers lost stop events). */
const TYPING_EXPIRY_MS = 8_000;

export function setupChannelSocket(
	ws: ThreadsSocket,
	channelId: string,
	getTypingUsers: () => { userId: string; username: string; threadId: string | null; at?: number }[],
	setTypingUsers: (users: { userId: string; username: string; threadId: string | null; at?: number }[]) => void,
	callbacks?: {
		onMemberAdded?: (data: { channelId: string; targetUserId: string; username?: string; displayName?: string }) => void;
	}
): (() => void)[] {
	const handlers: (() => void)[] = [];

	handlers.push(
		ws.on('message', (data) => {
			if (data.id && data.content !== undefined) {
				const msg: Message = {
					id: data.id,
					channel_id: data.channelId || channelId,
					user_id: data.userId || null,
					content: data.content,
					thread_id: data.threadId || null,
					type: 'message',
					edited_at: null,
					deleted_at: null,
					created_at: data.createdAt || Math.floor(Date.now() / 1000),
					username: data.username,
					display_name: data.displayName,
					name_color: data.nameColor || null,
					reactions: [],
					attachments: data.attachments ?? [],
					message_type: data.messageType || data.message_type || undefined,
					metadata: data.metadata ?? null,
				};
				if (msg.thread_id) {
					thread.addReply(msg);
					messages.incrementReplyCount(msg.thread_id);
				} else {
					messages.addMessage(msg);
				}
				if (msg.channel_id === (channels.selectedId ?? dms.selectedId) && msg.user_id !== auth.user?.id) {
					// Keep server last_read_message_id in sync while the user is viewing.
					// Cross-channel unread badges are driven by the global /events stream
					// (events.svelte.ts); this per-channel socket only ever sees the open
					// channel, so there's nothing to increment here.
					api.channels.markRead(msg.channel_id).catch(() => {});
				}
			}
		})
	);

	handlers.push(
		ws.on('new_message', (data) => {
			const msg: Message = {
				id: data.message?.id || data.id,
				channel_id: data.message?.channelId || data.channelId || channelId,
				user_id: data.message?.userId || data.userId || null,
				content: data.message?.content ?? data.content,
				thread_id: data.message?.threadId || data.threadId || null,
				type: 'message',
				edited_at: null,
				deleted_at: null,
				created_at:
					data.message?.createdAt || data.createdAt || Math.floor(Date.now() / 1000),
				username: data.message?.username || data.username,
				display_name: data.message?.displayName || data.displayName,
				name_color: data.message?.nameColor || data.nameColor || null,
				reactions: [],
				attachments: data.message?.attachments || data.attachments || [],
				message_type: data.message?.messageType || data.messageType || data.message?.message_type || data.message_type || undefined,
				metadata: data.message?.metadata ?? data.metadata ?? null,
			};
			if (msg.thread_id) {
				thread.addReply(msg);
				messages.incrementReplyCount(msg.thread_id);
			} else {
				messages.addMessage(msg);
			}
			if (msg.channel_id === (channels.selectedId ?? dms.selectedId) && msg.user_id !== auth.user?.id) {
				// Keep server last_read_message_id in sync while the user is viewing.
				// Cross-channel unread badges are driven by the global /events stream
				// (events.svelte.ts); this per-channel socket only ever sees the open
				// channel, so there's nothing to increment here.
				api.channels.markRead(msg.channel_id).catch(() => {});
			}
		})
	);

	handlers.push(
		ws.on('message_edited', (data) => {
			const id = data.id || data.messageId;
			messages.updateMessage(id, {
				content: data.content,
				edited_at: data.editedAt || Date.now() / 1000
			});
			thread.updateReply(id, {
				content: data.content,
				edited_at: data.editedAt || Date.now() / 1000
			});
		})
	);

	handlers.push(
		ws.on('message_deleted', (data) => {
			const id = data.id || data.messageId;
			messages.removeMessage(id);
			thread.removeReply(id);
			if (data.threadId) {
				messages.decrementReplyCount(data.threadId);
			}
		})
	);

	handlers.push(
		ws.on('reaction_added', (data) => {
			messages.addReaction(data.messageId, data.emoji, data.userId, data.username);
			thread.addReaction(data.messageId, data.emoji, data.userId, data.username);
		})
	);

	handlers.push(
		ws.on('reaction_removed', (data) => {
			messages.removeReaction(data.messageId, data.emoji, data.userId);
			thread.removeReaction(data.messageId, data.emoji, data.userId);
		})
	);

	handlers.push(
		ws.on('link_preview', (data) => {
			const preview: LinkPreview = {
				url: data.url,
				urlHash: '',
				title: data.title,
				description: data.description,
				imageUrl: data.imageUrl,
				siteName: data.siteName
			};
			const messageId = data.messageId;
			messages.updateMessage(messageId, {
				linkPreviews: [preview]
			});
			thread.updateReply(messageId, {
				linkPreviews: [preview]
			});
		})
	);

	handlers.push(
		ws.on('user_typing', (data) => {
			if (data.userId === auth.user?.id) return;
			const threadId = data.threadId ?? null;
			const current = getTypingUsers();
			const existing = current.find((u) => u.userId === data.userId && u.threadId === threadId);
			if (existing) {
				// Refresh the timestamp so the expiry sweep doesn't drop an active typer
				setTypingUsers(current.map((u) => (u === existing ? { ...u, at: Date.now() } : u)));
			} else {
				setTypingUsers([...current, { userId: data.userId, username: data.username, threadId, at: Date.now() }]);
			}
		})
	);

	// A lost user_stopped_typing (dropped socket, killed tab) would otherwise
	// leave the indicator on forever — expire stale entries.
	const typingSweep = setInterval(() => {
		const current = getTypingUsers();
		const now = Date.now();
		const live = current.filter((u) => now - (u.at ?? now) < TYPING_EXPIRY_MS);
		if (live.length !== current.length) setTypingUsers(live);
	}, 2_000);
	handlers.push(() => clearInterval(typingSweep));

	handlers.push(
		ws.on('user_stopped_typing', (data) => {
			const threadId = data.threadId ?? null;
			setTypingUsers(getTypingUsers().filter((u) => !(u.userId === data.userId && u.threadId === threadId)));
		})
	);

	handlers.push(
		ws.on('process_status', (data) => {
			const status = data.status === 'running' ? 'processing' : data.status;
			messages.updateProcessStatus(data.messageId, data.processId, status, data.input_tokens, data.output_tokens, data.cache_creation_input_tokens, data.cache_read_input_tokens, data.error_text);
			thread.updateProcessStatus(data.messageId, data.processId, status, data.input_tokens, data.output_tokens, data.cache_creation_input_tokens, data.cache_read_input_tokens, data.error_text);
			// Bubble process status to parent message in channel view
			if (data.threadId) {
				messages.updateThreadProcessStatus(data.threadId, data.processId, status);
			}
		})
	);

	handlers.push(
		ws.on('process_created', (data) => {
			// Bubble to parent message if this process is on a threaded reply
			if (data.process?.thread_id) {
				const status = data.process.status === 'running' ? 'processing' : data.process.status;
				messages.updateThreadProcessStatus(data.process.thread_id, data.process.id, status);
			}
		})
	);

	handlers.push(
		ws.on('process_updated', (data) => {
			// Bubble to parent message if this process is on a threaded reply
			if (data.process?.thread_id) {
				const status = data.process.status === 'running' ? 'processing' : data.process.status;
				messages.updateThreadProcessStatus(data.process.thread_id, data.process.id, status);
			}
		})
	);

	handlers.push(
		ws.on('channel_updated', (data) => {
			if (data.channelId) {
				channels.applyUpdate(data.channelId, data);
			}
		})
	);

	handlers.push(
		ws.on('channel_deleted', (data) => {
			if (data.channelId) {
				channels.removeLocal(data.channelId);
			}
		})
	);

	handlers.push(
		ws.on('channel_archived', (data) => {
			if (data.channelId) {
				channels.removeLocal(data.channelId);
			}
		})
	);

	handlers.push(
		ws.on('board_updated', (data) => {
			if (data.board) board.handleBoardUpdated(data.board);
		})
	);

	handlers.push(
		ws.on('card_created', (data) => {
			if (data.card) board.handleCardCreated(data.card);
		})
	);

	handlers.push(
		ws.on('card_updated', (data) => {
			if (data.card) board.handleCardUpdated(data.card);
		})
	);

	handlers.push(
		ws.on('card_deleted', (data) => {
			if (data.cardId) board.handleCardDeleted(data.cardId);
		})
	);

	handlers.push(
		ws.on('message_pinned', (data) => {
			if (data.messageId) {
				pins.handlePinned(data.messageId);
				messages.updateMessage(data.messageId, { pinned: 1 });
			}
		})
	);

	handlers.push(
		ws.on('message_unpinned', (data) => {
			if (data.messageId) {
				pins.handleUnpinned(data.messageId);
				messages.updateMessage(data.messageId, { pinned: 0 });
			}
		})
	);

	handlers.push(
		ws.on('message_resolved', (data) => {
			if (data.id) {
				const resolvedAt = data.resolvedAt ?? Math.floor(Date.now() / 1000);
				const resolvedBy = data.resolvedBy ?? null;
				messages.updateMessage(data.id, { resolved_at: resolvedAt, resolved_by: resolvedBy });
			}
		})
	);

	handlers.push(
		ws.on('message_unresolved', (data) => {
			if (data.id) {
				messages.updateMessage(data.id, { resolved_at: null, resolved_by: null });
			}
		})
	);

	handlers.push(
		ws.on('thread_title_updated', (data) => {
			if (data.threadId && typeof data.title === 'string') {
				const updates = {
					thread_title: data.title,
					thread_title_updated_at: data.updatedAt ?? Math.floor(Date.now() / 1000)
				};
				messages.updateMessage(data.threadId, updates);
				thread.updateReply(data.threadId, updates);
			}
		})
	);

	handlers.push(
		ws.on('member_added', (data) => {
			if (
				data.channelId &&
				data.targetUserId === auth.user?.id &&
				!channels.list.some((c) => c.id === data.channelId)
			) {
				channels.load();
			}
			if (data.channelId === channelId && callbacks?.onMemberAdded) {
				callbacks.onMemberAdded(data);
			}
		})
	);

	return handlers;
}
