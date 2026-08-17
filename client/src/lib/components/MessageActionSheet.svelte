<script lang="ts">
	import { messageActions } from '$lib/state/message-actions.svelte.js';
	import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Plus from 'phosphor-svelte/lib/Plus';
	import Copy from 'phosphor-svelte/lib/Copy';
	import Link from 'phosphor-svelte/lib/Link';
	import ArrowBendUpLeft from 'phosphor-svelte/lib/ArrowBendUpLeft';
	import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
	import Trash from 'phosphor-svelte/lib/Trash';
	import PushPin from 'phosphor-svelte/lib/PushPin';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';

	// Group existing reactions on the message by emoji, in encounter order.
	// Tapping toggles via selectReaction (the onreaction callback already
	// handles add/remove based on whether the current user reacted).
	let groupedReactions = $derived.by(() => {
		const groups = new Map<string, { emoji: string; users: string[]; userIds: string[]; mine: boolean }>();
		const myId = auth.user?.id ?? '';
		for (const r of messageActions.message?.reactions ?? []) {
			const g = groups.get(r.emoji) ?? { emoji: r.emoji, users: [], userIds: [], mine: false };
			g.users.push(r.username);
			g.userIds.push(r.userId);
			if (r.userId === myId) g.mine = true;
			groups.set(r.emoji, g);
		}
		return Array.from(groups.values());
	});
</script>

{#if messageActions.isOpen}
	<button
		type="button"
		class="action-sheet-backdrop"
		onclick={() => messageActions.close()}
		ontouchstart={(e: TouchEvent) => e.stopPropagation()}
		ontouchmove={(e: TouchEvent) => e.stopPropagation()}
		ontouchend={(e: TouchEvent) => { e.stopPropagation(); e.preventDefault(); messageActions.close(); }}
		aria-label="Close message actions"
	></button>
	<div
		class="action-sheet"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
		ontouchstart={(e: TouchEvent) => e.stopPropagation()}
		ontouchmove={(e: TouchEvent) => e.stopPropagation()}
		ontouchend={(e: TouchEvent) => e.stopPropagation()}
		role="dialog"
		tabindex="-1"
	>
		<div class="action-sheet-handle"></div>

		<!-- Existing reactions on this message (tap to toggle) -->
		{#if groupedReactions.length > 0}
			<div class="existing-reactions" aria-label="Message reactions">
				{#each groupedReactions as reaction (reaction.emoji)}
					<button
						class="reaction-row"
						class:mine={reaction.mine}
						onclick={() => messageActions.selectReaction(reaction.emoji)}
						ontouchend={(e) => { e.preventDefault(); messageActions.selectReaction(reaction.emoji); }}
						aria-label={`${reaction.emoji} reaction from ${reaction.users.join(', ')}`}
					>
						<span class="reaction-pill" aria-hidden="true">
							<span class="reaction-emoji">{reaction.emoji}</span>
							<span class="reaction-count">{reaction.users.length}</span>
						</span>
						<span class="reaction-users">
							{#each reaction.users as username, i (username)}
								<span class:current-user={reaction.userIds[i] === auth.user?.id}>
									{username}{reaction.userIds[i] === auth.user?.id ? ' (you)' : ''}{i < reaction.users.length - 1 ? ', ' : ''}
								</span>
							{/each}
						</span>
					</button>
				{/each}
			</div>
		{/if}

		<!-- Quick emoji row -->
		<div class="emoji-row">
			{#each emojiPicker.quickEmojis as emoji (emoji)}
				<button
					class="emoji-btn"
					onclick={() => messageActions.selectReaction(emoji)}
					ontouchend={(e) => { e.preventDefault(); messageActions.selectReaction(emoji); }}
				>
					{emoji}
				</button>
			{/each}
			<button
				class="emoji-btn emoji-more"
				onclick={() => {
					const savedOnreaction = messageActions.getOnreaction();
					messageActions.forceClose();
					if (savedOnreaction) {
						emojiPicker.open(savedOnreaction);
					}
				}}
				ontouchend={(e) => {
					e.preventDefault();
					const savedOnreaction = messageActions.getOnreaction();
					messageActions.forceClose();
					if (savedOnreaction) {
						emojiPicker.open(savedOnreaction);
					}
				}}
				title="More emojis"
			>
				<Plus size={20} />
			</button>
		</div>

		<div class="action-divider"></div>

		<!-- Action buttons -->
		<div class="action-list">
			<button class="action-item" onclick={() => {
				const text = messageActions.message?.content || '';
				navigator.clipboard.writeText(text);
				messageActions.close();
			}}>
				<Copy size={20} />
				<span>Copy message</span>
			</button>
			<button class="action-item" onclick={() => messageActions.copyLink()}>
				<Link size={20} />
				<span>Copy link</span>
			</button>
			{#if messageActions.hasReply}
				<button class="action-item" onclick={() => messageActions.reply()}>
					<ArrowBendUpLeft size={20} />
					<span>Reply in thread</span>
				</button>
			{/if}
			{#if messageActions.hasPin}
				<button class="action-item" onclick={() => messageActions.togglePin()}>
					<PushPin size={20} weight={messageActions.isPinned ? 'fill' : 'regular'} />
					<span>{messageActions.isPinned ? 'Unpin from channel' : 'Pin to channel'}</span>
				</button>
			{/if}
			{#if messageActions.hasResolve}
				<button class="action-item" onclick={() => messageActions.toggleResolve()}>
					<CheckCircle size={20} weight={messageActions.isResolved ? 'fill' : 'regular'} />
					<span>{messageActions.isResolved ? 'Mark as not resolved' : 'Mark as resolved'}</span>
				</button>
			{/if}
			{#if messageActions.isOwnMessage}
				<button class="action-item" onclick={() => messageActions.edit()}>
					<PencilSimple size={20} />
					<span>Edit message</span>
				</button>
				<button class="action-item action-danger" onclick={() => messageActions.delete()}>
					<Trash size={20} />
					<span>Delete message</span>
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.action-sheet-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 9998;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}

	.action-sheet {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--color-bg-surface);
		border-radius: 0.75rem 0.75rem 0 0;
		padding: 0.5rem 1rem 1rem;
		padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		z-index: 9999;
		box-shadow: 0 -4px 6px -1px rgb(0 0 0 / 0.3);
		-webkit-tap-highlight-color: transparent;
	}

	.action-sheet-handle {
		width: 2rem;
		height: 0.25rem;
		background: var(--color-text-muted);
		border-radius: 9999px;
		margin: 0 auto 0.75rem;
		opacity: 0.4;
	}

	.existing-reactions {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.25rem 0 0.5rem;
	}

	.reaction-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: 0.5rem;
		border: none;
		background: none;
		color: var(--color-text);
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.reaction-row:active {
		background: var(--color-bg-hover);
	}

	.reaction-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		border: 1px solid var(--color-border);
		background: none;
		color: var(--color-text);
		font-size: 0.875rem;
		flex: 0 0 auto;
	}

	.reaction-row.mine .reaction-pill {
		border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
		background: color-mix(in srgb, var(--color-accent) 10%, transparent);
	}

	.reaction-count {
		color: var(--color-text-muted);
		font-size: 0.75rem;
	}

	.reaction-users {
		min-width: 0;
		font-size: 0.8125rem;
		line-height: 1.25;
		color: var(--color-text-muted);
	}

	.current-user {
		color: var(--color-text);
		font-weight: 500;
	}

	.emoji-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}

	.emoji-btn {
		width: 3rem;
		height: 3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.5rem;
		font-size: 1.5rem;
		background: none;
		border: none;
		cursor: pointer;
		color: inherit;
	}

	.emoji-btn:active {
		background: var(--color-bg-hover);
	}

	.emoji-more {
		color: var(--color-text-muted);
		font-size: 1rem;
	}

	.action-divider {
		height: 1px;
		background: var(--color-border);
		margin: 0.5rem 0;
	}

	.action-list {
		display: flex;
		flex-direction: column;
	}

	.action-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0.5rem;
		border-radius: 0.5rem;
		font-size: 0.9375rem;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text);
		width: 100%;
		text-align: left;
	}

	.action-item:active {
		background: var(--color-bg-hover);
	}

	.action-danger {
		color: var(--color-danger);
	}
</style>
