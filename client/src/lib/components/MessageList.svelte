<script lang="ts">
	import { onMount } from 'svelte';
	import { messages } from '$lib/state/messages.svelte.js';
	import { pins } from '$lib/state/pins.svelte.js';
	import { dateKey, formatDateSeparator } from '$lib/utils/time.js';
	import MessageItem from './MessageItem.svelte';
	import AgentSteps from './AgentSteps.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { groupMessages, type RenderItem } from '$lib/utils/groupSteps.js';
	import type { Message } from '$lib/state/messages.svelte.js';

	interface Props {
		onreply: (message: Message) => void;
		typingUsers: { userId: string; username: string }[];
		highlightMessageId?: string | null;
		onclearHighlight?: () => void;
		onprocesskill?: (messageId: string, processId: string) => void;
		onprocessretry?: (messageId: string, processId: string) => void;
		knownUsernames?: Set<string>;
		knownChannelNames?: Set<string>;
		onchannelclick?: (channelName: string) => void;
		onmentionclick?: (username: string) => void;
		onstartedit?: (message: Message) => void;
		onnavigatetomessage?: (messageId: string, channelId: string) => void;
		onpin?: (message: Message) => void;
		onunpin?: (message: Message) => void;
		onresolve?: (message: Message) => void;
		onunresolve?: (message: Message) => void;
	}

	let { onreply, typingUsers, highlightMessageId, onclearHighlight, onprocesskill, onprocessretry, knownUsernames, knownChannelNames, onchannelclick, onmentionclick, onstartedit, onnavigatetomessage, onpin, onunpin, onresolve, onunresolve }: Props = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();
	let shouldAutoScroll = $state(true);
	let prevMessageCount = $state(0);
	let lastHandledLoadGeneration = $state(0);
	// Track programmatic scrolls so we don't dismiss the keyboard for them.
	let isProgrammaticScroll = false;
	// Track whether user is actively touching the scroll area.
	// Only blur input (dismiss keyboard) when scroll is from an active touch,
	// not from layout shifts caused by incoming WebSocket updates (e.g.
	// process_status, new messages, reactions).
	let isUserTouching = false;
	// Track last focus time — keyboard open causes layout-triggered scroll events
	// that aren't programmatic but also aren't user-initiated. Guard against those.
	let lastFocusTime = 0;
	let deleteConfirmMessageId = $state<string | null>(null);
	function trackFocus() { lastFocusTime = Date.now(); }

	// Group messages by date, then collapse consecutive agent step messages
	// (progress / tool_output / thinking) into a single AgentSteps block so they
	// don't each render as their own bubble.
	let groupedMessages = $derived.by(() => {
		const groups: { date: string; label: string; items: RenderItem[] }[] = [];
		let currentKey = '';
		let buffer: Message[] = [];
		const flushBuffer = () => {
			if (buffer.length === 0) return;
			groups[groups.length - 1].items.push(...groupMessages(buffer));
			buffer = [];
		};
		for (const msg of messages.list) {
			const key = dateKey(msg.created_at);
			if (key !== currentKey) {
				flushBuffer();
				currentKey = key;
				groups.push({
					date: key,
					label: formatDateSeparator(msg.created_at),
					items: []
				});
			}
			buffer.push(msg);
		}
		flushBuffer();
		return groups;
	});

	function scrollToBottom() {
		if (scrollContainer) {
			isProgrammaticScroll = true;
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
			requestAnimationFrame(() => { isProgrammaticScroll = false; });
		}
	}

	function scrollToInitialPosition() {
		if (messages.firstUnreadId) {
			const firstUnreadId = messages.firstUnreadId;
			requestAnimationFrame(() => {
				const el = document.getElementById(`msg-${firstUnreadId}`);
				if (el) {
					isProgrammaticScroll = true;
					el.scrollIntoView({ block: 'start' });
					// Offset slightly so the "New" divider is visible above
					if (scrollContainer) {
						scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 40);
					}
					requestAnimationFrame(() => { isProgrammaticScroll = false; });
					shouldAutoScroll = false;
				} else {
					shouldAutoScroll = true;
					scrollToBottom();
				}
			});
		} else {
			shouldAutoScroll = true;
			requestAnimationFrame(scrollToBottom);
		}
	}

	function handleScroll() {
		if (!scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		// Auto-scroll if near bottom
		shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 100;
		// Dismiss mobile keyboard only on genuine user-initiated scrolls.
		// Skip if: programmatic scroll, not actively touching the scroll area,
		// or within 600ms of a focus event (keyboard open causes layout-triggered
		// scroll events that would immediately blur).
		if (!isProgrammaticScroll && isUserTouching && (Date.now() - lastFocusTime > 600) && document.activeElement instanceof HTMLElement) {
			const tag = document.activeElement.tagName;
			if (tag === 'TEXTAREA' || tag === 'INPUT') {
				document.activeElement.blur();
			}
		}
		// Load more when scrolling near top
		if (scrollTop < 100 && messages.hasMore && !messages.loadingMore) {
			const oldHeight = scrollContainer.scrollHeight;
			messages.loadMore().then(() => {
				// Maintain scroll position after prepending
				if (scrollContainer) {
					isProgrammaticScroll = true;
					const newHeight = scrollContainer.scrollHeight;
					scrollContainer.scrollTop = newHeight - oldHeight;
					requestAnimationFrame(() => { isProgrammaticScroll = false; });
				}
			});
		}
		// Load newer when scrolling near bottom (anchored mid-history view)
		if (scrollHeight - scrollTop - clientHeight < 200 && messages.hasNewer && !messages.loadingNewer) {
			messages.loadNewer();
		}
		// Dismiss the unread divider once user scrolls past it
		if (shouldAutoScroll && messages.firstUnreadId) {
			messages.dismissDivider();
		}
	}

	$effect(() => {
		// Scroll to bottom when new messages arrive (if user was already at bottom).
		// Skip while a channel load is in progress; initial placement is handled by
		// the load-generation effect below.
		const count = messages.list.length;
		if (!messages.loading && count > prevMessageCount && shouldAutoScroll) {
			requestAnimationFrame(scrollToBottom);
		}
		prevMessageCount = count;
	});

	$effect(() => {
		// Every explicit channel load gets a generation, including cached loads that
		// never flip loading true. Apply the initial position exactly once per load:
		// bottom by default, or the oldest unread message when an unread anchor exists.
		if (messages.loadGeneration !== lastHandledLoadGeneration && !messages.loading && messages.list.length > 0) {
			lastHandledLoadGeneration = messages.loadGeneration;
			scrollToInitialPosition();
		}
	});

	// Scroll to bottom when mobile keyboard opens/closes (viewport resize).
	// Debounced 300ms — iOS keyboard animation takes ~250ms.
	onMount(() => {
		// Track focus events to guard blur-on-scroll from keyboard layout shifts
		document.addEventListener('focusin', trackFocus, true);

		if (!window.visualViewport) {
			return () => document.removeEventListener('focusin', trackFocus, true);
		}
		let resizeTimer: ReturnType<typeof setTimeout>;
		function onViewportResize() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				if (shouldAutoScroll) {
					scrollToBottom();
				}
			}, 300);
		}
		window.visualViewport.addEventListener('resize', onViewportResize);
		return () => {
			clearTimeout(resizeTimer);
			window.visualViewport?.removeEventListener('resize', onViewportResize);
			document.removeEventListener('focusin', trackFocus, true);
		};
	});

	$effect(() => {
		if (highlightMessageId && !messages.loading) {
			const targetId = highlightMessageId;
			// Retry finding the element — DOM/message list may not be ready
			// immediately after a channel switch. 10 attempts × 100ms = 1s window.
			let attempts = 0;
			const tryHighlight = () => {
				const el = document.getElementById(`msg-${targetId}`);
				if (el) {
					el.scrollIntoView({ behavior: 'smooth', block: 'center' });
					el.classList.add('message-highlight');
					setTimeout(() => {
						el.classList.remove('message-highlight');
						onclearHighlight?.();
					}, 1500);
				} else if (attempts < 10) {
					attempts++;
					setTimeout(tryHighlight, 100);
				} else {
					// Target message isn't in the currently-loaded window (probably
					// older than the initial channel page). Clear so UI doesn't get
					// stuck — future improvement: fetch message context.
					console.warn(`[jump-to-message] msg-${targetId} not found in DOM after ${attempts} attempts`);
					onclearHighlight?.();
				}
			};
			setTimeout(tryHighlight, 100);
		}
	});

	function handleDelete(messageId: string) {
		deleteConfirmMessageId = messageId;
	}

	async function confirmDeleteMessage() {
		if (!deleteConfirmMessageId) return;
		const messageId = deleteConfirmMessageId;
		deleteConfirmMessageId = null;
		try {
			await messages.remove(messageId);
			messages.removeMessage(messageId);
		} catch (err) {
			console.error('Failed to delete message:', err);
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative flex-1 min-h-0 flex flex-col">
<div
	bind:this={scrollContainer}
	onscroll={handleScroll}
	ontouchstart={() => { isUserTouching = true; }}
	ontouchend={() => { isUserTouching = false; }}
	ontouchcancel={() => { isUserTouching = false; }}
	class="dark-scrollbar flex-1 min-h-0 overflow-y-auto"
	style="overscroll-behavior: contain; -webkit-overflow-scrolling: touch;"
>
	{#if messages.loading}
		<div class="flex items-center justify-center h-full">
			<div class="text-[var(--color-text-muted)] text-sm">Loading messages...</div>
		</div>
	{:else if messages.loadError && messages.list.length === 0}
		<div class="flex items-center justify-center h-full">
			<div class="text-center text-[var(--color-text-muted)]">
				<p class="text-sm">Couldn't load messages</p>
				<button
					onclick={() => messages.retryLoad()}
					class="text-xs mt-2 underline hover:no-underline text-[var(--color-accent)]"
				>
					Retry
				</button>
			</div>
		</div>
	{:else if messages.list.length === 0}
		<div class="flex items-center justify-center h-full">
			<div class="text-center text-[var(--color-text-muted)]">
				<p class="text-sm">No messages yet</p>
				<p class="text-xs mt-1">Be the first to send a message!</p>
			</div>
		</div>
	{:else}
		{#if messages.loadingMore}
			<div class="py-2 text-center text-xs text-[var(--color-text-muted)]">
				Loading older messages...
			</div>
		{/if}

		{#each groupedMessages as group (group.date)}
			<div class="flex items-center gap-3 px-4 py-2 my-2">
				<div class="flex-1 h-px bg-[var(--color-border)]"></div>
				<span class="text-xs text-[var(--color-text-muted)] font-medium shrink-0"
					>{group.label}</span
				>
				<div class="flex-1 h-px bg-[var(--color-border)]"></div>
			</div>

			{#each group.items as item (item.kind === 'steps' ? item.id : item.message.id)}
				{#if item.kind === 'steps'}
					<AgentSteps
						messages={item.messages}
						open={item.open}
						status={item.status}
						triggerMessageId={item.triggerMessageId}
						processId={item.processId}
						{onprocesskill}
						{knownUsernames}
						{knownChannelNames}
					/>
				{:else}
					{#if messages.firstUnreadId && item.message.id === messages.firstUnreadId}
						<div class="flex items-center gap-3 px-4 py-1 my-1">
							<div class="flex-1 h-px bg-red-500/70"></div>
							<span class="text-xs text-red-500/90 font-medium shrink-0">New</span>
							<div class="flex-1 h-px bg-red-500/70"></div>
						</div>
					{/if}
					<div id="msg-{item.message.id}">
						<MessageItem
							message={item.message}
							{onreply}
							ondelete={handleDelete}
							onedit={onstartedit}
							{onprocesskill}
							{onprocessretry}
							hideProcessStatus={item.hasStepBlock}
							{knownUsernames}
							{knownChannelNames}
							{onchannelclick}
							{onmentionclick}
							{onnavigatetomessage}
							isPinned={!!item.message.pinned || pins.isPinned(item.message.id)}
							{onpin}
							{onunpin}
							{onresolve}
							{onunresolve}
						/>
					</div>
				{/if}
			{/each}
		{/each}
	{/if}

	{#if messages.loadingNewer}
		<div class="py-2 text-center text-xs text-[var(--color-text-muted)]">
			Loading newer messages...
		</div>
	{/if}
</div>

{#if typingUsers.length > 0}
	<div class="shrink-0 px-4 py-1 text-xs text-[var(--color-text-muted)] italic">
		{#if typingUsers.length === 1}
			{typingUsers[0].username} is typing...
		{:else if typingUsers.length === 2}
			{typingUsers[0].username} and {typingUsers[1].username} are typing...
		{:else}
			Several people are typing...
		{/if}
	</div>
{/if}

{#if !shouldAutoScroll}
	<button
		onclick={() => { shouldAutoScroll = true; scrollToBottom(); }}
		class="scroll-to-bottom"
		aria-label="Scroll to latest message"
	>
		<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<polyline points="6 8 10 12 14 8" />
		</svg>
	</button>
{/if}

{#if deleteConfirmMessageId}
	<ConfirmDialog
		title="Delete message?"
		message="This message will be permanently deleted for everyone in this channel. This cannot be undone."
		confirmLabel="Delete message"
		onconfirm={confirmDeleteMessage}
		oncancel={() => (deleteConfirmMessageId = null)}
	/>
{/if}
</div>

<style>
	:global(.message-highlight) {
		animation: message-pulse 1.5s ease-out;
	}

	@keyframes message-pulse {
		0%, 20% { background-color: color-mix(in srgb, var(--color-accent) 20%, transparent); }
		100% { background-color: transparent; }
	}

	.scroll-to-bottom {
		position: absolute;
		bottom: 12px;
		right: 12px;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--color-bg-secondary, #2a2a2e);
		border: 1px solid var(--color-border, #3a3a3e);
		color: var(--color-text-muted, #a0a0a0);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		transition: color 0.15s, background 0.15s;
		z-index: 10;
	}

	.scroll-to-bottom:hover {
		background: var(--color-bg-tertiary, #333);
		color: var(--color-text, #e0e0e0);
	}
</style>
