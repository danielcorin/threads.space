import { api } from '$lib/api.js';

export interface SavedDraft {
	id: string;
	channel_id: string;
	user_id: string;
	content: string;
	created_at: string;
	updated_at: string;
	scheduled_at: string | null;
}

let _drafts = $state<SavedDraft[]>([]);
let _loading = $state(false);
let _channelId = $state<string | null>(null);

export const savedDrafts = {
	get list() {
		return _drafts;
	},
	get loading() {
		return _loading;
	},

	async load(channelId: string) {
		_channelId = channelId;
		_loading = true;
		try {
			const result = await api.savedDrafts.list(channelId);
			if (_channelId !== channelId) return;
			_drafts = result;
		} catch (e) {
			console.error('Failed to load saved drafts:', e);
		} finally {
			if (_channelId === channelId) _loading = false;
		}
	},

	async save(channelId: string, content: string) {
		try {
			const draft = await api.savedDrafts.create(channelId, content);
			if (_channelId === channelId) {
				_drafts = [draft, ..._drafts];
			}
			return draft;
		} catch (e) {
			console.error('Failed to save draft:', e);
			throw e;
		}
	},

	async delete(draftId: string) {
		try {
			await api.savedDrafts.delete(draftId);
			_drafts = _drafts.filter((d) => d.id !== draftId);
		} catch (e) {
			console.error('Failed to delete draft:', e);
			throw e;
		}
	},

	async schedule(draftId: string, scheduledAt: string) {
		try {
			await api.savedDrafts.schedule(draftId, scheduledAt);
			const idx = _drafts.findIndex((d) => d.id === draftId);
			if (idx >= 0) _drafts[idx].scheduled_at = scheduledAt;
		} catch (e) {
			console.error('Failed to schedule draft:', e);
			throw e;
		}
	},

	async unschedule(draftId: string) {
		try {
			await api.savedDrafts.unschedule(draftId);
			const idx = _drafts.findIndex((d) => d.id === draftId);
			if (idx >= 0) _drafts[idx].scheduled_at = null;
		} catch (e) {
			console.error('Failed to unschedule draft:', e);
			throw e;
		}
	},

	clear() {
		_drafts = [];
		_channelId = null;
	}
};
