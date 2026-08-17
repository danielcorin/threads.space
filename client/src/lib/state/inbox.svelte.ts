import { api } from '$lib/api.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import type { Message } from '$lib/state/messages.svelte.js';

export interface InboxMessage extends Message {
	channel_name: string;
	is_dm: number | boolean;
	dm_partner_id?: string | null;
	dm_partner_username?: string | null;
	dm_partner_display_name?: string | null;
}

let _list = $state<InboxMessage[]>([]);
let _total = $state(0);
let _cursor = $state<string | null>(null);
let _loading = $state(false);
let _loadingMore = $state(false);
let _loadError = $state(false);
let _loaded = $state(false);

function normalizeEventMessage(message: any, context: {
	channelName: string;
	isDm: boolean;
	dmPartnerId?: string | null;
	dmPartnerUsername?: string | null;
	dmPartnerDisplayName?: string | null;
}): InboxMessage {
	return {
		...message,
		id: message.id,
		channel_id: message.channel_id ?? message.channelId,
		user_id: message.user_id ?? message.userId ?? null,
		thread_id: message.thread_id ?? message.threadId ?? null,
		created_at: message.created_at ?? message.createdAt ?? Math.floor(Date.now() / 1000),
		message_type: message.message_type ?? message.messageType,
		display_name: message.display_name ?? message.displayName ?? null,
		name_color: message.name_color ?? message.nameColor ?? null,
		avatar_url: message.avatar_url ?? message.avatarUrl ?? null,
		type: 'message',
		edited_at: message.edited_at ?? message.editedAt ?? null,
		deleted_at: message.deleted_at ?? message.deletedAt ?? null,
		channel_name: context.channelName,
		is_dm: context.isDm,
		dm_partner_id: context.dmPartnerId ?? null,
		dm_partner_username: context.dmPartnerUsername ?? null,
		dm_partner_display_name: context.dmPartnerDisplayName ?? null,
	} as InboxMessage;
}

export const inbox = {
	get list() {
		return _list;
	},
	get total() {
		return _total;
	},
	get loading() {
		return _loading;
	},
	get loadingMore() {
		return _loadingMore;
	},
	get hasMore() {
		return _cursor !== null;
	},
	get loadError() {
		return _loadError;
	},
	get loaded() {
		return _loaded;
	},

	async load() {
		_loading = true;
		_loadError = false;
		try {
			const page = await api.inbox.list();
			_list = page.messages as InboxMessage[];
			_total = page.total;
			_cursor = page.cursor;
			_loaded = true;
		} catch (error) {
			console.error('Failed to load Inbox:', error);
			_loadError = true;
		} finally {
			_loading = false;
		}
	},

	async loadMore() {
		if (!_cursor || _loadingMore) return;
		_loadingMore = true;
		try {
			const page = await api.inbox.list(_cursor);
			const seen = new Set(_list.map((message) => message.id));
			_list = [..._list, ...(page.messages as InboxMessage[]).filter((message) => !seen.has(message.id))];
			_total = page.total;
			_cursor = page.cursor;
		} finally {
			_loadingMore = false;
		}
	},

	async markRead(messageId: string) {
		await api.messages.markRead(messageId);
		this.removeLocal(messageId);
	},

	async reply(messageId: string, content: string) {
		await api.messages.reply(messageId, content, crypto.randomUUID());
		await this.markRead(messageId);
	},

	removeLocal(messageId: string) {
		const message = _list.find((item) => item.id === messageId);
		if (!message) return;
		_list = _list.filter((item) => item.id !== messageId);
		_total = Math.max(0, _total - 1);
		if (message.is_dm) dms.decrementUnread(message.channel_id);
		else channels.decrementUnread(message.channel_id);
	},

	markChannelReadLocal(channelId: string) {
		const removed = _list.filter((message) => message.channel_id === channelId).length;
		const unreadCount = channels.list.find((channel) => channel.id === channelId)?.unread_count
			?? dms.list.find((dm) => dm.id === channelId)?.unread_count
			?? removed;
		if (removed === 0 && unreadCount === 0) return;
		_list = _list.filter((message) => message.channel_id !== channelId);
		_total = Math.max(0, _total - Math.max(removed, unreadCount));
	},

	receive(message: any, context: {
		channelName: string;
		isDm: boolean;
		dmPartnerId?: string | null;
		dmPartnerUsername?: string | null;
		dmPartnerDisplayName?: string | null;
	}) {
		if (!message?.id || _list.some((item) => item.id === message.id)) return;
		const normalized = normalizeEventMessage(message, context);
		_list = [normalized, ..._list];
		_total += 1;
	},

	clear() {
		_list = [];
		_total = 0;
		_cursor = null;
		_loading = false;
		_loadingMore = false;
		_loadError = false;
		_loaded = false;
	},
};
