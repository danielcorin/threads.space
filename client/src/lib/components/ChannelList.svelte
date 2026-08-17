<script lang="ts">
	import { onMount } from 'svelte';
	import { channels } from '$lib/state/channels.svelte.js';
	import { folders } from '$lib/state/folders.svelte.js';
	import { drafts } from '$lib/state/drafts.svelte.js';
	import { processes } from '$lib/state/processes.svelte.js';
	import { createLongPressDrag } from '$lib/useLongPressDrag.js';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import { ui } from '$lib/state/ui.svelte.js';
	import type { SidebarRevealRequest } from '$lib/unreadNavigation.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	interface Props {
		oncreate: () => void;
		onbrowse: () => void;
		revealRequest?: SidebarRevealRequest | null;
	}

	let { oncreate, onbrowse, revealRequest = null }: Props = $props();

	// --- Drag and drop state (entity-specific; mechanics live in useLongPressDrag) ---
	let dragType = $state<'channel' | 'folder' | null>(null);
	let dragChannelId = $state<string | null>(null);
	let dragFolderId = $state<string | null>(null);
	let dropTarget = $state<{
		type: 'folder-header' | 'channel-slot' | 'unfiled-slot';
		folderId?: string;
		position?: number;
	} | null>(null);
	// Captured at gesture start — the shared controller only hands us the DOM
	// node on activation, not the entity type/id.
	let pendingType: 'channel' | 'folder' | null = null;
	let pendingId: string | null = null;

	function selectChannel(channelId: string) {
		ui.setView('channels');
		channels.select(channelId);
		if (ui.isMobile) ui.closeSidebar();
	}

	// --- Folder context menu state ---
	let contextMenu = $state<{ folderId: string; x: number; y: number } | null>(null);

	// --- Channel context menu state ---
	let channelContextMenu = $state<{ channelId: string; x: number; y: number } | null>(null);

	// --- Leave channel confirmation ---
	let leaveConfirm = $state<{ channelId: string; channelName: string; isPrivate: boolean } | null>(null);
	// --- Delete ephemeral channel confirmation ---
	let deleteConfirm = $state<{ channelId: string; channelName: string } | null>(null);
	let archiveToast = $state<{ channelId: string; channelName: string } | null>(null);
	let archiveToastTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Inline rename state ---
	let renamingFolderId = $state<string | null>(null);
	let renameValue = $state('');

	// --- New folder inline input ---
	let creatingFolder = $state(false);
	let newFolderName = $state('');

	function focusInput(node: HTMLInputElement) {
		node.focus();
	}

	function getChannel(id: string) {
		return channels.list.find((c) => c.id === id);
	}

	function resetDragState() {
		dragType = null;
		dragChannelId = null;
		dragFolderId = null;
		dropTarget = null;
		pendingType = null;
		pendingId = null;
	}

	// --- Hit-test under pointer and update dropTarget ---
	function hitTestDropTarget(clientX: number, clientY: number) {
		const el = document.elementFromPoint(clientX, clientY);
		if (el) {
			const channelSlotEl = el.closest('[data-channel-slot]') as HTMLElement | null;
			const unfiledEl = el.closest('[data-unfiled-zone]') as HTMLElement | null;

			if (channelSlotEl && dragType === 'channel') {
				const fId = channelSlotEl.dataset.folderId!;
				const pos = parseInt(channelSlotEl.dataset.position!, 10);
				dropTarget = { type: 'channel-slot', folderId: fId, position: pos };
			} else if (dragType === 'channel') {
				// When hovering over a channel button (most of the surface area),
				// find the nearest drop slot based on cursor Y position
				const nearestSlot = findNearestSlot(clientX, clientY, el);
				if (nearestSlot) {
					dropTarget = nearestSlot;
				} else {
					const folderEl = el.closest('[data-folder-id]') as HTMLElement | null;
					if (folderEl) {
						dropTarget = { type: 'folder-header', folderId: folderEl.dataset.folderId! };
					} else if (unfiledEl) {
						dropTarget = { type: 'unfiled-slot', position: 0 };
					} else {
						dropTarget = null;
					}
				}
			} else if (dragType === 'folder') {
				const folderEl = el.closest('[data-folder-id]') as HTMLElement | null;
				if (folderEl && dragFolderId !== folderEl.dataset.folderId) {
					const folder = folders.list.find((f) => f.id === folderEl.dataset.folderId);
					if (folder) {
						dropTarget = { type: 'folder-header', folderId: folderEl.dataset.folderId!, position: folder.position };
					}
				} else {
					dropTarget = null;
				}
			} else {
				dropTarget = null;
			}
		}
	}

	// Find the nearest channel-slot drop indicator to the cursor position
	function findNearestSlot(clientX: number, clientY: number, hitEl: Element): typeof dropTarget {
		// Check if we're over a channel button inside a folder or unfiled zone
		const folderEl = hitEl.closest('[data-folder-id]') as HTMLElement | null;
		const unfiledEl = hitEl.closest('[data-unfiled-zone]') as HTMLElement | null;
		const container = folderEl || unfiledEl;
		if (!container) return null;

		// If in unfiled zone, use unfiled slot
		if (unfiledEl && !folderEl) {
			return { type: 'unfiled-slot', position: 0 };
		}

		// Find all channel slots within this folder
		const slots = container.querySelectorAll('[data-channel-slot]');
		if (slots.length === 0) return null;

		let closestSlot: HTMLElement | null = null;
		let closestDist = Infinity;

		for (const slot of slots) {
			const rect = (slot as HTMLElement).getBoundingClientRect();
			const slotMidY = rect.top + rect.height / 2;
			const dist = Math.abs(clientY - slotMidY);
			if (dist < closestDist) {
				closestDist = dist;
				closestSlot = slot as HTMLElement;
			}
		}

		if (closestSlot) {
			const fId = closestSlot.dataset.folderId!;
			const pos = parseInt(closestSlot.dataset.position!, 10);
			return { type: 'channel-slot', folderId: fId, position: pos };
		}

		return null;
	}

	// --- Execute the drop ---
	async function executeDrop() {
		if (dropTarget && dragType === 'channel' && dragChannelId) {
			if (dropTarget.type === 'folder-header' && dropTarget.folderId) {
				const folder = folders.list.find((f) => f.id === dropTarget!.folderId);
				await folders.moveChannel(dragChannelId, dropTarget.folderId, folder ? folder.channels.length : 0);
			} else if (dropTarget.type === 'channel-slot' && dropTarget.folderId !== undefined) {
				await folders.moveChannel(dragChannelId, dropTarget.folderId, dropTarget.position ?? 0);
			} else if (dropTarget.type === 'unfiled-slot') {
				await folders.moveChannel(dragChannelId, null, 0);
			}
		} else if (dropTarget && dragType === 'folder' && dragFolderId) {
			if (dropTarget.type === 'folder-header' && dropTarget.folderId && dropTarget.folderId !== dragFolderId) {
				const targetFolder = folders.list.find((f) => f.id === dropTarget!.folderId);
				if (targetFolder) {
					await folders.moveFolder(dragFolderId, targetFolder.position);
				}
			}
		}
	}

	const drag = createLongPressDrag({
		onActivate: () => {
			dragType = pendingType;
			if (pendingType === 'channel') {
				dragChannelId = pendingId;
			} else if (pendingType === 'folder') {
				dragFolderId = pendingId;
			}
		},
		onMove: (x, y) => hitTestDropTarget(x, y),
		onDrop: executeDrop,
		onCleanup: resetDragState
	});

	function startGesture(type: 'channel' | 'folder', id: string) {
		pendingType = type;
		pendingId = id;
	}

	// --- Context menu ---
	function onFolderContextMenu(e: MouseEvent, folderId: string) {
		e.preventDefault();
		contextMenu = { folderId, x: e.clientX, y: e.clientY };
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	function startRename(folderId: string) {
		const f = folders.list.find((f) => f.id === folderId);
		if (!f) return;
		renamingFolderId = folderId;
		renameValue = f.name;
		closeContextMenu();
	}

	async function commitRename() {
		if (renamingFolderId && renameValue.trim()) {
			await folders.rename(renamingFolderId, renameValue.trim());
		}
		renamingFolderId = null;
		renameValue = '';
	}

	async function deleteFolder(folderId: string) {
		closeContextMenu();
		await folders.delete(folderId);
	}

	function onChannelContextMenu(e: MouseEvent, channelId: string) {
		e.preventDefault();
		e.stopPropagation();
		channelContextMenu = { channelId, x: e.clientX, y: e.clientY };
	}

	function closeChannelContextMenu() {
		channelContextMenu = null;
	}

	function copyChannelLink(channelId: string) {
		closeChannelContextMenu();
		const url = `${window.location.origin}?channel=${channelId}`;
		navigator.clipboard.writeText(url);
	}

	function copyChannelName(channelId: string) {
		closeChannelContextMenu();
		const ch = getChannel(channelId);
		if (!ch) return;
		navigator.clipboard.writeText(ch.name);
	}

	function promptLeaveChannel(channelId: string) {
		closeChannelContextMenu();
		const ch = channels.list.find((c) => c.id === channelId);
		if (!ch) return;
		leaveConfirm = { channelId, channelName: ch.name, isPrivate: !!ch.is_private };
	}

	function showArchiveToast(channelId: string, channelName: string) {
		archiveToast = { channelId, channelName };
		if (archiveToastTimer) clearTimeout(archiveToastTimer);
		archiveToastTimer = setTimeout(() => {
			archiveToast = null;
			archiveToastTimer = null;
		}, 6000);
	}

	async function archiveChannel(channelId: string) {
		closeChannelContextMenu();
		const ch = channels.list.find((c) => c.id === channelId);
		await channels.archive(channelId);
		showArchiveToast(channelId, ch?.name ?? 'channel');
	}

	function clearArchiveToast() {
		if (archiveToastTimer) clearTimeout(archiveToastTimer);
		archiveToast = null;
		archiveToastTimer = null;
	}

	async function restoreArchivedChannel() {
		if (!archiveToast) return;
		const { channelId } = archiveToast;
		clearArchiveToast();
		await channels.unarchive(channelId);
	}

	async function restoreEphemeralChannel(channelId: string) {
		await channels.unarchive(channelId);
	}

	function closeArchivedEphemeralChannel(channelId: string) {
		channels.removeLocal(channelId);
	}

	async function promoteEphemeralChannel(channelId: string) {
		closeChannelContextMenu();
		const ch = channels.list.find((c) => c.id === channelId);
		if (!ch) return;
		const nextName = window.prompt('Promote to channel', ch.name);
		if (nextName === null) return;
		await channels.promote(channelId, nextName.trim() || ch.name);
	}

	function promptDeleteEphemeral(channelId: string) {
		closeChannelContextMenu();
		const ch = channels.list.find((c) => c.id === channelId);
		if (!ch) return;
		deleteConfirm = { channelId, channelName: ch.name };
	}

	async function confirmDeleteEphemeral() {
		if (!deleteConfirm) return;
		await channels.delete(deleteConfirm.channelId);
		deleteConfirm = null;
	}

	async function confirmLeave() {
		if (!leaveConfirm) return;
		await channels.leaveMembership(leaveConfirm.channelId);
		leaveConfirm = null;
	}

	function startCreateFolder() {
		creatingFolder = true;
		newFolderName = '';
	}

	async function commitCreateFolder() {
		if (newFolderName.trim()) {
			await folders.create(newFolderName.trim());
		}
		creatingFolder = false;
		newFolderName = '';
	}

	function isDropTarget(type: string, folderId?: string, position?: number) {
		if (!dropTarget) return false;
		if (dropTarget.type !== type) return false;
		if (folderId !== undefined && dropTarget.folderId !== folderId) return false;
		if (position !== undefined && dropTarget.position !== position) return false;
		return true;
	}

	// --- Ephemeral channels ---
	const EPHEMERAL_COLLAPSED_STORAGE_KEY = 'threads-sidebar-ephemeral-collapsed';
	let ephemeralCollapsed = $state(false);

	async function createEphemeral() {
		await channels.createEphemeral();
	}

	function persistEphemeralCollapsed(collapsed: boolean) {
		try {
			localStorage.setItem(EPHEMERAL_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
		} catch {
			// Ignore storage failures; collapsing should still work for this session.
		}
	}

	function toggleEphemeralCollapsed() {
		ephemeralCollapsed = !ephemeralCollapsed;
		persistEphemeralCollapsed(ephemeralCollapsed);
	}

	// List active ephemeral channels by default. If an archived ephemeral is reopened
	// from search/deep-link, show only the currently open archived channel as a
	// temporary sidebar row with Restore + close controls.
	let ephemeralChannels = $derived(
		channels.list.filter((c) => c.is_ephemeral && (!c.archived_at || c.id === channels.selectedId))
	);
	let ephemeralUnreadCount = $derived(
		ephemeralChannels.reduce((total, channel) => total + (channel.unread_count || (channel.has_unread ? 1 : 0)), 0)
	);

	onMount(() => {
		try {
			ephemeralCollapsed = localStorage.getItem(EPHEMERAL_COLLAPSED_STORAGE_KEY) === 'true';
		} catch {
			// Ignore storage failures; the section starts expanded by default.
		}
	});

	$effect(() => {
		const request = revealRequest;
		if (!request) return;
		const channel = channels.list.find((item) => item.id === request.conversationId);
		if (!channel) return;

		const folder = folders.list.find((item) => item.channels.includes(channel.id));
		if (folder?.collapsed) void folders.toggleCollapsed(folder.id);
		if (channel.is_ephemeral && ephemeralCollapsed) {
			ephemeralCollapsed = false;
			persistEphemeralCollapsed(false);
		}
	});
</script>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape') {
		if (channelContextMenu) { closeChannelContextMenu(); e.preventDefault(); }
		if (contextMenu) { closeContextMenu(); e.preventDefault(); }
	}
}} />

<!-- Close context menu when clicking elsewhere -->
{#if contextMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50"
		onclick={closeContextMenu}
	></div>
	<div
		class="fixed z-[70] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-lg py-1 min-w-[140px]"
		style="left: {contextMenu.x}px; top: {contextMenu.y}px"
	>
		<button
			class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
			onclick={() => startRename(contextMenu!.folderId)}
		>Rename</button>
		<button
			class="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[var(--color-bg-hover)] transition-colors"
			onclick={() => deleteFolder(contextMenu!.folderId)}
		>Delete</button>
	</div>
{/if}

<!-- Channel context menu -->
{#if channelContextMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50"
		onclick={closeChannelContextMenu}
	></div>
	{@const ctxChannel = channels.list.find((c) => c.id === channelContextMenu!.channelId)}
	<div
		class="fixed z-[70] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-lg py-1 min-w-[160px]"
		style="left: {channelContextMenu.x}px; top: {channelContextMenu.y}px"
	>
		{#if ctxChannel}
			<button
				class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				onclick={() => copyChannelLink(ctxChannel.id)}
			>Copy channel link</button>
			<button
				class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				onclick={() => copyChannelName(ctxChannel.id)}
			>Copy channel name</button>
		{/if}
		{#if ctxChannel?.is_ephemeral}
			{#if ctxChannel.archived_at}
				<button
					class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
					onclick={() => { closeChannelContextMenu(); channels.unarchive(ctxChannel.id); }}
				>Restore channel</button>
			{:else}
				<button
					class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
					onclick={() => promoteEphemeralChannel(channelContextMenu!.channelId)}
				>Promote to channel…</button>
				<button
					class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
					onclick={() => archiveChannel(channelContextMenu!.channelId)}
				>Archive channel</button>
			{/if}
			<button
				class="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[var(--color-bg-hover)] transition-colors"
				onclick={() => promptDeleteEphemeral(channelContextMenu!.channelId)}
			>Delete channel</button>
		{:else}
			<button
				class="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[var(--color-bg-hover)] transition-colors"
				onclick={() => promptLeaveChannel(channelContextMenu!.channelId)}
			>Leave channel</button>
		{/if}
	</div>
{/if}

<!-- Leave channel confirmation dialog -->
{#if leaveConfirm}
	<ConfirmDialog
		title="Leave #{leaveConfirm.channelName}?"
		message="You will no longer receive messages from this channel."
		warning={leaveConfirm.isPrivate ? 'This is a private channel. You will need to be re-invited to rejoin.' : undefined}
		confirmLabel="Leave channel"
		onconfirm={confirmLeave}
		oncancel={() => (leaveConfirm = null)}
	/>
{/if}

<!-- Delete ephemeral channel confirmation dialog -->
{#if deleteConfirm}
	<ConfirmDialog
		title="Delete #{deleteConfirm.channelName}?"
		message="This will permanently delete the channel and all its messages. This cannot be undone."
		confirmLabel="Delete channel"
		onconfirm={confirmDeleteEphemeral}
		oncancel={() => (deleteConfirm = null)}
	/>
{/if}

{#if archiveToast}
	<div class="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-[80] sm:max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-3 text-sm shadow-lg flex items-center gap-3 min-w-0">
		<span class="text-[var(--color-text)] truncate min-w-0">Archived #{archiveToast.channelName}</span>
		<button
			type="button"
			class="shrink-0 text-[var(--color-accent)] hover:underline font-medium"
			onclick={restoreArchivedChannel}
		>Restore</button>
	</div>
{/if}

<div class="flex items-center justify-between px-3 py-2">
	<span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Channels</span>
	<div class="flex items-center gap-2 sm:gap-1">
		<button
			onclick={startCreateFolder}
			class="p-1.5 sm:p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
			title="New folder"
		>
			<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
			</svg>
		</button>
		<button
			onclick={createEphemeral}
			class="p-1.5 sm:p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
			title="New ephemeral channel"
		>
			<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
			</svg>
		</button>
		<button
			onclick={oncreate}
			class="p-1.5 sm:p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
			title="Create channel"
		>
			<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
			</svg>
		</button>
	</div>
</div>

{#if creatingFolder}
	<div class="px-3 py-1">
		<input
			type="text"
			bind:value={newFolderName}
			class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
			placeholder="Folder name"
			onkeydown={(e) => {
				if (e.key === 'Enter') commitCreateFolder();
				if (e.key === 'Escape') { creatingFolder = false; }
			}}
			onblur={commitCreateFolder}
			use:focusInput
		/>
	</div>
{/if}

{#if channels.list.length === 0 && !channels.loading}
	<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">No channels yet</div>
{/if}

<!-- Folders -->
{#each folders.list as folder (folder.id)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mt-0.5"
		data-folder-id={folder.id}
		ontouchstart={(e) => { startGesture('folder', folder.id); drag.onTouchStart(e); }}
		ontouchmove={drag.onTouchMove}
		ontouchend={drag.onTouchEnd}
		ontouchcancel={drag.onTouchCancel}
	>
		<!-- Folder header -->
		<div
			class="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold uppercase text-[var(--color-text-muted)] cursor-pointer select-none rounded transition-colors
				{isDropTarget('folder-header', folder.id) ? 'bg-[var(--color-accent)]/20 ring-1 ring-[var(--color-accent)]/40' : 'hover:bg-[var(--color-bg-hover)]'}"
			onmousedown={(e) => { startGesture('folder', folder.id); drag.onMouseDown(e); }}
			onclick={() => folders.toggleCollapsed(folder.id)}
			oncontextmenu={(e) => onFolderContextMenu(e, folder.id)}
			role="button"
			tabindex="0"
			onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); folders.toggleCollapsed(folder.id); } }}
		>
			<svg
				class="w-3 h-3 transition-transform {folder.collapsed ? '' : 'rotate-90'}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
			</svg>
			<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
			</svg>
			{#if renamingFolderId === folder.id}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					bind:value={renameValue}
					class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-1 py-0 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)] normal-case font-normal"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') commitRename();
						if (e.key === 'Escape') { renamingFolderId = null; }
					}}
					onblur={commitRename}
					autofocus
				/>
			{:else}
				<span class="truncate">{folder.name}</span>
			{/if}
		</div>

		<!-- Folder contents (channels) -->
		{#if !folder.collapsed}
			<div class="overflow-hidden transition-all duration-200">
				{#each folder.channels as channelId, idx (channelId)}
					{@const channel = getChannel(channelId)}
					{#if channel}
						<!-- Drop indicator above this channel -->
						<div
							class="h-0.5 mx-3 transition-colors {isDropTarget('channel-slot', folder.id, idx) ? 'bg-[var(--color-accent)]' : ''}"
							data-channel-slot
							data-folder-id={folder.id}
							data-position={idx}
							role="presentation"
						></div>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="relative group">
						<button
							onclick={() => selectChannel(channel.id)}
							data-sidebar-conversation-id={channel.id}
							oncontextmenu={(e) => onChannelContextMenu(e, channel.id)}
							class="flex items-center gap-2 w-full text-left pl-7 py-1.5 rounded text-sm transition-colors {channels.selectedId === channel.id
								? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] pr-8'
								: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] pr-8'}
								{dragChannelId === channel.id ? 'opacity-40' : ''}"
							onmousedown={(e) => { startGesture('channel', channel.id); drag.onMouseDown(e); }}
							ontouchstart={(e) => { startGesture('channel', channel.id); drag.onTouchStart(e); }}
							ontouchmove={drag.onTouchMove}
							ontouchend={drag.onTouchEnd}
							ontouchcancel={drag.onTouchCancel}
						>
							<span class="w-4 shrink-0 flex items-center justify-center text-xs {processes.activeChannelIds.has(channel.id) ? 'channel-icon-running' : ''}">
								{#if channel.is_private}
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
									</svg>
								{:else}
									#
								{/if}
							</span>
							<span class="truncate {channel.has_unread || channel.unread_count > 0 ? 'font-semibold text-[var(--color-text)]' : ''}">{channel.name}</span>
							{#if drafts.has(channel.id)}
								<svg class="ml-auto w-3 h-3 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-label="Draft">
									<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
								</svg>
							{/if}
							{#if channel.unread_count > 0}
								<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>
							{:else if channel.has_unread}
								<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0"></span>
							{/if}
						</button>
						<button
							class="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
								{ui.isMobile && channels.selectedId === channel.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
							title="Leave channel"
							onclick={(e) => { e.stopPropagation(); promptLeaveChannel(channel.id); }}
						>
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
						</div>
					{/if}
				{/each}
				<!-- Drop indicator at end of folder -->
				<div
					class="h-0.5 mx-3 transition-colors {isDropTarget('channel-slot', folder.id, folder.channels.length) ? 'bg-[var(--color-accent)]' : ''}"
					data-channel-slot
					data-folder-id={folder.id}
					data-position={folder.channels.length}
					role="presentation"
				></div>
			</div>
		{/if}
	</div>
{/each}

<!-- Unfiled channels -->
{#if folders.unfiledChannelIds.length > 0}
	{#if folders.list.length > 0}
		<div class="flex items-center gap-2 px-3 py-1.5 mt-1">
			<div class="flex-1 h-px bg-[var(--color-border)]"></div>
			<span class="text-[10px] font-semibold uppercase text-[var(--color-text-muted)] shrink-0">Channels</span>
			<div class="flex-1 h-px bg-[var(--color-border)]"></div>
		</div>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		data-unfiled-zone
		class="transition-colors {isDropTarget('unfiled-slot') ? 'bg-[var(--color-accent)]/10' : ''}"
	>
		{#each folders.unfiledChannelIds as channelId (channelId)}
			{@const channel = getChannel(channelId)}
			{#if channel}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="relative group">
				<button
					onclick={() => selectChannel(channel.id)}
					data-sidebar-conversation-id={channel.id}
					oncontextmenu={(e) => onChannelContextMenu(e, channel.id)}
					class="flex items-center gap-2 w-full text-left pl-3 py-1.5 rounded text-sm transition-colors {channels.selectedId === channel.id
						? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] pr-8'
						: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] pr-8'}
						{dragChannelId === channel.id ? 'opacity-40' : ''}"
					onmousedown={(e) => { startGesture('channel', channel.id); drag.onMouseDown(e); }}
					ontouchstart={(e) => { startGesture('channel', channel.id); drag.onTouchStart(e); }}
					ontouchmove={drag.onTouchMove}
					ontouchend={drag.onTouchEnd}
					ontouchcancel={drag.onTouchCancel}
				>
					<span class="w-5 shrink-0 flex items-center justify-center {processes.activeChannelIds.has(channel.id) ? 'channel-icon-running' : ''}">
						{#if channel.is_private}
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
							</svg>
						{:else}
							#
						{/if}
					</span>
					<span class="truncate {channel.has_unread || channel.unread_count > 0 ? 'font-semibold text-[var(--color-text)]' : ''}">{channel.name}</span>
					{#if drafts.has(channel.id)}
						<svg class="ml-auto w-3 h-3 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-label="Draft">
							<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
						</svg>
					{/if}
					{#if channel.unread_count > 0}
						<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>
					{:else if channel.has_unread}
						<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0"></span>
					{/if}
				</button>
				<button
					class="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
						{ui.isMobile && channels.selectedId === channel.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
					title="Leave channel"
					onclick={(e) => { e.stopPropagation(); promptLeaveChannel(channel.id); }}
				>
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
				</div>
			{/if}
		{/each}
	</div>
{/if}

<!-- Ephemeral channels section -->
{#if ephemeralChannels.length > 0}
	<button
		type="button"
		class="flex items-center gap-1 w-full px-3 py-1.5 mt-4 text-xs font-semibold uppercase text-[var(--color-text-muted)] select-none rounded hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
		aria-expanded={!ephemeralCollapsed}
		onclick={toggleEphemeralCollapsed}
	>
		<svg
			class="w-3 h-3 transition-transform {ephemeralCollapsed ? '' : 'rotate-90'}"
			fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			aria-hidden="true"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
		</svg>
		<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
		</svg>
		<span class="truncate">Ephemeral</span>
		<span class="ml-auto text-[10px] font-medium text-[var(--color-text-muted)]">{ephemeralChannels.length}</span>
		{#if ephemeralCollapsed && ephemeralUnreadCount > 0}
			<span class="min-w-[1.1rem] h-4 px-1 rounded-full bg-[var(--color-accent)] text-white text-[10px] font-semibold flex items-center justify-center">{ephemeralUnreadCount > 99 ? '99+' : ephemeralUnreadCount}</span>
		{/if}
	</button>
	{#if !ephemeralCollapsed}
	{#each ephemeralChannels as channel (channel.id)}
		{@const isArchivedEphemeral = !!channel.archived_at}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="relative group">
			<button
				onclick={() => selectChannel(channel.id)}
				data-sidebar-conversation-id={channel.id}
				oncontextmenu={(e) => onChannelContextMenu(e, channel.id)}
				class="flex items-center gap-2 w-full text-left pl-3 py-1.5 rounded text-sm transition-colors {channels.selectedId === channel.id
					? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] pr-16'
					: 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] pr-16'}"
			>
				<span class="w-5 shrink-0 flex items-center justify-center {processes.activeChannelIds.has(channel.id) ? 'channel-icon-running' : ''}">
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
					</svg>
				</span>
				<span class="truncate {channel.has_unread || channel.unread_count > 0 ? 'font-semibold text-[var(--color-text)]' : ''}">{channel.name}</span>
				{#if drafts.has(channel.id)}
					<svg class="ml-auto w-3 h-3 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-label="Draft">
						<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
					</svg>
				{/if}
				{#if channel.unread_count > 0}
					<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>
				{:else if channel.has_unread}
					<span class="{drafts.has(channel.id) ? 'ml-1' : 'ml-auto'} w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0"></span>
				{/if}
			</button>

			{#if isArchivedEphemeral}
				<button
					class="absolute right-7 top-1/2 -translate-y-1/2 h-5 px-1.5 flex items-center justify-center rounded text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] transition-colors"
					title="Restore channel"
					onclick={(e) => {
						e.stopPropagation();
						restoreEphemeralChannel(channel.id);
					}}
				>
					Restore
				</button>
			{/if}

			<!-- X archives active ephemerals. For archived ephemerals reopened from search, X only closes/hides the temporary sidebar row. -->
			<button
				class="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
				{(isArchivedEphemeral || (ui.isMobile && channels.selectedId === channel.id)) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
				title={isArchivedEphemeral ? 'Close channel' : 'Archive channel'}
				onclick={(e) => {
					e.stopPropagation();
					if (isArchivedEphemeral) {
						closeArchivedEphemeralChannel(channel.id);
					} else {
						archiveChannel(channel.id);
					}
				}}
			>
				<svg
					class="w-3 h-3"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2.5"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/each}
	{/if}
{/if}

<button
	onclick={onbrowse}
	class="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors mt-1"
>
	<span class="w-5 shrink-0 flex items-center justify-center">
		<MagnifyingGlass size={14} />
	</span>
	<span>Browse channels</span>
</button>

<style>
	:global(.channel-icon-running) {
		color: #f59e0b;
	}
</style>
