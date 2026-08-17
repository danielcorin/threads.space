import { api } from '$lib/api.js';
import { updateBadge } from '$lib/badge.js';
import { setupChannelSocket } from '$lib/useChannelSocket.js';
import { auth } from '$lib/state/auth.svelte.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import { messages } from '$lib/state/messages.svelte.js';
import { thread } from '$lib/state/thread.svelte.js';
import { ui } from '$lib/state/ui.svelte.js';
import { pins } from '$lib/state/pins.svelte.js';
import { savedDrafts } from '$lib/state/saved-drafts.svelte.js';
import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
import { inbox } from '$lib/state/inbox.svelte.js';
import type { Widget } from '$lib/api.js';
import type { ThreadsSocket } from '$lib/ws.svelte.js';

type TypingUser = { userId: string; username: string; threadId: string | null };
type ChannelMember = { user_id: string; username: string; display_name: string | null };

type ChannelSessionState = {
	activeChannelId: () => string | null | undefined;
	isChannelSelected: () => boolean;
	typingUsers: () => TypingUser[];
	setTypingUsers: (users: TypingUser[]) => void;
	channelMembers: () => ChannelMember[];
	setChannelMembers: (members: ChannelMember[]) => void;
	setChannelWidgets: (widgets: Widget[]) => void;
	setEditingDescription: (editing: boolean) => void;
	setEditingMessage: (message: { id: string; content: string } | null) => void;
	setHighlightMessageId: (id: string | null) => void;
};

const MIN_HIDDEN_MS = 5000;

export class ChannelSession {
	private cleanupHandlers: (() => void)[] = [];
	private hiddenAt: number | null = null;
	private refreshing = false;

	constructor(
		private ws: ThreadsSocket,
		private state: ChannelSessionState
	) {}

	open(channelId: string | null | undefined) {
		this.state.setEditingDescription(false);
		this.state.setEditingMessage(null);
		ui.closeWidget();
		ui.closeBoardPanel();
		ui.closePinsPanel();
		ui.closeSavedDraftsPanel();
		ui.closeDebugPanel();
		this.state.setChannelWidgets([]);

		if (!channelId) {
			this.close();
			return;
		}

		this.loadConversation(channelId);
		pins.load(channelId);
		savedDrafts.load(channelId);
		this.ws.connect(channelId);
		this.state.setTypingUsers([]);
		emojiPicker.loadFrequentEmojis();
		this.loadMembers(channelId);
		this.loadWidgets(channelId);
		this.markRead(channelId);
		this.installSocketHandlers(channelId);
	}

	close() {
		messages.clear();
		this.ws.disconnect();
		this.state.setTypingUsers([]);
		this.cleanupSocketHandlers();
	}

	dispose() {
		this.ws.disconnect();
		this.cleanupSocketHandlers();
	}

	visibilityChanged() {
		if (document.visibilityState === 'hidden') {
			this.hiddenAt = Date.now();
			return;
		}
		this.refreshOnVisible();
	}

	refreshOnVisible() {
		if (!auth.loggedIn) return;
		if (this.hiddenAt === null || Date.now() - this.hiddenAt < MIN_HIDDEN_MS) return;
		this.hiddenAt = null;
		this.refreshNow();
	}

	/** Network came back (window 'online' event): reconnect and refetch unconditionally. */
	networkOnline() {
		if (!auth.loggedIn) return;
		this.hiddenAt = null;
		this.refreshNow();
	}

	private refreshNow() {
		if (this.refreshing) return;
		this.refreshing = true;
		const done = () => { this.refreshing = false; };
		const activeChannelId = this.state.activeChannelId();

		this.ws.reconnectIfNeeded();

		const tasks: Promise<void>[] = [
			channels.load().catch(() => {}),
			dms.load().catch(() => {}),
		];
		if (activeChannelId) {
			// refreshLatest picks up edits/reactions on the newest page;
			// catchUp pages any gap beyond it.
			tasks.push(
				messages.refreshLatest().then(() => messages.catchUp()).catch(() => {})
			);
		}
		if (thread.open) {
			tasks.push(thread.refreshLatest().catch(() => {}));
		}

		if (activeChannelId) {
			this.markRead(activeChannelId);
		}

		Promise.all(tasks).then(() => {
			const latestChannelId = this.state.activeChannelId();
			if (latestChannelId) {
				channels.markRead(latestChannelId);
				dms.markRead(latestChannelId);
				queueMicrotask(() => updateBadge());
			}
			done();
		}, done);
	}


	private loadConversation(channelId: string) {
		const requestedAnchor = messages.consumeAnchorLoad(channelId);
		if (requestedAnchor) {
			messages.loadAround(channelId, requestedAnchor.anchorId, {
				showUnreadDivider: requestedAnchor.showUnreadDivider,
			});
			return;
		}

		const ch = channels.list.find((c) => c.id === channelId);
		const dm = dms.list.find((d) => d.id === channelId);
		const lastReadId = ch?.last_read_message_id ?? dm?.last_read_message_id ?? null;
		const unreadCount = ch?.unread_count ?? dm?.unread_count ?? 0;
		if (unreadCount > 0 && lastReadId) {
			messages.loadAround(channelId, lastReadId);
		} else {
			messages.load(channelId);
		}
	}

	private loadMembers(channelId: string) {
		api.channels.members(channelId).then((m: any[]) => {
			if (this.state.activeChannelId() === channelId) {
				this.state.setChannelMembers(m.map((member: any) => ({
					user_id: member.id || member.user_id,
					username: member.username,
					display_name: member.display_name ?? null,
				})));
			}
		}).catch(() => {});
	}

	private loadWidgets(channelId: string) {
		if (!this.state.isChannelSelected()) return;
		api.widgets.listForChannel(channelId).then((widgets) => {
			if (this.state.activeChannelId() === channelId) {
				this.state.setChannelWidgets(widgets);
			}
		}).catch(() => {});
	}

	private markRead(channelId: string) {
		api.channels.markRead(channelId).catch(() => {});
		inbox.markChannelReadLocal(channelId);
		channels.markRead(channelId);
		dms.markRead(channelId);
		queueMicrotask(() => updateBadge());
	}

	private installSocketHandlers(channelId: string) {
		this.cleanupSocketHandlers();
		// After an unclean close + reconnect, messages broadcast while the socket
		// was down were lost: page the gap from the REST API even if the tab
		// stayed visible the whole time.
		this.cleanupHandlers.push(
			this.ws.on('reconnected', (data) => {
				if (data.channelId !== channelId) return;
				messages
					.refreshLatest()
					.then(() => messages.catchUp())
					.catch(() => {});
				if (thread.open) thread.refreshLatest().catch(() => {});
			})
		);
		this.cleanupHandlers.push(...setupChannelSocket(
			this.ws,
			channelId,
			this.state.typingUsers,
			this.state.setTypingUsers,
			{
				onMemberAdded: (data) => {
					if (data.channelId === channelId && data.username) {
						const currentMembers = this.state.channelMembers();
						if (!currentMembers.some((m) => m.user_id === data.targetUserId)) {
							this.state.setChannelMembers([...currentMembers, {
								user_id: data.targetUserId,
								username: data.username,
								display_name: data.displayName ?? null,
							}]);
						}
					}
				}
			}
		));
	}

	private cleanupSocketHandlers() {
		this.cleanupHandlers.forEach((fn) => fn());
		this.cleanupHandlers = [];
	}
}
