<script lang="ts">
	import { thread } from '$lib/state/thread.svelte.js';
	import { messages as messagesState } from '$lib/state/messages.svelte.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import { onMount } from 'svelte';
	import { ui } from '$lib/state/ui.svelte.js';
	import { api } from '$lib/api.js';
	import type { Message } from '$lib/state/messages.svelte.js';
	import MessageItem from './MessageItem.svelte';
	import AgentSteps from './AgentSteps.svelte';
	import MessageComposer from './MessageComposer.svelte';
	import { groupMessages, type RenderItem } from '$lib/utils/groupSteps.js';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';
	import X from 'phosphor-svelte/lib/X';
	import Check from 'phosphor-svelte/lib/Check';
	import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
	import CloudArrowUp from 'phosphor-svelte/lib/CloudArrowUp';

	interface ChannelInfo {
		id: string;
		name: string;
	}

	interface MemberInfo {
		user_id: string;
		username: string;
		display_name: string | null;
	}

	interface Props {
		onprocesskill?: (messageId: string, processId: string) => void;
		onprocessretry?: (messageId: string, processId: string) => void;
		knownUsernames?: Set<string>;
		knownChannelNames?: Set<string>;
		onchannelclick?: (channelName: string) => void;
		onmentionclick?: (username: string) => void;
		channels?: ChannelInfo[];
		members?: MemberInfo[];
		onnavigatetomessage?: (messageId: string, channelId?: string) => void;
		typingUsers?: { userId: string; username: string }[];
		ontypingstart?: () => void;
		ontypingstop?: () => void;
	}

	let { onprocesskill, onprocessretry, knownUsernames, knownChannelNames, onchannelclick, onmentionclick, channels: channelsList = [], members = [], onnavigatetomessage, typingUsers = [], ontypingstart, ontypingstop }: Props = $props();

	let editingMessage = $state<{ id: string; content: string } | null>(null);
	let threadDragOver = $state(false);
	let threadDragCounter = 0;
	let threadDroppedFiles = $state<File[] | null>(null);
	let scrollContainer: HTMLDivElement | undefined = $state();
	let shouldAutoScroll = $state(true);
	let previousReplyCount = $state(0);
	let lastHandledLoadGeneration = $state(0);
	let editingTitle = $state(false);
	let titleDraft = $state('');
	let titleSaving = $state(false);
	let titleError = $state('');
	let titleInput: HTMLInputElement | undefined = $state();
	let retryCount = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	const MAX_AUTO_RETRIES = 3;

	const DEFAULT_THREAD_PANEL_WIDTH = 384;
	const MIN_THREAD_PANEL_WIDTH = 320;
	const MAX_THREAD_PANEL_WIDTH = 640;
	const THREAD_PANEL_WIDTH_STORAGE_KEY = 'threads-thread-panel-width';

	let threadPanelWidth = $state(DEFAULT_THREAD_PANEL_WIDTH);
	let isResizingThreadPanel = $state(false);

	// Collapse agent step rows (progress / tool_output / thinking) into AgentSteps
	// blocks, same as the main channel timeline. The parent is prepended so a step
	// whose trigger_id is the parent message anchors correctly.
	let threadItems = $derived.by((): RenderItem[] => {
		const list = thread.parentMessage ? [thread.parentMessage, ...thread.replies] : thread.replies;
		return groupMessages(list);
	});

	function clampThreadPanelWidth(width: number) {
		return Math.min(MAX_THREAD_PANEL_WIDTH, Math.max(MIN_THREAD_PANEL_WIDTH, Math.round(width)));
	}

	function persistThreadPanelWidth(width: number) {
		try {
			localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(width));
		} catch {
			// Ignore storage failures; resizing should still work for this session.
		}
	}

	function adjustThreadPanelWidth(delta: number) {
		threadPanelWidth = clampThreadPanelWidth(threadPanelWidth + delta);
		persistThreadPanelWidth(threadPanelWidth);
	}

	function handleThreadPanelResizeKeydown(e: KeyboardEvent) {
		if (ui.isMobile) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			adjustThreadPanelWidth(e.shiftKey ? 40 : 16);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			adjustThreadPanelWidth(e.shiftKey ? -40 : -16);
		} else if (e.key === 'Home') {
			e.preventDefault();
			threadPanelWidth = MIN_THREAD_PANEL_WIDTH;
			persistThreadPanelWidth(threadPanelWidth);
		} else if (e.key === 'End') {
			e.preventDefault();
			threadPanelWidth = MAX_THREAD_PANEL_WIDTH;
			persistThreadPanelWidth(threadPanelWidth);
		}
	}

	function handleThreadPanelResizePointerDown(e: PointerEvent) {
		if (ui.isMobile) return;
		e.preventDefault();
		isResizingThreadPanel = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const handlePointerMove = (moveEvent: PointerEvent) => {
			threadPanelWidth = clampThreadPanelWidth(window.innerWidth - moveEvent.clientX);
		};

		const handlePointerUp = () => {
			isResizingThreadPanel = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			persistThreadPanelWidth(threadPanelWidth);
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerUp);
		};

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerUp);
	}

	function isNearBottom(): boolean {
		if (!scrollContainer) return false;
		const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
		return scrollHeight - scrollTop - clientHeight < 100;
	}

	async function loadOlderRepliesPreservingScroll() {
		if (!scrollContainer) {
			await thread.loadMore();
			return;
		}
		const oldHeight = scrollContainer.scrollHeight;
		const oldTop = scrollContainer.scrollTop;
		await thread.loadMore();
		if (scrollContainer && !thread.loadError) {
			const newHeight = scrollContainer.scrollHeight;
			scrollContainer.scrollTop = newHeight - oldHeight + oldTop;
		}
	}

	function scheduleRetryIfNeeded() {
		if (thread.loadError && thread.hasMore && scrollContainer && scrollContainer.scrollTop < 100 && retryCount < MAX_AUTO_RETRIES) {
			clearTimeout(retryTimer);
			retryTimer = setTimeout(() => {
				retryCount++;
				loadOlderRepliesPreservingScroll().then(() => {
					if (thread.loadError) scheduleRetryIfNeeded();
				});
			}, 2000);
		}
	}

	function handleRetryClick() {
		retryCount = 0;
		loadOlderRepliesPreservingScroll().then(() => {
			if (thread.loadError) scheduleRetryIfNeeded();
		});
	}

	function handleScroll() {
		if (!scrollContainer) return;
		shouldAutoScroll = isNearBottom();
		// Load older replies when scrolling near the top. Replies render in ASC
		// order, but the initial page is the latest window.
		if (scrollContainer.scrollTop < 100 && thread.hasMore && !thread.loadingMore) {
			retryCount = 0;
			loadOlderRepliesPreservingScroll().then(() => {
				if (thread.loadError) scheduleRetryIfNeeded();
			});
		}
		if (scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 200 && thread.hasNewer && !thread.loadingNewer) {
			thread.loadNewer();
		}
	}

	function scrollToBottom() {
		if (scrollContainer) {
			scrollContainer.scrollTop = scrollContainer.scrollHeight;
		}
	}

	async function handleJumpToLatest() {
		shouldAutoScroll = true;
		if (thread.hasMore || thread.hasNewer) {
			await thread.loadLatest();
			// Wait for DOM to update before scrolling
			requestAnimationFrame(() => scrollToBottom());
		} else {
			scrollToBottom();
		}
	}

	// Delay adding the open class so the browser first renders at translateX(100%),
	// then transitions to translateX(0) on the next frame.
	let panelOpen = $state(false);
	onMount(() => {
		try {
			const storedWidth = Number(localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY));
			if (Number.isFinite(storedWidth) && storedWidth > 0) {
				threadPanelWidth = clampThreadPanelWidth(storedWidth);
			}
		} catch {
			// Ignore storage failures; the default width is fine.
		}

		requestAnimationFrame(() => {
			panelOpen = true;
		});
	});

	$effect(() => {
		if (thread.loadGeneration !== lastHandledLoadGeneration && !thread.loading && thread.parentMessage) {
			lastHandledLoadGeneration = thread.loadGeneration;
			shouldAutoScroll = !thread.highlightReplyId;
			if (!thread.highlightReplyId) {
				requestAnimationFrame(scrollToBottom);
			}
		}
	});

	$effect(() => {
		const replyCount = thread.replies.length;
		if (!thread.loading && replyCount > previousReplyCount && shouldAutoScroll) {
			requestAnimationFrame(scrollToBottom);
		}
		previousReplyCount = replyCount;
	});

	// Swipe-to-dismiss is handled by the unified gesture handler in +page.svelte.
	// ThreadPanel only needs close animation for the back button.

	async function handleSend(content: string, attachmentIds?: string[], _metadata?: Record<string, unknown>, idempotencyKey?: string) {
		const parent = thread.parentMessage;
		if (!parent) return;
		const sendKey = idempotencyKey ?? crypto.randomUUID();
		const optimisticId = `~pending-${Date.now().toString(36)}-${sendKey}`;
		thread.addReply({
			id: optimisticId,
			channel_id: parent.channel_id,
			user_id: auth.user?.id ?? null,
			content,
			thread_id: parent.id,
			type: 'message',
			edited_at: null,
			deleted_at: null,
			created_at: Math.floor(Date.now() / 1000),
			username: auth.user?.username,
			display_name: auth.user?.display_name,
			name_color: auth.user?.name_color ?? null,
			avatar_url: auth.user?.avatar_url ?? null,
			reactions: [],
			attachments: [],
			client_delivery_status: 'sending',
			client_idempotency_key: sendKey
		});
		try {
			const sent = await thread.sendReply(content, attachmentIds, sendKey);
			if (sent) {
				thread.replaceOptimisticReply(optimisticId, {
					id: sent.id,
					channel_id: sent.channelId ?? parent.channel_id,
					user_id: sent.userId ?? auth.user?.id ?? null,
					content: sent.content,
					thread_id: sent.threadId ?? parent.id,
					type: 'message',
					edited_at: null,
					deleted_at: null,
					created_at: sent.createdAt ?? Math.floor(Date.now() / 1000),
					username: sent.username ?? auth.user?.username,
					display_name: sent.displayName ?? auth.user?.display_name,
					name_color: sent.nameColor ?? auth.user?.name_color ?? null,
					avatar_url: sent.avatarUrl ?? auth.user?.avatar_url ?? null,
					reactions: [],
					attachments: sent.attachments ?? [],
					message_type: sent.messageType ?? sent.message_type,
					metadata: sent.metadata ?? null
				} as Message);
			}
		} catch (err) {
			console.error('Failed to send reply:', err);
			thread.markReplyFailed(optimisticId);
		}
	}

	function handleAnimatedClose() {
		const screenWidth = window.innerWidth;
		ui.setThreadDragAnimating(true);
		ui.setThreadDragOffset(screenWidth);
		setTimeout(() => {
			thread.close();
			ui.setThreadDragOffset(null);
			ui.setThreadDragAnimating(false);
		}, 200);
	}

	function startTitleEdit() {
		titleDraft = thread.parentMessage?.thread_title ?? '';
		titleError = '';
		editingTitle = true;
		requestAnimationFrame(() => {
			titleInput?.focus();
			titleInput?.select();
		});
	}

	function cancelTitleEdit() {
		editingTitle = false;
		titleDraft = '';
		titleError = '';
	}

	async function saveTitle() {
		const parent = thread.parentMessage;
		const title = titleDraft.trim();
		if (!parent || titleSaving) return;
		if (!title) {
			titleError = 'Title is required';
			return;
		}

		titleSaving = true;
		titleError = '';
		try {
			const result = await api.messages.setThreadTitle(parent.id, title);
			const updates = {
				thread_title: result.thread_title,
				thread_title_updated_at: result.thread_title_updated_at
			};
			thread.updateReply(result.thread_id, updates);
			messagesState.updateMessage(result.thread_id, updates);
			editingTitle = false;
			titleDraft = '';
		} catch (err) {
			titleError = err instanceof Error ? err.message : 'Failed to update thread title';
		} finally {
			titleSaving = false;
		}
	}

	function handleStartEdit(message: Message) {
		editingMessage = { id: message.id, content: message.content || '' };
	}

	async function handleEditSubmit(messageId: string, content: string) {
		editingMessage = null;
		try {
			await messagesState.edit(messageId, content);
			thread.updateReply(messageId, { content, edited_at: Date.now() / 1000 });
		} catch (err) {
			console.error('Failed to edit reply:', err);
		}
	}

	function handleEditCancel() {
		editingMessage = null;
	}

	async function handleDelete(messageId: string) {
		try {
			await messagesState.remove(messageId);
			thread.removeReply(messageId);
		} catch (err) {
			console.error('Failed to delete reply:', err);
		}
	}

	// Highlight a specific reply (scroll into view + pulse animation)
	$effect(() => {
		if (thread.highlightReplyId && !thread.loading) {
			const targetId = thread.highlightReplyId;
			// Retry finding the element - DOM may not be ready immediately
			let attempts = 0;
			const tryHighlight = () => {
				const el = document.getElementById(`thread-msg-${targetId}`);
				if (el) {
					el.scrollIntoView({ behavior: 'smooth', block: 'center' });
					el.classList.add('message-highlight');
					setTimeout(() => {
						el.classList.remove('message-highlight');
						thread.highlightReplyId = null;
					}, 1500);
				} else if (attempts < 10) {
					attempts++;
					setTimeout(tryHighlight, 100);
				}
			};
			setTimeout(tryHighlight, 100);
		}
	});
</script>

<aside
	class="thread-panel relative
		{panelOpen ? 'thread-panel-open' : ''}
		{ui.isDraggingThread ? 'thread-panel-dragging' : ''}
		{ui.threadDragAnimating ? 'thread-panel-animating' : ''}
		{isResizingThreadPanel ? 'thread-panel-resizing' : ''}"
	style={`--thread-panel-width: ${threadPanelWidth}px; ${ui.isMobile && (ui.isDraggingThread || ui.threadDragAnimating)
		? `transform: translateX(${ui.threadDragOffset ?? 0}px);`
		: ''}`}
	ondragenter={(e: DragEvent) => { e.preventDefault(); threadDragCounter++; threadDragOver = true; }}
	ondragover={(e: DragEvent) => { e.preventDefault(); }}
	ondragleave={() => { threadDragCounter--; if (threadDragCounter <= 0) { threadDragOver = false; threadDragCounter = 0; } }}
	ondrop={(e: DragEvent) => {
		e.preventDefault();
		threadDragOver = false;
		threadDragCounter = 0;
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) {
			threadDroppedFiles = Array.from(files);
		}
	}}
>
	<div
		class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] relative z-10"
	>
		<div class="flex items-center gap-2 min-w-0 flex-1">
			{#if ui.isMobile}
				<button
					onclick={handleAnimatedClose}
					class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 p-1"
					title="Back"
				>
					<CaretLeft size={20} />
				</button>
			{/if}
			{#if editingTitle}
				<form
					class="flex items-center gap-1.5 min-w-0 flex-1"
					onsubmit={(e: SubmitEvent) => { e.preventDefault(); saveTitle(); }}
				>
					<input
						bind:this={titleInput}
						bind:value={titleDraft}
						maxlength="120"
						disabled={titleSaving}
						aria-label="Thread title"
						class="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Escape') {
								e.preventDefault();
								cancelTitleEdit();
							}
						}}
					/>
					<button
						type="submit"
						disabled={titleSaving || !titleDraft.trim()}
						class="p-1 text-[var(--color-accent)] hover:text-[var(--color-text)] disabled:opacity-50"
						title="Save thread title"
					>
						<Check size={18} />
					</button>
					<button
						type="button"
						disabled={titleSaving}
						onclick={cancelTitleEdit}
						class="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
						title="Cancel title edit"
					>
						<X size={18} />
					</button>
				</form>
			{:else}
				<span class="font-semibold text-sm truncate">
					{thread.parentMessage?.thread_title || 'Thread'}
				</span>
				<button
					type="button"
					onclick={startTitleEdit}
					class="shrink-0 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
					title={thread.parentMessage?.thread_title ? 'Rename thread' : 'Set thread title'}
				>
					<PencilSimple size={15} />
				</button>
			{/if}
		</div>
		<button
			onclick={() => thread.close()}
			class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors {ui.isMobile ? 'hidden' : ''}"
			title="Close thread"
		>
			<X size={20} />
		</button>
	</div>
	{#if titleError}
		<div class="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-danger)]/10 px-4 py-1 text-xs text-[var(--color-danger)]" role="alert">
			{titleError}
		</div>
	{/if}

	{#if threadDragOver}
		<div class="absolute inset-0 z-40 bg-[var(--color-accent)]/10 border-2 border-dashed border-[var(--color-accent)] flex items-center justify-center pointer-events-none rounded-lg m-2">
			<div class="text-center">
				<CloudArrowUp size={48} class="mx-auto mb-2 text-[var(--color-accent)]" />
				<p class="text-lg font-semibold text-[var(--color-accent)]">Drop files to upload</p>
			</div>
		</div>
	{/if}
	<div class="relative flex-1 min-h-0 flex flex-col">
	<div bind:this={scrollContainer} onscroll={handleScroll} class="dark-scrollbar flex-1 min-h-0 overflow-y-auto" style="overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
		{#if thread.loading}
			<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
				Loading replies...
			</div>
		{:else if thread.replies.length === 0 && !thread.parentMessage}
			<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
				No replies yet
			</div>
		{:else}
			<div class="py-2">
				{#if thread.loadingMore}
					<div class="py-2 text-center text-xs text-[var(--color-text-muted)]">
						Loading older replies...
					</div>
				{:else if thread.loadError && thread.hasMore}
					<button
						onclick={handleRetryClick}
						class="w-full py-2 text-center text-xs text-[var(--color-accent)] hover:underline cursor-pointer"
					>
						Failed to load older replies. Tap to retry.
					</button>
				{/if}
				{#each threadItems as item (item.kind === 'steps' ? item.id : item.message.id)}
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
						{@const isParent = item.message.id === thread.parentMessage?.id}
						<div id="thread-msg-{item.message.id}" class={isParent ? 'border-b border-[var(--color-border)] py-2' : ''}>
							<MessageItem
								message={item.message}
								onedit={handleStartEdit}
								ondelete={handleDelete}
								{onprocesskill}
								{onprocessretry}
								hideProcessStatus={item.hasStepBlock}
								{knownUsernames}
								{knownChannelNames}
								{onchannelclick}
								{onmentionclick}
								onnavigatetomessage={(msgId, channelId) => {
									thread.close();
									onnavigatetomessage?.(msgId, channelId);
								}}
								ontimestampclick={() => {
									if (isParent && thread.parentMessage && onnavigatetomessage) {
										const msgId = thread.parentMessage.id;
										const channelId = thread.parentMessage.channel_id;
										thread.close();
										onnavigatetomessage(msgId, channelId);
									}
								}}
							/>
						</div>
					{/if}
				{/each}
				{#if thread.replies.length === 0 && thread.parentMessage}
					<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
						No replies yet
					</div>
				{/if}
				{#if thread.loadingNewer}
					<div class="py-2 text-center text-xs text-[var(--color-text-muted)]">
						Loading newer replies...
					</div>
				{/if}
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
			onclick={handleJumpToLatest}
			class="scroll-to-bottom"
			aria-label="Scroll to latest reply"
		>
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="6 8 10 12 14 8" />
			</svg>
		</button>
	{/if}
	</div>

	<MessageComposer
		onsend={handleSend}
		{ontypingstart}
		{ontypingstop}
		placeholder="Reply in thread..."
		focusTrigger={thread.parentMessage?.id}
		channels={channelsList}
		{members}
		externalFiles={threadDroppedFiles}
		onexternalfilesconsumed={() => { threadDroppedFiles = null; }}
		{editingMessage}
		oneditsubmit={handleEditSubmit}
		oneditcancel={handleEditCancel}
		channelId={thread.parentMessage?.id}
		loadDraft={async (threadId) => {
			try {
				const result = await api.channels.getDraft(threadId);
				return { content: result.content, attachments: result.attachments ?? [] };
			} catch {
				return { content: '', attachments: [] };
			}
		}}
		saveDraft={(threadId, content, attachmentIds) => {
			api.channels.saveDraft(threadId, content, attachmentIds.length > 0 ? attachmentIds : undefined).catch(() => {});
		}}
	/>

	<button
		type="button"
		class="thread-panel-resizer"
		aria-label="Resize thread panel"
		onpointerdown={handleThreadPanelResizePointerDown}
		onkeydown={handleThreadPanelResizeKeydown}
	></button>
</aside>

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

	.thread-panel {
		width: 100%;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		flex: 1;
	}

	.thread-panel-resizer {
		display: none;
	}

	@media (min-width: 768px) {
		.thread-panel {
			width: var(--thread-panel-width, 24rem);
			flex: none;
		}

		.thread-panel-resizer {
			display: block;
			appearance: none;
			border: 0;
			padding: 0;
			background: transparent;
			position: absolute;
			top: 0;
			left: -4px;
			bottom: 0;
			width: 8px;
			cursor: col-resize;
			touch-action: none;
			z-index: 20;
		}

		.thread-panel-resizer::after {
			content: '';
			position: absolute;
			top: 0;
			left: 3px;
			bottom: 0;
			width: 1px;
			background: transparent;
			transition: background-color 120ms ease;
		}

		.thread-panel-resizer:hover::after,
		.thread-panel-resizer:focus-visible::after,
		.thread-panel.thread-panel-resizing .thread-panel-resizer::after {
			background: var(--color-accent);
		}
	}

	@media (max-width: 767px) {
		.thread-panel {
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			height: 100%;
			z-index: 55;
			border-left: none;
			transform: translateX(100%);
			transition: transform 200ms ease-out;
			will-change: transform;
			/* Match app-shell safe-area padding so the header clears the iOS status bar */
			padding-top: env(safe-area-inset-top, 0px);
		}
		.thread-panel.thread-panel-open {
			transform: translateX(0);
		}
		/* Disable transition during interactive drag so panel follows the finger */
		.thread-panel.thread-panel-dragging {
			transition: none !important;
		}
		/* Re-enable transition for snap-back or slide-out animation after release */
		.thread-panel.thread-panel-animating {
			transition: transform 200ms ease-out !important;
		}
	}
</style>
