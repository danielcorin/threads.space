import { api } from '$lib/api.js';

let _channelIds = $state<Set<string>>(new Set());

export const drafts = {
	has(channelId: string): boolean {
		return _channelIds.has(channelId);
	},

	set(channelId: string, hasContent: boolean) {
		if (hasContent) {
			if (!_channelIds.has(channelId)) {
				_channelIds = new Set([..._channelIds, channelId]);
			}
		} else {
			if (_channelIds.has(channelId)) {
				const next = new Set(_channelIds);
				next.delete(channelId);
				_channelIds = next;
			}
		}
	},

	async load() {
		try {
			const result = await api.drafts.list();
			_channelIds = new Set(result.channel_ids);
		} catch {
			// Ignore errors loading drafts
		}
	}
};
