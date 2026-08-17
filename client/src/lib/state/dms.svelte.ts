import { api } from '$lib/api.js';
import { channels } from '$lib/state/channels.svelte.js';

export interface BotCapabilities {
	/** Model IDs this bot supports (for DM picker). */
	models?: string[];
	[key: string]: unknown;
}

export interface DMPartner {
	id: string;
	username: string;
	display_name: string | null;
	name_color: string | null;
	/** 'user' | 'bot'. Authoritative bot flag (migration 0032). */
	role?: string;
	/** Present only for bot users that have POSTed their capabilities. */
	bot_capabilities?: BotCapabilities | null;
}

export interface DM {
	id: string;
	name: string;
	is_dm: number;
	is_private: number;
	dm_partner_id: string | null;
	created_at: number;
	position: number | null;
	notifications: string;
	has_unread: number;
	unread_count: number;
	last_read_message_id: string | null;
	last_message_content: string | null;
	last_message_at: number | null;
	partner: DMPartner;
	can_send_messages?: boolean;
	disabled_reason?: string | null;
}

let _dms = $state<DM[]>([]);
let _selectedId = $state<string | null>(null);
let _loading = $state(false);

export const dms = {
	get list() {
		return _dms;
	},
	get selectedId() {
		return _selectedId;
	},
	get selected(): DM | undefined {
		return _dms.find((d) => d.id === _selectedId);
	},
	get loading() {
		return _loading;
	},

	select(id: string | null) {
		_selectedId = id;
		if (id) {
			// Deselect any regular channel
			channels.select(null);
		}
	},

	async load() {
		_loading = true;
		try {
			const data = (await api.dms.list()) as DM[];
			_dms = data;
		} finally {
			_loading = false;
		}
	},

	async openDM(userId: string): Promise<DM> {
		const result = (await api.dms.createOrGet(userId)) as DM;
		// Reload full list to get unread counts etc
		await this.load();
		// Find the DM in the refreshed list, or use the result directly
		const found = _dms.find((d) => d.id === result.id);
		const dm = found ?? result;
		this.select(dm.id);
		return dm;
	},

	async hide(dmId: string) {
		await api.dms.hide(dmId);
		_dms = _dms.filter((d) => d.id !== dmId);
		if (_selectedId === dmId) {
			_selectedId = null;
		}
	},

	markRead(channelId: string) {
		const dm = _dms.find((d) => d.id === channelId);
		if (dm) {
			dm.has_unread = 0;
			dm.unread_count = 0;
		}
	},

	incrementUnread(channelId: string) {
		const dm = _dms.find((d) => d.id === channelId);
		if (dm) {
			dm.has_unread = 1;
			dm.unread_count = (dm.unread_count || 0) + 1;
		}
	},

	decrementUnread(channelId: string) {
		const dm = _dms.find((d) => d.id === channelId);
		if (dm) {
			dm.unread_count = Math.max(0, (dm.unread_count || 0) - 1);
			dm.has_unread = dm.unread_count > 0 ? 1 : 0;
		}
	},

	/**
	 * Move a DM to a new position in the list. Writes explicit positions for
	 * every DM so ordering is deterministic regardless of whether they'd been
	 * manually reordered before. Mirrors folders.moveFolder.
	 */
	async moveDM(dmId: string, newPosition: number) {
		const current = [..._dms];
		const fromIdx = current.findIndex((d) => d.id === dmId);
		if (fromIdx === -1) return;

		// Clamp target into [0, length-1] after removal
		const without = current.slice();
		const [moving] = without.splice(fromIdx, 1);
		const clamped = Math.max(0, Math.min(newPosition, without.length));
		without.splice(clamped, 0, moving);

		// Optimistic: apply ordering locally and rewrite positions 0..N-1
		_dms = without.map((d, i) => ({ ...d, position: i }));

		try {
			await api.dms.reorder(_dms.map((d, i) => ({ id: d.id, position: i })));
		} catch (err) {
			// Revert on failure
			_dms = current;
			throw err;
		}
	}
};
