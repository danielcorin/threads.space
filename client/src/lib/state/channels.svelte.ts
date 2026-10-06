import { api } from '$lib/api.js';
import { folders } from '$lib/state/folders.svelte.js';

const LAST_CHANNEL_KEY = 'threads_last_channel';

export interface Channel {
	id: string;
	name: string;
	description: string | null;
	is_private: number;
	is_dm?: number;
	processing_mode: string;
	board_enabled: number;
	auto_respond_bot_id: string | null;
	notifications: string;
	created_by: string;
	created_at: number;
	has_unread: number;
	unread_count: number;
	last_read_message_id: string | null;
	is_ephemeral?: number;
	auto_named_at?: number | null;
	archived_at?: number | null;
}

let _channels = $state<Channel[]>([]);
let _selectedId = $state<string | null>(null);
let _loading = $state(false);

function saveLastChannel(id: string | null) {
	if (typeof localStorage === 'undefined') return;
	if (id) {
		localStorage.setItem(LAST_CHANNEL_KEY, id);
	} else {
		localStorage.removeItem(LAST_CHANNEL_KEY);
	}
}

function getSavedChannel(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(LAST_CHANNEL_KEY);
}

export const channels = {
	get list() {
		return _channels;
	},
	get selectedId() {
		return _selectedId;
	},
	get selected(): Channel | undefined {
		return _channels.find((c) => c.id === _selectedId);
	},
	get loading() {
		return _loading;
	},

	select(id: string | null) {
		_selectedId = id;
		saveLastChannel(id);
	},

	async load() {
		_loading = true;
		try {
			const data = (await api.channels.list()) as Channel[];
			_channels = data;
			// If an archived ephemeral channel is currently open, keep its metadata
			// locally so the header/settings can render while it remains hidden from
			// default sidebar/switcher results.
			if (_selectedId && !data.some((c) => c.id === _selectedId)) {
				await this.ensureLoaded(_selectedId).catch(() => {});
			}
			// Restore last channel if none is currently selected
			if (!_selectedId) {
				const saved = getSavedChannel();
				if (saved && data.some((c) => c.id === saved)) {
					_selectedId = saved;
				}
			}
		} finally {
			_loading = false;
		}
	},

	async create(name: string, description?: string, isPrivate?: boolean) {
		const result = (await api.channels.create(name, description, isPrivate)) as Channel;
		// Reload full list to get proper has_unread etc
		await this.load();
		return result;
	},

	async createEphemeral() {
		const result = (await api.channels.createEphemeral()) as Channel;
		_channels = [..._channels.filter((channel) => channel.id !== result.id), {
			...result,
			processing_mode: result.processing_mode ?? 'immediate',
			board_enabled: result.board_enabled ?? 0,
			notifications: result.notifications ?? 'all',
			has_unread: result.has_unread ?? 0,
			unread_count: result.unread_count ?? 0,
			last_read_message_id: result.last_read_message_id ?? null
		}];
		this.select(result.id);
		return result;
	},

	async ensureLoaded(channelId: string) {
		if (_channels.some((c) => c.id === channelId)) return;
		const fetched = await api.channels.get(channelId);
		// Another membership event or the create response can win while this fetch is in flight.
		if (_channels.some((c) => c.id === channelId)) return;
		// DM backing channels should never be inserted into the regular channel sidebar.
		if (fetched.is_dm) return;
		// GET /channels/:id returns the bare channel; fill the sidebar-only
		// unread fields with defaults.
		const channel = {
			notifications: 'all',
			has_unread: 0,
			unread_count: 0,
			last_read_message_id: null,
			...fetched
		} as unknown as Channel;
		_channels = [..._channels, channel];
	},

	async archive(channelId: string) {
		await api.channels.archive(channelId);
		this.removeLocal(channelId);
	},

	async unarchive(channelId: string) {
		await api.channels.unarchive(channelId);
		await this.load();
		this.select(channelId);
	},

	async promote(channelId: string, name: string) {
		const result = await api.channels.promote(channelId, name);
		await this.load();
		this.select(result.id);
		return result;
	},

	async updateDescription(channelId: string, description: string) {
		await api.channels.update(channelId, { description });
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) ch.description = description || null;
	},

	async updateSettings(channelId: string, settings: { description?: string; processing_mode?: string; board_enabled?: number; auto_respond_bot_id?: string | null }) {
		await api.channels.update(channelId, settings);
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) {
			if (settings.description !== undefined) ch.description = settings.description || null;
			if (settings.processing_mode !== undefined) ch.processing_mode = settings.processing_mode;
			if (settings.board_enabled !== undefined) ch.board_enabled = settings.board_enabled;
			if (settings.auto_respond_bot_id !== undefined) ch.auto_respond_bot_id = settings.auto_respond_bot_id;
		}
	},

	async updateNotifications(channelId: string, tier: 'all' | 'mentions' | 'none') {
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) ch.notifications = tier;
		try {
			await api.channels.updateNotifications(channelId, tier);
		} catch (err) {
			// Revert on failure
			if (ch) await this.load();
			throw err;
		}
	},

	async delete(channelId: string) {
		await api.channels.delete(channelId);
		this.removeLocal(channelId);
	},

	/** Apply a partial update from a channel_updated WS event. */
	applyUpdate(channelId: string, data: Record<string, unknown>) {
		const ch = _channels.find((c) => c.id === channelId);
		if (!ch) return;
		if (data.description !== undefined) ch.description = (data.description as string) || null;
		if (data.name !== undefined) ch.name = data.name as string;
		if (data.is_ephemeral !== undefined) ch.is_ephemeral = data.is_ephemeral as number;
		if (data.auto_named_at !== undefined) ch.auto_named_at = data.auto_named_at as number | null;
		if (data.archived_at !== undefined) ch.archived_at = data.archived_at as number | null;
		if (data.processing_mode !== undefined) ch.processing_mode = data.processing_mode as string;
		if (data.board_enabled !== undefined) ch.board_enabled = data.board_enabled as number;
		if (data.auto_respond_bot_id !== undefined) ch.auto_respond_bot_id = (data.auto_respond_bot_id as string | null);
	},

	/** Remove a channel from local state (used by delete and WS events). */
	removeLocal(channelId: string) {
		_channels = _channels.filter((c) => c.id !== channelId);
		// Remove from any folder
		for (const f of folders.list) {
			const idx = f.channels.indexOf(channelId);
			if (idx !== -1) {
				f.channels.splice(idx, 1);
			}
		}
		if (_selectedId === channelId) {
			_selectedId = _channels.length > 0 ? _channels[0].id : null;
			saveLastChannel(_selectedId);
		}
	},

	async join(channelId: string) {
		await api.channels.join(channelId);
		await this.load();
	},

	async leave(channelId: string) {
		await api.channels.leave(channelId);
		await this.load();
		if (_selectedId === channelId) {
			_selectedId = null;
			saveLastChannel(null);
		}
	},

	async leaveMembership(channelId: string) {
		await api.channels.leaveMembership(channelId);
		this.removeLocal(channelId);
	},

	markRead(channelId: string) {
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) {
			ch.has_unread = 0;
			ch.unread_count = 0;
		}
	},

	incrementUnread(channelId: string) {
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) {
			ch.has_unread = 1;
			ch.unread_count = (ch.unread_count || 0) + 1;
		}
	},

	decrementUnread(channelId: string) {
		const ch = _channels.find((c) => c.id === channelId);
		if (ch) {
			ch.unread_count = Math.max(0, (ch.unread_count || 0) - 1);
			ch.has_unread = ch.unread_count > 0 ? 1 : 0;
		}
	}
};
