import { api } from '$lib/api.js';

export interface PinnedMessage {
	id: string;
	channel_id: string;
	message_id: string;
	pinned_by: string;
	pin_created_at: number;
	content: string | null;
	message_created_at: number;
	user_id: string | null;
	username: string | null;
	display_name: string | null;
	name_color: string | null;
	avatar_url: string | null;
	pinned_by_username: string | null;
}

let _pins = $state<PinnedMessage[]>([]);
let _pinnedMessageIds = $state<Set<string>>(new Set());
let _loading = $state(false);
let _channelId = $state<string | null>(null);

export const pins = {
	get list() {
		return _pins;
	},
	get loading() {
		return _loading;
	},
	get pinnedMessageIds() {
		return _pinnedMessageIds;
	},

	isPinned(messageId: string): boolean {
		return _pinnedMessageIds.has(messageId);
	},

	async load(channelId: string) {
		_channelId = channelId;
		_loading = true;
		try {
			const result = await api.channels.pins(channelId);
			if (_channelId !== channelId) return;
			_pins = result;
			_pinnedMessageIds = new Set(result.map((p: PinnedMessage) => p.message_id));
		} catch (e) {
			console.error('Failed to load pins:', e);
		} finally {
			if (_channelId === channelId) _loading = false;
		}
	},

	async pin(channelId: string, messageId: string) {
		try {
			await api.channels.pin(channelId, messageId);
			_pinnedMessageIds = new Set([..._pinnedMessageIds, messageId]);
			// Reload full pin list to get message data
			if (_channelId === channelId) {
				this.load(channelId);
			}
		} catch (e) {
			console.error('Failed to pin message:', e);
			throw e;
		}
	},

	async unpin(channelId: string, messageId: string) {
		try {
			await api.channels.unpin(channelId, messageId);
			const next = new Set(_pinnedMessageIds);
			next.delete(messageId);
			_pinnedMessageIds = next;
			_pins = _pins.filter((p) => p.message_id !== messageId);
		} catch (e) {
			console.error('Failed to unpin message:', e);
			throw e;
		}
	},

	handlePinned(messageId: string) {
		_pinnedMessageIds = new Set([..._pinnedMessageIds, messageId]);
		// Reload to get full pin data
		if (_channelId) {
			this.load(_channelId);
		}
	},

	handleUnpinned(messageId: string) {
		const next = new Set(_pinnedMessageIds);
		next.delete(messageId);
		_pinnedMessageIds = next;
		_pins = _pins.filter((p) => p.message_id !== messageId);
	},

	clear() {
		_pins = [];
		_pinnedMessageIds = new Set();
		_channelId = null;
	}
};
