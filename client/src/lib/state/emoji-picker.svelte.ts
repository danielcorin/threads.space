// Global emoji picker state — renders at page level to avoid
// Svelte 5 event delegation issues with nested action bars

import { api } from '$lib/api.js';

const DEFAULT_EMOJIS = ['👍', '❤️', '😂'];

type EmojiCallback = (emoji: string) => void;

function createEmojiPickerState() {
	let isOpen = $state(false);
	let callback: EmojiCallback | null = $state(null);
	let _quickEmojis = $state<string[]>(DEFAULT_EMOJIS);

	return {
		get isOpen() { return isOpen; },
		get quickEmojis() { return _quickEmojis; },

		open(cb: EmojiCallback) {
			callback = cb;
			isOpen = true;
		},

		select(emoji: string) {
			callback?.(emoji);
			isOpen = false;
			callback = null;
		},

		close() {
			isOpen = false;
			callback = null;
		},

		async loadFrequentEmojis() {
			try {
				const emojis = await api.users.frequentEmojis();
				if (emojis && emojis.length > 0) {
					_quickEmojis = emojis;
				}
			} catch {
				// Keep defaults on failure
			}
		}
	};
}

export const emojiPicker = createEmojiPickerState();
