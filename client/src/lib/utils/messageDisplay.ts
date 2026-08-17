// Pure display helpers extracted from MessageItem.svelte.

import type { Reaction } from '$lib/state/messages.svelte.js';

export interface ReactionGroup {
	emoji: string;
	users: string[];
	userIds: string[];
}

/** Group a message's reactions by emoji, preserving first-seen order. */
export function groupReactions(reactions: Reaction[] | undefined): ReactionGroup[] {
	const groups = new Map<string, ReactionGroup>();
	for (const r of reactions || []) {
		if (!groups.has(r.emoji)) {
			groups.set(r.emoji, { emoji: r.emoji, users: [], userIds: [] });
		}
		const g = groups.get(r.emoji)!;
		g.users.push(r.username);
		g.userIds.push(r.userId);
	}
	return Array.from(groups.values());
}

/** 123B / 12KB / 1.5MB */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
