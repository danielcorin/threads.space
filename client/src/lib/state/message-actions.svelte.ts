// Global message action sheet state — renders at page level
// Long-press on mobile opens this bottom sheet with emoji, edit, thread, delete

import type { Message } from './messages.svelte.js';

type ActionCallback = {
	onreaction: (emoji: string) => void;
	onedit: () => void;
	onreply: () => void;
	ondelete: () => void;
	onpin?: () => void;
	onunpin?: () => void;
	onresolve?: () => void;
	onunresolve?: () => void;
};

function createMessageActionsState() {
	let isOpen = $state(false);
	let message: Message | null = $state(null);
	let isOwnMessage = $state(false);
	let hasReply = $state(false);
	let isPinned = $state(false);
	let isResolved = $state(false);
	let callbacks: ActionCallback | null = $state(null);
	// Tracks when the sheet opened so we can ignore the touchend/click from the
	// same long-press gesture that triggered it.
	let openedAt = 0;

	return {
		get isOpen() { return isOpen; },
		get message() { return message; },
		get isOwnMessage() { return isOwnMessage; },
		get hasReply() { return hasReply; },
		get isPinned() { return isPinned; },
		get hasPin() { return !!callbacks?.onpin || !!callbacks?.onunpin; },
		get isResolved() { return isResolved; },
		get hasResolve() { return !!callbacks?.onresolve || !!callbacks?.onunresolve; },

		getOnreaction(): ((emoji: string) => void) | null {
			return callbacks?.onreaction ?? null;
		},

		open(msg: Message, own: boolean, canReply: boolean, cbs: ActionCallback, pinned: boolean = false, resolved: boolean = false) {
			// Dismiss keyboard first so the bottom sheet is fully visible
			(document.activeElement as HTMLElement)?.blur?.();
			// Haptic feedback on mobile
			navigator.vibrate?.(10);
			message = msg;
			isOwnMessage = own;
			hasReply = canReply;
			isPinned = pinned;
			isResolved = resolved;
			callbacks = cbs;
			isOpen = true;
			openedAt = Date.now();
		},

		selectReaction(emoji: string) {
			callbacks?.onreaction(emoji);
			isOpen = false;
			message = null;
			callbacks = null;
		},

		edit() {
			callbacks?.onedit();
			isOpen = false;
			message = null;
			callbacks = null;
		},

		reply() {
			callbacks?.onreply();
			isOpen = false;
			message = null;
			callbacks = null;
		},

		copyLink() {
			if (!message) return;
			const channelId = message.channel_id;
			const url = `${window.location.origin}?channel=${channelId}&msg=${message.id}`;
			navigator.clipboard.writeText(url);
			isOpen = false;
			message = null;
			callbacks = null;
		},

		delete() {
			callbacks?.ondelete();
			isOpen = false;
			message = null;
			callbacks = null;
		},

		togglePin() {
			if (isPinned) {
				callbacks?.onunpin?.();
			} else {
				callbacks?.onpin?.();
			}
			isOpen = false;
			message = null;
			callbacks = null;
		},

		toggleResolve() {
			if (isResolved) {
				callbacks?.onunresolve?.();
			} else {
				callbacks?.onresolve?.();
			}
			isOpen = false;
			message = null;
			callbacks = null;
		},

		close() {
			// Ignore close attempts within 700ms of opening — the touchend/click
			// from the long-press gesture that opened the sheet should not dismiss it.
			// Links inside messages can fire a synthesized click ~300-500ms after
			// touchend, so 400ms was not enough.
			if (Date.now() - openedAt < 700) return;
			isOpen = false;
			message = null;
			callbacks = null;
		},

		forceClose() {
			isOpen = false;
			message = null;
			callbacks = null;
		}
	};
}

export const messageActions = createMessageActionsState();
