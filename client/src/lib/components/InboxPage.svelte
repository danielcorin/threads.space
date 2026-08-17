<script lang="ts">
	import { onMount } from 'svelte';
	import { inbox, type InboxMessage } from '$lib/state/inbox.svelte.js';
	import { renderMarkdown } from '$lib/utils/markdown.js';
	import { formatTime } from '$lib/utils/time.js';
	import ArchiveTray from 'phosphor-svelte/lib/Tray';
	import ArrowBendUpLeft from 'phosphor-svelte/lib/ArrowBendUpLeft';
	import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
	import Check from 'phosphor-svelte/lib/Check';
	import List from 'phosphor-svelte/lib/List';

	interface Props {
		onnavigatetomessage?: (messageId: string, channelId: string, isDm: boolean, dmPartnerId?: string | null) => void;
		onopensidebar?: () => void;
	}

	let { onnavigatetomessage, onopensidebar }: Props = $props();
	let replyingTo = $state<string | null>(null);
	let replyContent = $state('');
	let sendingReply = $state(false);
	let marking = $state<string[]>([]);
	let actionError = $state<string | null>(null);

	onMount(() => {
		inbox.load();
	});

	function senderName(message: InboxMessage): string {
		return message.display_name || message.username || 'Unknown';
	}

	function locationLabel(message: InboxMessage): string {
		const location = message.is_dm
			? message.dm_partner_display_name || message.dm_partner_username || message.channel_name || 'Direct message'
			: `#${message.channel_name}`;
		return message.thread_id ? `${location} · Thread` : location;
	}

	function beginReply(messageId: string) {
		replyingTo = replyingTo === messageId ? null : messageId;
		replyContent = '';
		actionError = null;
	}

	async function markRead(messageId: string) {
		marking = [...marking, messageId];
		actionError = null;
		try {
			await inbox.markRead(messageId);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not mark the message read.';
		} finally {
			marking = marking.filter((id) => id !== messageId);
		}
	}

	async function sendReply(messageId: string) {
		const content = replyContent.trim();
		if (!content || sendingReply) return;
		sendingReply = true;
		actionError = null;
		try {
			await inbox.reply(messageId, content);
			replyingTo = null;
			replyContent = '';
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not send the reply.';
		} finally {
			sendingReply = false;
		}
	}

	function openConversation(message: InboxMessage) {
		onnavigatetomessage?.(message.id, message.channel_id, !!message.is_dm, message.dm_partner_id);
	}
</script>

<div class="flex flex-col h-full min-h-0 bg-[var(--color-bg)] text-[var(--color-text)]">
	<header class="h-12 px-3 md:px-4 flex items-center gap-2 border-b border-[var(--color-border)] shrink-0">
		{#if onopensidebar}
			<button
				class="md:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 p-1"
				title="Open sidebar"
				onclick={() => onopensidebar?.()}
			>
				<List size={20} />
			</button>
		{/if}
		<ArchiveTray size={18} />
		<h1 class="text-base font-semibold">Inbox</h1>
		<span class="text-xs text-[var(--color-text-muted)]">{inbox.total} unread</span>
		<button
			class="ml-auto text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
			disabled={inbox.loading}
			onclick={() => inbox.load()}
		>
			{inbox.loading ? 'Refreshing…' : 'Refresh'}
		</button>
	</header>

	{#if actionError}
		<div class="mx-3 md:mx-4 mt-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-sm text-red-400" role="alert">
			{actionError}
		</div>
	{/if}

	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if inbox.loading && !inbox.loaded}
			<div class="h-full flex items-center justify-center text-sm text-[var(--color-text-muted)]">Loading Inbox…</div>
		{:else if inbox.loadError && !inbox.loaded}
			<div class="h-full flex flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-muted)]">
				<p>Inbox could not be loaded.</p>
				<button class="px-3 py-1.5 rounded bg-[var(--color-accent)] text-white" onclick={() => inbox.load()}>Try again</button>
			</div>
		{:else if inbox.list.length === 0}
			<div class="h-full flex flex-col items-center justify-center text-center px-6 text-[var(--color-text-muted)]">
				<ArchiveTray size={42} class="mb-3 opacity-60" />
				<p class="font-medium text-[var(--color-text)]">You’re all caught up</p>
				<p class="text-sm mt-1">New messages and final agent responses will appear here.</p>
			</div>
		{:else}
			<div class="divide-y divide-[var(--color-border)]">
				{#each inbox.list as message (message.id)}
					<article class="px-3 md:px-5 py-4 hover:bg-[var(--color-bg-hover)]/40 transition-colors" data-testid="inbox-message">
						<div class="min-w-0">
							<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
								<span class="text-sm font-semibold" style:color={message.name_color || undefined}>{senderName(message)}</span>
								<button
									class="text-xs text-[var(--color-accent)] hover:underline min-w-0 truncate"
									title="Open conversation (marks this conversation read)"
									onclick={() => openConversation(message)}
								>
									{locationLabel(message)}
								</button>
								<span class="text-xs text-[var(--color-text-muted)]">{formatTime(message.created_at)}</span>
							</div>

							<div class="mt-1 text-sm leading-relaxed break-words inbox-markdown">
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html renderMarkdown(message.content || '')}
							</div>

							{#if message.attachments?.length}
								<div class="mt-2 flex flex-wrap gap-2">
									{#each message.attachments as attachment (attachment.id)}
										<a class="text-xs text-[var(--color-accent)] hover:underline" href={attachment.url} target="_blank" rel="noopener noreferrer">{attachment.filename}</a>
									{/each}
								</div>
							{/if}

							<div class="mt-3 flex flex-wrap items-center gap-2">
								<button
									class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
									disabled={marking.includes(message.id)}
									onclick={() => markRead(message.id)}
								>
									<Check size={13} />
									{marking.includes(message.id) ? 'Marking…' : 'Mark read'}
								</button>
								<button
									class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
									onclick={() => beginReply(message.id)}
								>
									<ArrowBendUpLeft size={13} /> Reply
								</button>
								<button
									class="inline-flex items-center gap-1 text-xs px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
									title="Opening the conversation marks all messages there read"
									onclick={() => openConversation(message)}
								>
									<ArrowSquareOut size={13} /> Open conversation
								</button>
							</div>

							{#if replyingTo === message.id}
								<form class="mt-3" onsubmit={(event) => { event.preventDefault(); sendReply(message.id); }}>
									<textarea
										bind:value={replyContent}
										rows="3"
										placeholder="Write a reply…"
										class="w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
									></textarea>
									<div class="mt-2 flex justify-end gap-2">
										<button type="button" class="text-xs px-3 py-1.5 text-[var(--color-text-muted)]" onclick={() => beginReply(message.id)}>Cancel</button>
										<button type="submit" class="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-white disabled:opacity-50" disabled={!replyContent.trim() || sendingReply}>
											{sendingReply ? 'Sending…' : 'Send reply'}
										</button>
									</div>
								</form>
							{/if}
						</div>
					</article>
				{/each}
			</div>

			{#if inbox.hasMore}
				<div class="p-4 flex justify-center">
					<button
						class="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
						disabled={inbox.loadingMore}
						onclick={() => inbox.loadMore()}
					>
						{inbox.loadingMore ? 'Loading…' : 'Load older'}
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	:global(.inbox-markdown p) {
		margin: 0.25rem 0;
	}

	:global(.inbox-markdown pre) {
		max-height: 16rem;
		overflow: auto;
	}
</style>
