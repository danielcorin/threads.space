export type UnreadNavigationDirection = -1 | 1;

export type SidebarRevealRequest = {
	conversationId: string;
	requestId: number;
};

type UnreadState = {
	id: string;
	has_unread?: number | boolean;
	unread_count?: number;
};

type ChannelLike = UnreadState & {
	is_ephemeral?: number | boolean;
};

type FolderLike = {
	channels: string[];
};

export type UnreadNavigationItem = {
	id: string;
	kind: 'channel' | 'dm';
	unread: boolean;
};

function hasUnread(item: UnreadState) {
	return Boolean(item.has_unread) || (item.unread_count ?? 0) > 0;
}

/** Build the same conversation order shown in the sidebar. */
export function buildConversationNavigationOrder(
	channelList: ChannelLike[],
	folderList: FolderLike[],
	dmList: UnreadState[],
	pinnedChannelIds: string[] = []
): UnreadNavigationItem[] {
	const channelById = new Map(channelList.map((channel) => [channel.id, channel]));
	const seen = new Set<string>();
	const ordered: UnreadNavigationItem[] = [];

	function appendChannel(channelId: string) {
		if (seen.has(channelId)) return;
		const channel = channelById.get(channelId);
		if (!channel) return;
		seen.add(channelId);
		ordered.push({ id: channel.id, kind: 'channel', unread: hasUnread(channel) });
	}

	for (const channelId of pinnedChannelIds) appendChannel(channelId);
	for (const folder of folderList) {
		for (const channelId of folder.channels) appendChannel(channelId);
	}
	for (const channel of channelList) {
		if (!channel.is_ephemeral) appendChannel(channel.id);
	}
	for (const channel of channelList) {
		if (channel.is_ephemeral) appendChannel(channel.id);
	}

	for (const dm of dmList) {
		ordered.push({ id: dm.id, kind: 'dm', unread: hasUnread(dm) });
	}

	return ordered;
}

/** Find the next unread conversation relative to the current sidebar position. */
export function findUnreadConversation(
	items: UnreadNavigationItem[],
	activeId: string | null | undefined,
	direction: UnreadNavigationDirection
): UnreadNavigationItem | null {
	if (items.length === 0) return null;

	const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
	if (activeIndex === -1) {
		const candidates = direction === 1 ? items : [...items].reverse();
		return candidates.find((item) => item.unread) ?? null;
	}

	for (let step = 1; step < items.length; step += 1) {
		const candidateIndex = (activeIndex + direction * step + items.length) % items.length;
		const candidate = items[candidateIndex];
		if (candidate.unread) return candidate;
	}

	return null;
}

export function unreadNavigationDirection(event: Pick<KeyboardEvent,
	'key' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'defaultPrevented'
>): UnreadNavigationDirection | null {
	if (
		event.defaultPrevented ||
		!event.altKey ||
		!event.shiftKey ||
		event.metaKey ||
		event.ctrlKey
	) return null;

	if (event.key === 'ArrowDown') return 1;
	if (event.key === 'ArrowUp') return -1;
	return null;
}
