import { tick, untrack } from 'svelte';
import { api } from '$lib/api.js';
import { channels } from '$lib/state/channels.svelte.js';
import { dms } from '$lib/state/dms.svelte.js';
import { messages, type Message } from '$lib/state/messages.svelte.js';
import { navigation, type NavEntry } from '$lib/state/navigation.svelte.js';
import { thread } from '$lib/state/thread.svelte.js';
import { ui } from '$lib/state/ui.svelte.js';
import { folders } from '$lib/state/folders.svelte.js';
import { FEEDBACK_CHANNEL_ID } from '$lib/constants.js';
import {
	buildConversationNavigationOrder,
	findUnreadConversation,
	type UnreadNavigationDirection,
} from '$lib/unreadNavigation.js';

type NavigationControllerState = {
	setHighlightMessageId: (id: string | null) => void;
};

export class NavigationController {
	constructor(private state: NavigationControllerState) {}

	recordCurrentSelection(entry: NavEntry) {
		untrack(() => {
			if (entry.view !== 'channels' || entry.channelId || entry.dmId) {
				navigation.push(entry);
			}
		});
	}

	goBack() {
		const entry = navigation.back();
		if (entry) this.openEntry(entry);
	}

	goForward() {
		const entry = navigation.forward();
		if (entry) this.openEntry(entry);
	}

	goToUnread(direction: UnreadNavigationDirection) {
		const items = buildConversationNavigationOrder(
			channels.list,
			folders.list,
			dms.list,
			[FEEDBACK_CHANNEL_ID]
		);
		const target = findUnreadConversation(
			items,
			channels.selectedId ?? dms.selectedId,
			direction
		);
		if (!target) return null;

		ui.setView('channels');
		if (thread.open) thread.close();
		if (target.kind === 'dm') {
			dms.select(target.id);
		} else {
			if (dms.selectedId) dms.select(null);
			channels.select(target.id);
		}
		return target;
	}

	async openEntry(entry: NavEntry) {
		navigation.navigating = true;
		try {
			if (entry.view !== 'channels') {
				channels.select(null);
				dms.select(null);
				if (thread.open) thread.close();
				ui.setView(entry.view);
				return;
			}

			ui.setView('channels');
			if (entry.dmId) {
				dms.select(entry.dmId);
			} else if (entry.channelId) {
				await channels.ensureLoaded(entry.channelId);
				channels.select(entry.channelId);
				if (dms.selectedId) dms.select(null);
			}

			if (entry.threadMessageId) {
				const msg = (await api.messages.get(entry.threadMessageId)) as unknown as Message;
				await thread.openThread(msg);
			} else if (thread.open) {
				thread.close();
			}
		} finally {
			navigation.navigating = false;
		}
	}

	async openDeepLinkUrl(url: URL, options: { replaceUrl?: boolean } = {}) {
		const channelId = url.searchParams.get('channel');
		if (!channelId) return false;

		const messageId = url.searchParams.get('msg');
		if (messageId) {
			await this.openMessage(messageId, channelId);
		} else {
			await this.openChannelOrDm(channelId);
		}

		if (options.replaceUrl) {
			window.history.replaceState({}, '', window.location.pathname);
		}
		return true;
	}

	async openInitialUrlSearch(search: string) {
		const url = new URL(window.location.href);
		url.search = search;
		const channelId = url.searchParams.get('channel');
		if (!channelId) return;

		await this.waitForChannelList();
		await this.openDeepLinkUrl(url, { replaceUrl: true });
	}

	async openMessage(
		messageId: string,
		channelId?: string,
		isDm?: boolean,
		dmPartnerId?: string | null
	) {
		let targetChannelId = channelId;
		let targetIsDm = isDm;

		try {
			const msg = (await api.messages.get(messageId)) as unknown as Message;
			targetChannelId = msg.channel_id ?? targetChannelId;
			targetIsDm = targetIsDm || msg.is_dm === 1 || msg.is_dm === true;

			if (msg.thread_id) {
				await this.selectTarget(targetChannelId, targetIsDm, dmPartnerId);
				await thread.openThread(msg, {
					aroundReplyId: messageId,
					highlightReplyId: messageId,
				});
				return;
			}
		} catch {
			// If fetch fails, fall through to channel/DM highlight using caller-provided hints.
		}
		if (targetChannelId) {
			messages.requestAnchorLoad(targetChannelId, messageId);
		}
		await this.selectTarget(targetChannelId, targetIsDm, dmPartnerId);

		await tick();
		if (targetChannelId) {
			const requestedAnchor = messages.consumeAnchorLoad(targetChannelId);
			if (requestedAnchor) {
				await messages.loadAround(targetChannelId, requestedAnchor.anchorId, {
					showUnreadDivider: requestedAnchor.showUnreadDivider,
				});
			}
		}

		this.state.setHighlightMessageId(messageId);
	}

	handleDeepLinkClick(event: MouseEvent) {
		const anchor = (event.target as HTMLElement).closest?.('a');
		if (!anchor) return;
		const href = anchor.getAttribute('href');
		if (!href) return;

		let url: URL;
		try {
			url = new URL(href, window.location.origin);
		} catch {
			return;
		}

		if (url.origin !== window.location.origin || !url.searchParams.get('channel')) return;

		event.preventDefault();
		event.stopPropagation();
		this.openDeepLinkUrl(url).catch(() => {});
	}

	handleServiceWorkerMessage(event: MessageEvent) {
		if (event.data?.type !== 'deep-link') return;
		const url = new URL(event.data.url, window.location.origin);
		this.openDeepLinkUrl(url).catch(() => {});
	}

	private async openChannelOrDm(channelId: string) {
		const dm = dms.list.find((d) => d.id === channelId);
		if (dm) {
			dms.select(channelId);
			channels.removeLocal(channelId);
			return;
		}

		const channel = await api.channels.get(channelId);
		if (channel?.is_dm === 1) {
			await dms.load();
			dms.select(channelId);
			channels.removeLocal(channelId);
			return;
		}

		await channels.ensureLoaded(channelId);
		channels.select(channelId);
	}

	private async selectTarget(channelId?: string, isDm?: boolean, dmPartnerId?: string | null) {
		if (!channelId) return;
		if (isDm) {
			if (!dms.list.some((d) => d.id === channelId)) {
				await dms.load();
			}
			if (dms.list.some((d) => d.id === channelId)) {
				dms.select(channelId);
			} else if (dmPartnerId) {
				await dms.openDM(dmPartnerId);
			} else {
				dms.select(channelId);
			}
			channels.removeLocal(channelId);
			return;
		}

		await this.openChannelOrDm(channelId);
	}

	private waitForChannelList() {
		if (channels.list.length > 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				if (channels.list.length > 0) {
					clearInterval(interval);
					resolve();
				}
			}, 100);
			setTimeout(() => {
				clearInterval(interval);
				resolve();
			}, 5000);
		});
	}
}
