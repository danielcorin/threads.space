<script lang="ts">
	import { auth } from '$lib/state/auth.svelte.js';
	import { api } from '$lib/api.js';
	import { renderMarkdown, extractMessageLinks } from '$lib/utils/markdown.js';
	import { formatTime } from '$lib/utils/time.js';
	import { formatFileSize, groupReactions } from '$lib/utils/messageDisplay.js';
	import { messages, type Message as MessageType } from '$lib/state/messages.svelte.js';
	import { thread } from '$lib/state/thread.svelte.js';
	import { messageActions } from '$lib/state/message-actions.svelte.js';
	import EmojiPicker from './EmojiPicker.svelte';
	import ImageLightbox from './ImageLightbox.svelte';
	import FileViewer from './FileViewer.svelte';
	import type { Message } from '$lib/state/messages.svelte.js';
	import FileIcon from 'phosphor-svelte/lib/File';
	import DownloadSimple from 'phosphor-svelte/lib/DownloadSimple';
	import Clock from 'phosphor-svelte/lib/Clock';
	import BrailleSpinner from './BrailleSpinner.svelte';
	import X from 'phosphor-svelte/lib/X';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import XCircle from 'phosphor-svelte/lib/XCircle';
	import StopCircle from 'phosphor-svelte/lib/StopCircle';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
	import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
	import Smiley from 'phosphor-svelte/lib/Smiley';
	import ArrowBendUpLeft from 'phosphor-svelte/lib/ArrowBendUpLeft';
	import Copy from 'phosphor-svelte/lib/Copy';
	import Link from 'phosphor-svelte/lib/Link';
	import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
	import Trash from 'phosphor-svelte/lib/Trash';
	import PushPin from 'phosphor-svelte/lib/PushPin';
	import { portal } from '$lib/utils/portal.js';

	interface Props {
		message: Message;
		onreply?: (message: Message) => void;
		ondelete?: (messageId: string) => void;
		onedit?: (message: Message) => void;
		onprocesskill?: (messageId: string, processId: string) => void;
		onprocessretry?: (messageId: string, processId: string) => void;
		// When this message anchors an AgentSteps block, the block's summary carries
		// the process indicator — so suppress this message's own status pill to
		// avoid showing the same state twice.
		hideProcessStatus?: boolean;
		knownUsernames?: Set<string>;
		knownChannelNames?: Set<string>;
		onchannelclick?: (channelName: string) => void;
		onmentionclick?: (username: string) => void;
		ontimestampclick?: () => void;
		onnavigatetomessage?: (messageId: string, channelId: string) => void;
		isPinned?: boolean;
		onpin?: (message: Message) => void;
		onunpin?: (message: Message) => void;
		onresolve?: (message: Message) => void;
		onunresolve?: (message: Message) => void;
	}

	let { message, onreply, ondelete, onedit, onprocesskill, onprocessretry, hideProcessStatus = false, knownUsernames, knownChannelNames, onchannelclick, onmentionclick, ontimestampclick, onnavigatetomessage, isPinned = false, onpin, onunpin, onresolve, onunresolve }: Props = $props();

	let showActions = $state(false);
	let showEmojiPicker = $state(false);
	let hoveredReactionEmoji = $state<string | null>(null);
	let reactionHoverTimer: ReturnType<typeof setTimeout> | null = null;
	let reactionPopoverEl = $state<HTMLDivElement | null>(null);
	let reactionPillEl: HTMLElement | null = null;
	let reactionPopoverPos = $state<{ left: number; top: number; flipDown: boolean; arrowLeft: number } | null>(null);

	function openReactionPopover(emoji: string, trigger?: HTMLElement) {
		if (reactionHoverTimer) clearTimeout(reactionHoverTimer);
		if (trigger) reactionPillEl = trigger;
		reactionHoverTimer = setTimeout(() => {
			hoveredReactionEmoji = emoji;
		}, 120);
	}
	function closeReactionPopover() {
		if (reactionHoverTimer) clearTimeout(reactionHoverTimer);
		reactionHoverTimer = setTimeout(() => {
			hoveredReactionEmoji = null;
			reactionPopoverPos = null;
		}, 120);
	}

	// Measure the anchor pill + popover on hover and clamp to the viewport so
	// reactions near the left or right edge of the screen don't bleed offscreen.
	// `position: fixed` + computed left/top means the popover is independent of
	// the message list scroll container's clip rect.
	function positionReactionPopover() {
		if (!reactionPillEl || !reactionPopoverEl) return;
		const pillRect = reactionPillEl.getBoundingClientRect();
		const popoverWidth = reactionPopoverEl.offsetWidth;
		const popoverHeight = reactionPopoverEl.offsetHeight;
		const margin = 8;
		const viewportW = window.innerWidth;
		const pillCenter = pillRect.left + pillRect.width / 2;
		const idealLeft = pillCenter - popoverWidth / 2;
		const left = Math.max(margin, Math.min(idealLeft, viewportW - popoverWidth - margin));
		const arrowLeft = Math.max(10, Math.min(pillCenter - left, popoverWidth - 10));
		// Flip below the pill when there's not enough room above (typical for
		// the first message in the list). Gap of 6px either direction.
		const flipDown = pillRect.top < popoverHeight + 12;
		const top = flipDown ? pillRect.bottom + 6 : pillRect.top - popoverHeight - 6;
		reactionPopoverPos = { left, top, flipDown, arrowLeft };
	}

	$effect(() => {
		if (hoveredReactionEmoji && reactionPopoverEl) {
			positionReactionPopover();
			const onScrollOrResize = () => positionReactionPopover();
			window.addEventListener('scroll', onScrollOrResize, true);
			window.addEventListener('resize', onScrollOrResize);
			return () => {
				window.removeEventListener('scroll', onScrollOrResize, true);
				window.removeEventListener('resize', onScrollOrResize);
			};
		}
	});

	// Long-press detection for mobile action sheet
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let selectionClearTimer: ReturnType<typeof setInterval> | null = null;
	let longPressFired = false;

	// Dismiss open token popups when clicking outside
	$effect(() => {
		function handleDocumentClick(e: MouseEvent) {
			document.querySelectorAll('.token-popup:not(.hidden)').forEach((el) => {
				if (!el.closest('.token-popup-wrapper')?.contains(e.target as Node)) {
					el.classList.add('hidden');
				}
			});
		}
		document.addEventListener('click', handleDocumentClick);
		return () => document.removeEventListener('click', handleDocumentClick);
	});

	function onTouchStart(_e: TouchEvent) {
		longPressFired = false;
		// Clear any native text selection that iOS starts during the hold
		selectionClearTimer = setInterval(() => {
			window.getSelection()?.removeAllRanges();
		}, 50);
		longPressTimer = setTimeout(() => {
			longPressFired = true;
			openActionSheet();
		}, 500);
	}

	function clearTimers() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		if (selectionClearTimer) {
			clearInterval(selectionClearTimer);
			selectionClearTimer = null;
		}
	}

	function onTouchMove() {
		clearTimers();
	}

	function onTouchEnd(e: TouchEvent) {
		clearTimers();
		if (longPressFired) {
			e.preventDefault();
			longPressFired = false;
			// When the long-press target is inside a link, the browser will
			// synthesize a click event after touchend. Attach a one-shot capture
			// listener that swallows it so it doesn't reach the backdrop or
			// navigate away.
			const capture = (ce: Event) => {
				ce.preventDefault();
				ce.stopImmediatePropagation();
			};
			document.addEventListener('click', capture, { capture: true, once: true });
			// Safety: remove the listener if no click fires (e.g. touch was on
			// a non-interactive element).
			setTimeout(() => document.removeEventListener('click', capture, { capture: true }), 800);
		}
	}

	function openActionSheet() {
		if (message.client_delivery_status) return;
		messageActions.open(
			message,
			auth.user?.id === message.user_id,
			!!onreply,
			{
				onreaction: (emoji: string) => handleReaction(emoji),
				onedit: () => onedit?.(message),
				onreply: () => onreply?.(message),
				ondelete: () => ondelete?.(message.id),
				onpin: onpin ? () => onpin?.(message) : undefined,
				onunpin: onunpin ? () => onunpin?.(message) : undefined,
				onresolve: canResolve && onresolve ? () => onresolve?.(message) : undefined,
				onunresolve: canResolve && onunresolve ? () => onunresolve?.(message) : undefined,
			},
			isPinned,
			isResolved
		);
	}

	let lightboxImage = $state<{ src: string; alt: string; filename: string; sizeBytes: number } | null>(null);
	let fileViewer = $state<{ url: string; contentType: string; filename: string; sizeBytes: number } | null>(null);

	// On mobile Safari/Chrome (especially iOS installed PWAs) the FileViewer's
	// fetch-based sub-viewers (text/markdown/json/csv) can hang because credentialed
	// cross-origin fetches to the API are unreliable. Fall back to
	// opening the file in a new tab on mobile only. Desktop installed PWAs should
	// still use FileViewer.
	function shouldUseAttachmentLinkFallback(): boolean {
		if (typeof navigator === 'undefined') return false;
		const ua = navigator.userAgent;
		const isTouchMac = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
		return /iPhone|iPad|iPod|Android/i.test(ua) || isTouchMac;
	}
	const useAttachmentLinkFallback = shouldUseAttachmentLinkFallback();

	let isOwnMessage = $derived(auth.user?.id === message.user_id);
	let isDeleted = $derived(message.deleted_at !== null);
	let isSending = $derived(message.client_delivery_status === 'sending');
	let sendFailed = $derived(message.client_delivery_status === 'failed');
	let isResolved = $derived(!!message.resolved_at);
	let isCollapsedResolvedThread = $derived(
		isResolved && !message.thread_id && !!message.thread_title?.trim() && !!onreply
	);
	// Resolve is a thread-level action: only offer it on top-level messages, and
	// only when the parent wired the handlers (channel list — not thread panel/search).
	let canResolve = $derived(!message.thread_id && (!!onresolve || !!onunresolve));
	let linkPreview = $derived(message.linkPreviews?.[0] ?? null);
	// Message link unfurling
	let unfurledMessages = $state<Map<string, MessageType>>(new Map());
	let unfurlLoading = $state<Set<string>>(new Set());
	const unfurlCache = new Map<string, MessageType | null>();

	$effect(() => {
		if (!message.content || isDeleted) return;
		const linkedIds = extractMessageLinks(message.content)
			.filter((id) => id !== message.id) // don't unfurl self
			.slice(0, 3); // max 3 unfurls
		if (linkedIds.length === 0) return;

		for (const id of linkedIds) {
			if (unfurledMessages.has(id) || unfurlLoading.has(id)) continue;
			if (unfurlCache.has(id)) {
				const cached = unfurlCache.get(id);
				if (cached) unfurledMessages = new Map([...unfurledMessages, [id, cached]]);
				continue;
			}
			unfurlLoading = new Set([...unfurlLoading, id]);
			api.messages.get(id).then((res) => {
				const msg = res as unknown as MessageType;
				if (msg && !msg.deleted_at) {
					unfurlCache.set(id, msg);
					unfurledMessages = new Map([...unfurledMessages, [id, msg]]);
				} else {
					unfurlCache.set(id, null);
				}
			}).catch(() => {
				unfurlCache.set(id, null);
			}).finally(() => {
				const next = new Set(unfurlLoading);
				next.delete(id);
				unfurlLoading = next;
			});
		}
	});

	function resolveUploadUrl(url: string): string {
		// In dev, uploads come from the API server; in prod, relative paths work
		const apiBase = import.meta.env.VITE_API_URL || '/api';
		return url.startsWith('/uploads/') ? `${apiBase}${url}` : url;
	}

	async function downloadAttachment(e: MouseEvent, url: string, filename: string) {
		e.preventDefault();
		e.stopPropagation();
		try {
			const res = await fetch(url, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const blobUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = blobUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
		} catch (err) {
			console.error('[MessageItem] download failed', err);
		}
	}

	async function handleReaction(emoji: string) {
		const user = auth.user;
		if (!user) return;
		const existing = message.reactions?.find(
			(r) => r.emoji === emoji && r.userId === user.id
		);
		// Optimistic toggle: reflect immediately, revert on failure. The WS echo
		// is deduplicated by the stores' add/remove logic.
		if (existing) {
			messages.removeReaction(message.id, emoji, user.id);
			thread.removeReaction(message.id, emoji, user.id);
		} else {
			messages.addReaction(message.id, emoji, user.id, user.username);
			thread.addReaction(message.id, emoji, user.id, user.username);
		}
		try {
			if (existing) {
				await api.reactions.remove(message.id, emoji);
			} else {
				await api.reactions.add(message.id, emoji);
			}
		} catch (err) {
			console.error('[handleReaction] failed:', err);
			// Revert the optimistic change
			if (existing) {
				messages.addReaction(message.id, emoji, user.id, user.username);
				thread.addReaction(message.id, emoji, user.id, user.username);
			} else {
				messages.removeReaction(message.id, emoji, user.id);
				thread.removeReaction(message.id, emoji, user.id);
			}
		}
	}

	// Group reactions by emoji
	let groupedReactions = $derived(groupReactions(message.reactions));
</script>

{#if message.type === 'system'}
	<div class="px-4 py-1">
		<p class="text-xs text-[var(--color-text-muted)] italic text-center">{message.content}</p>
	</div>
{:else}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="group relative px-4 py-1.5 hover:bg-[var(--color-bg-hover)]/50 transition-[background-color,opacity] select-none md:select-auto"
			class:opacity-60={isResolved && !showActions}
		style:z-index={showActions ? 10 : undefined}
		style:-webkit-touch-callout="none"
		role="button"
		tabindex="-1"
		onmouseenter={() => {
			if (!message.client_delivery_status) showActions = true;
		}}
		onmouseleave={() => {
			if (!showEmojiPicker) {
				showActions = false;
			}
		}}
		onclick={(e: MouseEvent) => {
			const target = e.target as HTMLElement;
			// Navigate to channel when clicking a #channel-ref
			const channelRef = target.closest('.channel-ref') as HTMLElement | null;
			if (channelRef && onchannelclick) {
				e.stopPropagation();
				const name = channelRef.textContent?.replace(/^#/, '') ?? '';
				if (name) onchannelclick(name);
				return;
			}
			// Open DM when clicking a @mention
			const mentionEl = target.closest('.mention') as HTMLElement | null;
			if (mentionEl && onmentionclick) {
				e.stopPropagation();
				const username = mentionEl.getAttribute('data-mention-username');
				if (username) onmentionclick(username);
				return;
			}
			if (!target.isConnected || target.closest('.message-actions') || target.closest('.mobile-bar') || target.closest('.mobile-emoji') || target.closest('.desktop-emoji') || target.closest('.emoji-portal') || target.closest('.reply-count')) return;
			if (!message.client_delivery_status) showActions = !showActions;
		}}
		onkeydown={() => {}}
		ontouchstart={onTouchStart}
		ontouchmove={onTouchMove}
		ontouchend={onTouchEnd}
	>
		{#if isDeleted}
			<div>
				<div class="text-sm text-[var(--color-text-muted)] italic">[deleted]</div>
			</div>
		{:else}
			{#if isCollapsedResolvedThread}
				<button
					type="button"
					class="resolved-thread-title flex w-full min-w-0 items-center gap-2 py-1 pr-12 text-left text-sm font-medium text-[var(--color-text)] hover:text-[var(--color-link)]"
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						onreply?.(message);
					}}
					title="Open resolved thread"
				>
					<CheckCircle size={16} weight="fill" class="shrink-0 text-[var(--color-text-muted)]" />
					<span class="truncate">{message.thread_title}</span>
				</button>
			{:else}
			<div>
				<div class="min-w-0">
					<div class="flex items-baseline gap-2">
						{#if !isOwnMessage && onmentionclick && message.username}
							<button
								onclick={(e: MouseEvent) => { e.stopPropagation(); onmentionclick?.(message.username!); }}
								class="font-semibold text-sm hover:underline cursor-pointer"
								style:color={message.name_color || undefined}
							>
								{message.display_name || message.username || 'Unknown'}
							</button>
						{:else}
							<span class="font-semibold text-sm" style:color={message.name_color || undefined}>
								{message.display_name || message.username || 'Unknown'}
							</span>
						{/if}
						{#if ontimestampclick}
							<button
								onclick={(e: MouseEvent) => { e.stopPropagation(); ontimestampclick?.(); }}
								class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-link)] hover:underline transition-colors cursor-pointer"
								title="Jump to message in channel"
							>
								{formatTime(message.created_at)}
							</button>
						{:else}
							<span class="text-xs text-[var(--color-text-muted)]">
								{formatTime(message.created_at)}
							</span>
						{/if}
						{#if message.edited_at}
							<span class="text-xs text-[var(--color-text-muted)]">(edited)</span>
						{/if}
						{#if isSending}
							<span class="text-xs text-[var(--color-text-muted)]" aria-live="polite">Sending…</span>
						{:else if sendFailed}
							<span class="text-xs text-[var(--color-danger,#ef4444)]" role="alert">Failed to send</span>
						{/if}
						{#if message.metadata?.response_model}
							<span class="text-xs text-[var(--color-text-muted)] opacity-70" title="Model used for this response">
								{message.metadata.response_model}
							</span>
						{/if}
						{#if isPinned}
							<span class="text-xs text-[var(--color-accent)] flex items-center" title="Pinned"><PushPin size={12} weight="fill" /></span>
						{/if}
						{#if isResolved}
							<span class="text-xs text-[var(--color-text-muted)] flex items-center gap-0.5" title={message.resolved_by === auth.user?.id ? 'You marked this resolved' : 'Resolved'}><CheckCircle size={12} weight="fill" /><span>Resolved</span></span>
						{/if}
					</div>

					{#if message.content}
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div class="leading-relaxed break-words message-content" style="font-size: 16px;" onclick={(e: MouseEvent) => {
							const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null;
							if (!btn) return;
							e.stopPropagation();
							const wrapper = btn.closest('.code-block-wrapper');
							const code = wrapper?.querySelector('code');
							if (code) {
								navigator.clipboard.writeText(code.textContent || '');
								const original = btn.innerHTML;
								btn.classList.add('copied');
								btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
								setTimeout(() => {
									btn.classList.remove('copied');
									btn.innerHTML = original;
								}, 1500);
							}
						}}>
							<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html renderMarkdown(message.content, knownUsernames, knownChannelNames)}
						</div>
					{/if}
					{#if unfurledMessages.size > 0 || unfurlLoading.size > 0}
						<div class="mt-2 flex flex-col gap-1.5">
							{#each [...unfurlLoading] as id (id)}
								{#if !unfurledMessages.has(id)}
									<div class="border-l-2 border-[var(--color-accent)] pl-3 py-1 text-xs text-[var(--color-text-muted)]">
										Loading...
									</div>
								{/if}
							{/each}
							{#each [...unfurledMessages.values()] as unfurled (unfurled.id)}
								<div
									class="unfurl-embed border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] rounded-r-lg pl-3 pr-3 py-2 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
									onclick={(e: MouseEvent) => {
										e.stopPropagation();
										if (onnavigatetomessage) {
											onnavigatetomessage(unfurled.id, unfurled.channel_id);
										} else {
											window.location.search = `?channel=${unfurled.channel_id}&msg=${unfurled.id}`;
										}
									}}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key !== 'Enter' && e.key !== ' ') return;
										e.stopPropagation();
										if (onnavigatetomessage) {
											onnavigatetomessage(unfurled.id, unfurled.channel_id);
										} else {
											window.location.search = `?channel=${unfurled.channel_id}&msg=${unfurled.id}`;
										}
									}}
									role="button"
									tabindex="0"
								>
									<div class="flex items-baseline gap-2">
										<span class="font-semibold text-xs" style:color={unfurled.name_color || undefined}>
											{unfurled.display_name || unfurled.username || 'Unknown'}
										</span>
										<span class="text-xs text-[var(--color-text-muted)]">
											{formatTime(unfurled.created_at)}
										</span>
									</div>
									{#if unfurled.content}
										<div class="text-sm text-[var(--color-text)] mt-0.5 line-clamp-2 leading-snug">
											{unfurled.content}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if message.attachments && message.attachments.length > 0}
						<div class="mt-1 flex flex-wrap gap-2">
							{#each message.attachments as att (att.id)}
								{#if att.contentType.startsWith('image/')}
									<div
										class="relative group block cursor-pointer"
										onclick={(e: MouseEvent) => { e.stopPropagation(); lightboxImage = { src: resolveUploadUrl(att.url), alt: att.filename, filename: att.filename, sizeBytes: att.sizeBytes }; }}
										onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); lightboxImage = { src: resolveUploadUrl(att.url), alt: att.filename, filename: att.filename, sizeBytes: att.sizeBytes }; } }}
										role="button"
										tabindex="0"
									>
										<img
											src={resolveUploadUrl(att.url)}
											alt={att.filename}
											crossorigin="use-credentials"
											class="max-w-xs max-h-60 rounded-lg border border-[var(--color-border)] object-cover cursor-pointer hover:opacity-90 transition-opacity"
											loading="lazy"
										/>
										<button
											type="button"
											onclick={(e: MouseEvent) => downloadAttachment(e, resolveUploadUrl(att.url), att.filename)}
											class="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-black/80 transition-opacity"
											title="Download"
											aria-label="Download image"
										>
											<DownloadSimple size={16} />
										</button>
									</div>
								{:else if att.contentType.startsWith('video/')}
									<div class="relative group inline-block">
										<!-- svelte-ignore a11y_media_has_caption -->
										<video
											src={resolveUploadUrl(att.url)}
											crossorigin="use-credentials"
											controls
											class="max-w-xs max-h-60 rounded-lg border border-[var(--color-border)]"
										></video>
										<button
											type="button"
											onclick={(e: MouseEvent) => downloadAttachment(e, resolveUploadUrl(att.url), att.filename)}
											class="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-black/80 transition-opacity"
											title="Download"
											aria-label="Download video"
										>
											<DownloadSimple size={16} />
										</button>
									</div>
								{:else if useAttachmentLinkFallback}
									<!--
										Mobile/PWA fallback: plain anchor opens in a new tab via WebKit's
										navigation path, which sends cookies even for installed PWAs, unlike
										fetch() which is blocked by iOS partitioned cookies for cross-origin
										credentialed requests.
									-->
									<div class="inline-flex items-center gap-1">
										<a
											href={resolveUploadUrl(att.url)}
											target="_blank"
											rel="noopener noreferrer"
											download={att.filename}
											data-testid="attachment-link"
											class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] transition-colors text-sm no-underline"
										>
											<span class="text-[var(--color-text-muted)] shrink-0"><FileIcon size={16} /></span>
											<span class="truncate max-w-[200px]">{att.filename}</span>
											<span class="text-xs text-[var(--color-text-muted)] shrink-0">{formatFileSize(att.sizeBytes)}</span>
										</a>
										<button
											type="button"
											onclick={(e: MouseEvent) => downloadAttachment(e, resolveUploadUrl(att.url), att.filename)}
											class="p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
											title="Download {att.filename}"
											aria-label="Download {att.filename}"
										>
											<DownloadSimple size={16} />
										</button>
									</div>
								{:else}
									<div class="inline-flex items-center gap-1">
										<button
											type="button"
											onclick={(e: MouseEvent) => { e.stopPropagation(); fileViewer = { url: resolveUploadUrl(att.url), contentType: att.contentType, filename: att.filename, sizeBytes: att.sizeBytes }; }}
											class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] transition-colors text-sm text-left"
											title="Preview {att.filename}"
										>
											<span class="text-[var(--color-text-muted)] shrink-0"><FileIcon size={16} /></span>
											<span class="truncate max-w-[200px]">{att.filename}</span>
											<span class="text-xs text-[var(--color-text-muted)] shrink-0">{formatFileSize(att.sizeBytes)}</span>
										</button>
										<button
											type="button"
											onclick={(e: MouseEvent) => downloadAttachment(e, resolveUploadUrl(att.url), att.filename)}
											class="p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
											title="Download {att.filename}"
											aria-label="Download {att.filename}"
										>
											<DownloadSimple size={16} />
										</button>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
					{#if linkPreview}
						<a
							href={linkPreview.url}
							target="_blank"
							rel="noopener noreferrer"
							class="mt-2 block max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden hover:border-[var(--color-accent)]/50 transition-colors no-underline"
						>
							<div class="flex">
								<div class="flex-1 p-3 min-w-0">
									{#if linkPreview.siteName}
										<div class="text-xs text-[var(--color-text-muted)] mb-0.5">{linkPreview.siteName}</div>
									{/if}
									{#if linkPreview.title}
										<div class="text-sm font-semibold text-[var(--color-link)] leading-tight">{linkPreview.title}</div>
									{/if}
									{#if linkPreview.description}
										<div class="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-2 leading-relaxed">{linkPreview.description}</div>
									{/if}
								</div>
								{#if linkPreview.imageUrl}
									<div class="w-20 h-20 shrink-0">
										<img
											src={linkPreview.imageUrl}
											alt=""
											class="w-full h-full object-cover"
											loading="lazy"
										/>
									</div>
								{/if}
							</div>
						</a>
					{/if}

					{#if message.metadata?.memory_searches && message.metadata.memory_searches.length > 0}
						<details class="mt-1.5 text-xs">
							<summary class="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors select-none">
								{message.metadata.memory_searches.length} memory {message.metadata.memory_searches.length === 1 ? 'search' : 'searches'}
							</summary>
							<div class="mt-1 pl-3 border-l-2 border-[var(--color-border)] space-y-1">
								{#each message.metadata.memory_searches as search, i (i)}
									<div class="text-[var(--color-text-muted)]">
										<span class="font-medium text-[var(--color-text)]">{search.query}</span>
										{#if typeof search.count === 'number'}
											<span class="ml-1 opacity-60">({search.count} {search.count === 1 ? 'result' : 'results'})</span>
										{/if}
									</div>
								{/each}
							</div>
						</details>
					{/if}

					{#if message.metadata?.memories && message.metadata.memories.length > 0}
						<details class="mt-1.5 text-xs">
							<summary class="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors select-none">
								{message.metadata.memories.length} {message.metadata.memories.length === 1 ? 'memory' : 'memories'} loaded
							</summary>
							<div class="mt-1 pl-3 border-l-2 border-[var(--color-border)] space-y-1.5">
								{#each message.metadata.memories as memory, i (i)}
									<div class="text-[var(--color-text-muted)]">
										<span class="font-medium text-[var(--color-text)]">{memory.label}</span>
										{#if memory.relevance}
											<span class="ml-1 opacity-60">{memory.relevance}</span>
										{/if}
										<div class="mt-0.5 whitespace-pre-wrap opacity-75">{memory.content}</div>
									</div>
								{/each}
							</div>
						</details>
					{/if}

					{#if groupedReactions.length > 0}
						<div class="flex flex-wrap gap-1 mt-1">
							{#each groupedReactions as reaction (reaction.emoji)}
								<span
									class="relative inline-block"
									onmouseenter={(e) => openReactionPopover(reaction.emoji, e.currentTarget as HTMLElement)}
									onmouseleave={closeReactionPopover}
									role="presentation"
								>
									<button
										onclick={() => handleReaction(reaction.emoji)}
										class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors {reaction.userIds.includes(
											auth.user?.id ?? ''
										)
											? 'border-[var(--color-accent)]/50 bg-[var(--color-accent)]/10'
											: 'border-[var(--color-border)] hover:border-[var(--color-accent)]/30'}"
										aria-label="{reaction.emoji} reaction from {reaction.users.join(', ')}"
									>
										<span>{reaction.emoji}</span>
										<span class="text-[var(--color-text-muted)]">{reaction.users.length}</span>
									</button>
									{#if hoveredReactionEmoji === reaction.emoji}
										<div
											bind:this={reactionPopoverEl}
											use:portal
											class="reaction-popover fixed z-[80] min-w-max max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated,var(--color-bg))] shadow-lg py-1.5 px-2.5 pointer-events-auto"
											style="left: {reactionPopoverPos?.left ?? -9999}px; top: {reactionPopoverPos?.top ?? -9999}px; visibility: {reactionPopoverPos ? 'visible' : 'hidden'};"
											onmouseenter={() => openReactionPopover(reaction.emoji)}
											onmouseleave={closeReactionPopover}
											role="tooltip"
										>
											<div class="flex items-center gap-1.5 mb-1">
												<span class="text-base leading-none">{reaction.emoji}</span>
												<span class="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
													{reaction.users.length === 1 ? '1 person' : `${reaction.users.length} people`}
												</span>
											</div>
											<ul class="flex flex-col gap-0.5 text-xs text-[var(--color-text)]">
												{#each reaction.users as username, i (username)}
													<li class="whitespace-nowrap">
														{#if reaction.userIds[i] === auth.user?.id}
															<span class="text-[var(--color-accent)]">{username}</span>
															<span class="text-[var(--color-text-muted)]">(you)</span>
														{:else}
															{username}
														{/if}
													</li>
												{/each}
											</ul>
											<div
												class="reaction-popover-arrow absolute w-0 h-0 {reactionPopoverPos?.flipDown ? 'reaction-popover-arrow--up bottom-full' : 'top-full'}"
												style="left: {reactionPopoverPos?.arrowLeft ?? 0}px; transform: translateX(-50%);"
												aria-hidden="true"
											></div>
										</div>
									{/if}
								</span>
							{/each}
						</div>
					{/if}

					{#if onreply && message.reply_count && message.reply_count > 0}
						<div class="mt-1 flex items-center gap-1.5">
							<button
								onclick={(e: MouseEvent) => { e.stopPropagation(); onreply?.(message); }}
								class="reply-count inline-flex items-center gap-1 text-xs text-[var(--color-link)] hover:underline"
							>
								<ArrowBendUpLeft size={12} />
								{message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
							</button>
							{#if message.thread_process_status === 'processing' || message.thread_process_status === 'queued'}
								<span class="inline-flex items-center gap-1 text-xs text-[var(--color-accent)]">
									<span class="text-[var(--color-text-muted)]">·</span>
									{#if message.thread_process_status === 'processing'}
										<BrailleSpinner class="text-xs" />
										<span>Processing</span>
									{:else}
										<Clock size={12} />
										<span>Queued</span>
									{/if}
								</span>
							{/if}
						</div>
					{:else if message.thread_process_status === 'processing' || message.thread_process_status === 'queued'}
						<div class="mt-1 flex items-center gap-1.5">
							<span class="inline-flex items-center gap-1 text-xs text-[var(--color-accent)]">
								{#if message.thread_process_status === 'processing'}
									<BrailleSpinner class="text-xs" />
									<span>Processing in thread</span>
								{:else}
									<Clock size={12} />
									<span>Queued in thread</span>
								{/if}
							</span>
						</div>
					{/if}

					{#if message.process_status && !hideProcessStatus}
						<div class="mt-1.5 flex items-center gap-1.5">
							{#if message.process_status === 'queued'}
								<div class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border border-[var(--color-text-muted)]/20">
									<Clock size={12} />
									<span>Queued</span>
									<button
										onclick={(e: MouseEvent) => { e.stopPropagation(); message.process_id && onprocesskill?.(message.id, message.process_id); }}
										class="ml-0.5 hover:text-[var(--color-danger)] transition-colors"
										title="Cancel queued process"
									><X size={12} weight="bold" /></button>
								</div>
							{:else if message.process_status === 'processing'}
								<div class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20">
									<BrailleSpinner class="text-xs" />
									<span>Processing</span>
									<button
										onclick={(e: MouseEvent) => { e.stopPropagation(); message.process_id && onprocesskill?.(message.id, message.process_id); }}
										class="ml-0.5 hover:text-[var(--color-danger)] transition-colors"
										title="Stop process"
									><X size={12} weight="bold" /></button>
								</div>
							{:else if message.process_status === 'done'}
								<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[var(--color-text-muted)]">
									<CheckCircle size={12} />
									<span>Done</span>
									{#if (message.process_input_tokens ?? 0) > 0 || (message.process_output_tokens ?? 0) > 0 || (message.process_cache_creation_input_tokens ?? 0) > 0 || (message.process_cache_read_input_tokens ?? 0) > 0}
										{@const uncachedIn = message.process_input_tokens ?? 0}
										{@const cachedIn = message.process_cache_read_input_tokens ?? 0}
										{@const newCache = message.process_cache_creation_input_tokens ?? 0}
										{@const outTokens = message.process_output_tokens ?? 0}
										{@const totalTokens = uncachedIn + cachedIn + newCache + outTokens}
										{@const estimatedCost = (uncachedIn * 15 + cachedIn * 1.5 + newCache * 18.75 + outTokens * 75) / 1_000_000}
										<span class="relative token-popup-wrapper"
											onmouseenter={(e) => { if (window.matchMedia('(pointer: fine)').matches) (e.currentTarget as HTMLElement).querySelector('.token-popup')?.classList.remove('hidden') }}
											onmouseleave={(e) => { if (window.matchMedia('(pointer: fine)').matches) (e.currentTarget as HTMLElement).querySelector('.token-popup')?.classList.add('hidden') }}
										>
											<button
												class="cursor-pointer"
												onclick={(e) => { e.stopPropagation(); const popup = (e.currentTarget as HTMLElement).parentElement?.querySelector('.token-popup'); popup?.classList.toggle('hidden'); }}
											>&middot; {totalTokens.toLocaleString()} tokens</button>
											<div class="token-popup hidden absolute bottom-full left-0 mb-1 px-2 py-1.5 rounded bg-[var(--color-bg-surface)] border border-[var(--color-border)] shadow-sm whitespace-nowrap text-[var(--color-text-muted)] z-50 text-xs space-y-0.5">
												<div>{uncachedIn.toLocaleString()} uncached in</div>
												<div>{cachedIn.toLocaleString()} cached in</div>
												<div>{newCache.toLocaleString()} new cache</div>
												<div>{outTokens.toLocaleString()} out</div>
												<div class="border-t border-[var(--color-border)] pt-0.5 mt-0.5">${estimatedCost < 0.01 ? estimatedCost.toFixed(4) : estimatedCost.toFixed(2)}</div>
											</div>
										</span>
									{/if}
								</div>
							{:else if message.process_status === 'error'}
								<div class="relative error-popup-wrapper inline-flex items-center">
									{#if message.process_error_text}
										<button
											type="button"
											class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/8 border border-[var(--color-danger)]/30 hover:bg-[var(--color-danger)]/14 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-danger)]/35"
											title="View error details"
											aria-label="View error details"
											onclick={(e) => {
												e.stopPropagation();
												const popup = (e.currentTarget as HTMLElement).parentElement?.querySelector('.error-popup');
												popup?.classList.toggle('hidden');
											}}
										>
											<XCircle size={12} />
											<span>Error</span>
											<CaretDown size={10} weight="bold" />
										</button>
										<div class="error-popup hidden absolute bottom-full left-0 mb-1 px-3 py-2 rounded bg-[var(--color-bg-surface)] border border-[var(--color-danger)]/40 shadow-md text-[var(--color-text)] z-50 text-xs max-w-[480px] w-max">
											<div class="font-semibold text-[var(--color-danger)] mb-1 flex items-center justify-between gap-3">
												<span>Error details</span>
												<div class="flex items-center gap-1">
													{#if message.process_id}
														<button
															type="button"
															class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
															title="Retry processing"
															onclick={(e) => {
																e.stopPropagation();
																(e.currentTarget as HTMLElement).closest('.error-popup')?.classList.add('hidden');
																message.process_id && onprocessretry?.(message.id, message.process_id);
															}}
														><ArrowClockwise size={11} weight="bold" /><span class="text-[10px] font-medium">Retry</span></button>
													{/if}
													<button
														type="button"
														class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
														title="Close"
														onclick={(e) => {
															e.stopPropagation();
															(e.currentTarget as HTMLElement).closest('.error-popup')?.classList.add('hidden');
														}}
													><X size={12} weight="bold" /></button>
												</div>
											</div>
											<pre class="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug max-h-64 overflow-y-auto">{message.process_error_text}</pre>
										</div>
									{:else if message.process_id}
										<div class="inline-flex items-center gap-1">
											<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[var(--color-danger)]" title="No error details captured">
												<XCircle size={12} />
												<span>Error</span>
											</div>
											<button
												type="button"
												class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
												title="Retry processing"
												onclick={(e) => {
													e.stopPropagation();
													message.process_id && onprocessretry?.(message.id, message.process_id);
												}}
											><ArrowClockwise size={11} weight="bold" /><span>Retry</span></button>
										</div>
									{:else}
										<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[var(--color-danger)]" title="No error details captured">
											<XCircle size={12} />
											<span>Error</span>
										</div>
									{/if}
								</div>
							{:else if message.process_status === 'killed'}
								<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[var(--color-text-muted)]">
									<StopCircle size={12} />
									<span>Stopped</span>
								</div>
							{:else if message.process_status === 'restarted'}
								<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-yellow-500" title="Process ended because the bot restarted">
									<StopCircle size={12} />
									<span>Restarted</span>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>
			{/if}

			<!-- Desktop-only action overlay (hidden on mobile, use long-press instead) -->
			{#if showActions && !message.client_delivery_status}
				<div
					class="message-actions absolute top-1 right-4 hidden md:flex items-center bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-sm"
				>
					{#each emojiPicker.quickEmojis as emoji (emoji)}
						<button
							onclick={(e: MouseEvent) => {
								e.stopPropagation();
								handleReaction(emoji);
							}}
							class="px-1.5 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="React with {emoji}"
						>
							{emoji}
						</button>
					{/each}
					<div class="relative">
						<button
							onclick={(e: MouseEvent) => {
								e.stopPropagation();
								showEmojiPicker = !showEmojiPicker;
							}}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="Add reaction"
						>
							<Smiley size={16} />
						</button>
						{#if showEmojiPicker}
							<EmojiPicker
								onselect={handleReaction}
								onclose={() => (showEmojiPicker = false)}
							/>
						{/if}
					</div>
					{#if onreply}
						<button
							onclick={() => onreply?.(message)}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="Reply in thread"
						>
							<ArrowBendUpLeft size={16} />
						</button>
					{/if}
					<button
						type="button"
						onclick={(e: MouseEvent) => {
							e.stopPropagation();
							navigator.clipboard.writeText(message.content || '');
							showActions = false;
						}}
						class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
						title="Copy message"
					>
						<Copy size={16} />
					</button>
					<button
						onclick={(e: MouseEvent) => {
							e.stopPropagation();
							const url = `${window.location.origin}?channel=${message.channel_id}&msg=${message.id}`;
							navigator.clipboard.writeText(url);
							showActions = false;
						}}
						class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
						title="Copy link"
					>
						<Link size={16} />
					</button>
					{#if isPinned && onunpin}
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); onunpin?.(message); showActions = false; }}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors text-[var(--color-accent)]"
							title="Unpin"
						>
							<PushPin size={16} weight="fill" />
						</button>
					{:else if !isPinned && onpin}
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); onpin?.(message); showActions = false; }}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="Pin to channel"
						>
							<PushPin size={16} />
						</button>
					{/if}
					{#if canResolve && isResolved}
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); onunresolve?.(message); showActions = false; }}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors text-[var(--color-accent)]"
							title="Mark as not resolved"
						>
							<CheckCircle size={16} weight="fill" />
						</button>
					{:else if canResolve}
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); onresolve?.(message); showActions = false; }}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="Mark as resolved"
						>
							<CheckCircle size={16} />
						</button>
					{/if}
					{#if isOwnMessage}
						<button
							onclick={() => onedit?.(message)}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
							title="Edit"
						>
							<PencilSimple size={16} />
						</button>
						<button
							onclick={() => ondelete?.(message.id)}
							class="px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)] text-[var(--color-danger)] transition-colors rounded-r"
							title="Delete"
						>
							<Trash size={16} />
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
{/if}

{#if lightboxImage}
	<ImageLightbox
		src={lightboxImage.src}
		alt={lightboxImage.alt}
		filename={lightboxImage.filename}
		sizeBytes={lightboxImage.sizeBytes}
		onclose={() => { lightboxImage = null; }}
	/>
{/if}

{#if fileViewer}
	<FileViewer
		url={fileViewer.url}
		contentType={fileViewer.contentType}
		filename={fileViewer.filename}
		sizeBytes={fileViewer.sizeBytes}
		onclose={() => { fileViewer = null; }}
	/>
{/if}

<style>
	/* Prevent native iOS text selection callout on long press for mobile */
	@media (max-width: 767px) {
		div :global(*) {
			-webkit-touch-callout: none;
			-webkit-user-select: none;
			user-select: none;
		}
	}

	/* Reaction popover pointer arrow — drawn with CSS triangles so it inherits
	   the popover's border color in one line and doesn't need an extra SVG. */
	.reaction-popover-arrow {
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-top: 5px solid var(--color-border);
	}
	.reaction-popover-arrow::after {
		content: '';
		position: absolute;
		top: -6px;
		left: -4px;
		border-left: 4px solid transparent;
		border-right: 4px solid transparent;
		border-top: 4px solid var(--color-bg-elevated, var(--color-bg));
	}
	/* Flipped variant: popover sits below the pill and the arrow points up. */
	.reaction-popover-arrow--up {
		border-top: none;
		border-bottom: 5px solid var(--color-border);
	}
	.reaction-popover-arrow--up::after {
		top: auto;
		bottom: -6px;
		border-top: none;
		border-bottom: 4px solid var(--color-bg-elevated, var(--color-bg));
	}
</style>
