import { api } from '$lib/api.js';
import { channels } from '$lib/state/channels.svelte.js';
import { FEEDBACK_CHANNEL_ID } from '$lib/constants.js';

export interface Folder {
	id: string;
	name: string;
	position: number;
	collapsed: number;
	channels: string[];
}

let _folders = $state<Folder[]>([]);
let _loading = $state(false);

export const folders = {
	get list() {
		return _folders;
	},
	get loading() {
		return _loading;
	},

	/** Channel IDs not assigned to any folder. Excludes ephemerals — those live in their own sidebar section. Excludes the feedback channel — it has its own pinned sidebar item. */
	get unfiledChannelIds(): string[] {
		const filed = new Set(_folders.flatMap((f) => f.channels));
		return channels.list.filter((c) => !filed.has(c.id) && !c.is_ephemeral && c.id !== FEEDBACK_CHANNEL_ID).map((c) => c.id);
	},

	async load() {
		_loading = true;
		try {
			const data = (await api.folders.list()) as Folder[];
			_folders = data;
		} finally {
			_loading = false;
		}
	},

	async create(name: string) {
		const result = (await api.folders.create(name)) as Folder;
		_folders = [..._folders, result];
		return result;
	},

	async rename(folderId: string, name: string) {
		await api.folders.update(folderId, { name });
		const f = _folders.find((f) => f.id === folderId);
		if (f) f.name = name;
	},

	async delete(folderId: string) {
		await api.folders.delete(folderId);
		_folders = _folders.filter((f) => f.id !== folderId);
	},

	async toggleCollapsed(folderId: string) {
		const f = _folders.find((f) => f.id === folderId);
		if (!f) return;
		// Optimistic update
		f.collapsed = f.collapsed ? 0 : 1;
		try {
			await api.folders.update(folderId, { collapsed: f.collapsed });
		} catch {
			// Revert on failure
			f.collapsed = f.collapsed ? 0 : 1;
		}
	},

	async addChannel(folderId: string, channelId: string, position?: number) {
		// Optimistic: remove from current folder if any
		for (const f of _folders) {
			const idx = f.channels.indexOf(channelId);
			if (idx !== -1) {
				f.channels.splice(idx, 1);
			}
		}
		// Add to target folder
		const target = _folders.find((f) => f.id === folderId);
		if (target) {
			if (position !== undefined) {
				target.channels.splice(position, 0, channelId);
			} else {
				target.channels.push(channelId);
			}
		}
		await api.folders.addChannel(folderId, channelId, position);
	},

	async removeChannel(folderId: string, channelId: string) {
		const f = _folders.find((f) => f.id === folderId);
		if (f) {
			f.channels = f.channels.filter((id) => id !== channelId);
		}
		await api.folders.removeChannel(folderId, channelId);
	},

	async reorder(data: {
		folders?: { id: string; position: number }[];
		items?: { folderId: string; channelId: string; position: number }[];
	}) {
		// Optimistic: apply position changes locally
		if (data.folders) {
			for (const update of data.folders) {
				const f = _folders.find((f) => f.id === update.id);
				if (f) f.position = update.position;
			}
			_folders.sort((a, b) => a.position - b.position);
		}
		if (data.items) {
			// Rebuild channel lists per folder from items
			const byFolder = new Map<string, { channelId: string; position: number }[]>();
			for (const item of data.items) {
				const list = byFolder.get(item.folderId) ?? [];
				list.push(item);
				byFolder.set(item.folderId, list);
			}
			for (const [folderId, items] of byFolder) {
				const f = _folders.find((f) => f.id === folderId);
				if (f) {
					items.sort((a, b) => a.position - b.position);
					f.channels = items.map((i) => i.channelId);
				}
			}
		}
		await api.folders.reorder(data);
	},

	/** Move a channel to a specific folder and position via drag-drop */
	async moveChannel(channelId: string, targetFolderId: string | null, targetPosition: number) {
		if (targetFolderId === null) {
			// Moving to unfiled: remove from any folder
			for (const f of _folders) {
				const idx = f.channels.indexOf(channelId);
				if (idx !== -1) {
					f.channels.splice(idx, 1);
					await api.folders.removeChannel(f.id, channelId);
					return;
				}
			}
			return;
		}
		await this.addChannel(targetFolderId, channelId, targetPosition);
	},

	/** Move a folder to a new position */
	async moveFolder(folderId: string, newPosition: number) {
		const folderUpdates = _folders.map((f) => {
			let pos = f.position;
			if (f.id === folderId) {
				pos = newPosition;
			} else if (f.position >= newPosition) {
				pos = f.position + 1;
			}
			return { id: f.id, position: pos };
		});
		// Normalize positions to 0, 1, 2, ...
		folderUpdates.sort((a, b) => a.position - b.position);
		folderUpdates.forEach((f, i) => (f.position = i));

		await this.reorder({ folders: folderUpdates });
	}
};
