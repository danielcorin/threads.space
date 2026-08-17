<script lang="ts">
	import { onMount, tick } from 'svelte';
	import ChannelList from './ChannelList.svelte';
	import DMList from './DMList.svelte';
	import NewDMModal from './NewDMModal.svelte';
	import UserMenu from './UserMenu.svelte';
	import CreateChannelModal from './CreateChannelModal.svelte';
	import ChannelDirectory from './ChannelDirectory.svelte';
	import UserSettingsModal from './UserSettingsModal.svelte';
	import { ui } from '$lib/state/ui.svelte.js';
	import { modals } from '$lib/state/modals.svelte.js';
	import { processes } from '$lib/state/processes.svelte.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import { FEEDBACK_CHANNEL_ID } from '$lib/constants.js';
	import Cpu from 'phosphor-svelte/lib/Cpu';
	import ChatCircleText from 'phosphor-svelte/lib/ChatCircleText';
	import Tray from 'phosphor-svelte/lib/Tray';
	import type { SidebarRevealRequest } from '$lib/unreadNavigation.js';

	interface Props {
		revealRequest?: SidebarRevealRequest | null;
	}

	let { revealRequest = null }: Props = $props();
	let sidebarNav: HTMLElement;

	let unreadCount = $derived(
		channels.list.reduce((sum, channel) => sum + (channel.unread_count || 0), 0) +
		dms.list.reduce((sum, dm) => sum + (dm.unread_count || 0), 0)
	);

	$effect(() => {
		const request = revealRequest;
		if (!request) return;

		tick().then(() => {
			requestAnimationFrame(() => {
				if (revealRequest?.requestId !== request.requestId) return;
				const rows = sidebarNav?.querySelectorAll<HTMLElement>('[data-sidebar-conversation-id]');
				const row = rows
					? Array.from(rows).find((item) => item.dataset.sidebarConversationId === request.conversationId)
					: null;
				row?.scrollIntoView({ block: 'center', inline: 'nearest' });
			});
		});
	});

	function openInbox() {
		channels.select(null);
		dms.select(null);
		ui.setView('inbox');
		if (ui.isMobile) ui.closeSidebar();
	}

	async function openFeedback() {
		ui.setView('channels');
		dms.select(null);
		await channels.ensureLoaded(FEEDBACK_CHANNEL_ID);
		channels.select(FEEDBACK_CHANNEL_ID);
		if (ui.isMobile) ui.closeSidebar();
	}

	let showSha = $state(false);

	const DEFAULT_SIDEBAR_WIDTH = 288;
	const MIN_SIDEBAR_WIDTH = 224;
	const MAX_SIDEBAR_WIDTH = 448;
	const SIDEBAR_WIDTH_STORAGE_KEY = 'threads-sidebar-width';

	let sidebarWidth = $state(DEFAULT_SIDEBAR_WIDTH);
	let isResizingSidebar = $state(false);

	function clampSidebarWidth(width: number) {
		return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
	}

	function persistSidebarWidth(width: number) {
		try {
			localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
		} catch {
			// Ignore storage failures; resizing should still work for this session.
		}
	}

	function adjustSidebarWidth(delta: number) {
		sidebarWidth = clampSidebarWidth(sidebarWidth + delta);
		persistSidebarWidth(sidebarWidth);
	}

	function handleSidebarResizeKeydown(e: KeyboardEvent) {
		if (ui.isMobile) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			adjustSidebarWidth(e.shiftKey ? -40 : -16);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			adjustSidebarWidth(e.shiftKey ? 40 : 16);
		} else if (e.key === 'Home') {
			e.preventDefault();
			sidebarWidth = MIN_SIDEBAR_WIDTH;
			persistSidebarWidth(sidebarWidth);
		} else if (e.key === 'End') {
			e.preventDefault();
			sidebarWidth = MAX_SIDEBAR_WIDTH;
			persistSidebarWidth(sidebarWidth);
		}
	}

	function handleSidebarResizePointerDown(e: PointerEvent) {
		if (ui.isMobile) return;
		e.preventDefault();
		isResizingSidebar = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const handlePointerMove = (moveEvent: PointerEvent) => {
			sidebarWidth = clampSidebarWidth(moveEvent.clientX);
		};

		const handlePointerUp = () => {
			isResizingSidebar = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			persistSidebarWidth(sidebarWidth);
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerUp);
		};

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerUp);
	}

	onMount(() => {
		try {
			const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
			if (Number.isFinite(storedWidth) && storedWidth > 0) {
				sidebarWidth = clampSidebarWidth(storedWidth);
			}
		} catch {
			// Ignore storage failures; the default width is fine.
		}
	});
</script>

<!-- Mobile backdrop: visible when open, during drag, or during snap animation -->
{#if ui.isMobile && (ui.sidebarOpen || ui.isDraggingSidebar || ui.sidebarDragAnimating)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="absolute inset-0 bg-black z-40"
		role="button"
		tabindex="-1"
		style="opacity: {(ui.isDraggingSidebar || ui.sidebarDragAnimating) ? (ui.sidebarDragOffset ?? 0) * 0.5 : 0.5};
			{ui.isDraggingSidebar ? 'transition: none;' : 'transition: opacity 300ms ease-in-out;'}"
		onclick={() => ui.closeSidebar()}
		onkeydown={(e) => { if (e.key === 'Escape') ui.closeSidebar(); }}
	></div>
{/if}

<aside
	class="sidebar-slide bg-[var(--color-bg-surface)] border-r border-[var(--color-border)] flex flex-col
		{ui.sidebarOpen ? 'sidebar-open' : ''}
		{ui.isDraggingSidebar ? 'sidebar-dragging' : ''}
		{ui.sidebarDragAnimating ? 'sidebar-animating' : ''}
		{isResizingSidebar ? 'sidebar-resizing' : ''}"
	style={`--sidebar-width: ${sidebarWidth}px; ${ui.isMobile && (ui.isDraggingSidebar || ui.sidebarDragAnimating)
		? `transform: translateX(${-100 + (ui.sidebarDragOffset ?? 0) * 100}%);`
		: ''}`}
>
	<div class="h-12 px-4 flex items-center border-b border-[var(--color-border)] shrink-0">
		<button class="text-lg font-semibold hover:text-[var(--color-text-muted)] transition-colors" onclick={() => (showSha = !showSha)}>
			Threads
		</button>
		{#if showSha}
			{#if __REPO_URL__}
				<a href="{__REPO_URL__}/commit/{__COMMIT_SHA__}" target="_blank" rel="noopener noreferrer" class="text-xs text-[var(--color-text-muted)] font-mono ml-2 hover:underline">{__COMMIT_SHA__}</a>
			{:else}
				<span class="text-xs text-[var(--color-text-muted)] font-mono ml-2">{__COMMIT_SHA__}</span>
			{/if}
		{/if}
	</div>

	<nav bind:this={sidebarNav} class="sidebar-scrollbar flex-1 p-2 space-y-0.5 overflow-y-auto">
		<button
			onclick={openInbox}
			class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm transition-colors {ui.currentView === 'inbox'
				? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
				: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'}"
		>
			<span class="w-5 shrink-0 flex items-center justify-center">
				<Tray size={14} />
			</span>
			<span>Inbox</span>
			{#if unreadCount > 0}
				<span class="ml-auto min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center">{unreadCount}</span>
			{/if}
		</button>

		<button
			onclick={openFeedback}
			data-sidebar-conversation-id={FEEDBACK_CHANNEL_ID}
			class="flex items-center gap-2 w-full text-left px-3 py-1.5 mb-2 rounded text-sm transition-colors {ui.currentView === 'channels' && channels.selectedId === FEEDBACK_CHANNEL_ID
				? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
				: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'}"
		>
			<span class="w-5 shrink-0 flex items-center justify-center">
				<ChatCircleText size={14} />
			</span>
			<span>Feedback</span>
		</button>

		<ChannelList {revealRequest} oncreate={() => modals.open('create-channel')} onbrowse={() => modals.open('browse-channels')} />

		<div class="mt-4">
			<DMList onnewdm={() => modals.open('new-dm')} />
		</div>

		<div class="mt-4">
			<div class="flex items-center justify-between px-3 py-2">
				<span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Processes</span>
			</div>
			<button
				onclick={() => {
					channels.select(null);
					dms.select(null);
					ui.setView('processes');
					if (ui.isMobile) ui.closeSidebar();
				}}
				class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm transition-colors {ui.currentView === 'processes'
					? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
					: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'}"
			>
				<span class="w-5 shrink-0 flex items-center justify-center">
					<Cpu size={14} />
				</span>
				<span>All processes</span>
				{#if processes.runningCount > 0}
					<span class="ml-auto min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center">{processes.runningCount}</span>
				{/if}
			</button>
		</div>

	</nav>

	<div class="border-t border-[var(--color-border)] shrink-0">
		<UserMenu onsettings={() => modals.open('user-settings')} />
	</div>

	<button
		type="button"
		class="sidebar-resizer"
		aria-label="Resize sidebar"
		onpointerdown={handleSidebarResizePointerDown}
		onkeydown={handleSidebarResizeKeydown}
	></button>
</aside>

{#if modals.isOpen('create-channel')}
	<CreateChannelModal onclose={() => modals.close('create-channel')} />
{/if}

{#if modals.isOpen('browse-channels')}
	<ChannelDirectory onclose={() => modals.close('browse-channels')} />
{/if}

{#if modals.isOpen('new-dm')}
	<NewDMModal onclose={() => modals.close('new-dm')} />
{/if}

{#if modals.isOpen('user-settings')}
	<UserSettingsModal onclose={() => modals.close('user-settings')} />
{/if}
