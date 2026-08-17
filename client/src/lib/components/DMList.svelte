<script lang="ts">
	import { dms } from '$lib/state/dms.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { presence } from '$lib/state/presence.svelte.js';
	import { processes } from '$lib/state/processes.svelte.js';
	import { createLongPressDrag } from '$lib/useLongPressDrag.js';
	import Plus from 'phosphor-svelte/lib/Plus';

	interface Props {
		onnewdm: () => void;
	}

	let { onnewdm }: Props = $props();

	// Context menu state
	let contextMenu = $state<{ dmId: string; x: number; y: number } | null>(null);

	// --- Drag and drop state (entity-specific; mechanics live in useLongPressDrag) ---
	let dragDmId = $state<string | null>(null);
	let dropPosition = $state<number | null>(null);
	// Mirror of which dm the current gesture is for — captured at gesture start since
	// the shared controller only hands us the DOM node, not the entity id.
	let pendingDmId: string | null = null;

	function displayName(dm: (typeof dms.list)[0]): string {
		return dm.partner.display_name || dm.partner.username;
	}

	function isBotResponding(dm: (typeof dms.list)[0]): boolean {
		return dm.partner.role === 'bot' && processes.activeChannelIds.has(dm.id);
	}

	function onContextMenu(e: MouseEvent, dmId: string) {
		e.preventDefault();
		contextMenu = { dmId, x: e.clientX, y: e.clientY };
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	async function hideDM(dmId: string) {
		closeContextMenu();
		await dms.hide(dmId);
	}

	function resetDragState() {
		dragDmId = null;
		dropPosition = null;
		pendingDmId = null;
	}

	// --- Hit-test under pointer and update dropPosition ---
	function hitTestDropTarget(clientX: number, clientY: number) {
		const el = document.elementFromPoint(clientX, clientY);
		if (!el) return;

		// Explicit drop slot hit
		const slotEl = el.closest('[data-dm-slot]') as HTMLElement | null;
		if (slotEl) {
			dropPosition = parseInt(slotEl.dataset.position!, 10);
			return;
		}

		// Over a DM row — find nearest slot by Y midpoint inside the list
		const listEl = el.closest('[data-dm-list]') as HTMLElement | null;
		if (!listEl) {
			dropPosition = null;
			return;
		}

		const slots = listEl.querySelectorAll('[data-dm-slot]');
		if (slots.length === 0) {
			dropPosition = null;
			return;
		}

		let closestSlot: HTMLElement | null = null;
		let closestDist = Infinity;
		for (const slot of slots) {
			const rect = (slot as HTMLElement).getBoundingClientRect();
			const midY = rect.top + rect.height / 2;
			const dist = Math.abs(clientY - midY);
			if (dist < closestDist) {
				closestDist = dist;
				closestSlot = slot as HTMLElement;
			}
		}
		if (closestSlot) {
			dropPosition = parseInt(closestSlot.dataset.position!, 10);
		}
	}

	async function executeDrop() {
		if (dragDmId !== null && dropPosition !== null) {
			// Slot indices are "insert before row at index i". When dragging down past
			// the source, the logical target decrements by one; the store clamps so
			// this is informational — just pass the slot.
			const fromIdx = dms.list.findIndex((d) => d.id === dragDmId);
			let target = dropPosition;
			if (fromIdx !== -1 && target > fromIdx) target -= 1;
			await dms.moveDM(dragDmId, target);
		}
	}

	const drag = createLongPressDrag({
		onActivate: () => {
			dragDmId = pendingDmId;
		},
		onMove: (x, y) => hitTestDropTarget(x, y),
		onDrop: executeDrop,
		onCleanup: resetDragState,
		// Touch target starts on a child span; walk up to the row wrapper so the
		// clone captures the full row.
		resolveTouchTarget: (e) => {
			const t = e.target as HTMLElement;
			return (t.closest('[data-dm-row]') as HTMLElement | null) ?? t;
		}
	});

	function startGesture(dmId: string) {
		pendingDmId = dmId;
	}

</script>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape' && contextMenu) { closeContextMenu(); e.preventDefault(); }
}} />

<!-- Close context menu when clicking elsewhere -->
{#if contextMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50"
		onclick={closeContextMenu}
	></div>
	<div
		class="fixed z-[70] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-lg py-1 min-w-[160px]"
		style="left: {contextMenu.x}px; top: {contextMenu.y}px"
	>
		<button
			class="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
			onclick={() => hideDM(contextMenu!.dmId)}
		>Close conversation</button>
	</div>
{/if}

<div class="flex items-center justify-between px-3 py-2">
	<span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]"
		>Direct Messages</span
	>
	<button
		onclick={onnewdm}
		class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
		title="New direct message"
	>
		<Plus size={16} />
	</button>
</div>

{#if dms.list.length === 0 && !dms.loading}
	<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">No conversations yet</div>
{/if}

<div data-dm-list>
	{#each dms.list as dm, idx (dm.id)}
		{@const botResponding = isBotResponding(dm)}
		<!-- Drop slot above this row -->
		<div
			class="h-0.5 mx-3 transition-colors {dropPosition === idx ? 'bg-[var(--color-accent)]' : ''}"
			data-dm-slot
			data-position={idx}
			role="presentation"
		></div>
		<div
			class="relative group rounded flex items-center transition-colors {dms.selectedId ===
			dm.id
				? 'bg-[var(--color-accent)]/15'
				: 'hover:bg-[var(--color-bg-hover)]'}
				{dragDmId === dm.id ? 'opacity-40' : ''}"
			data-dm-row
		>
			<button
				onclick={() => {
					ui.setView('channels');
					dms.select(dm.id);
					if (ui.isMobile) ui.closeSidebar();
				}}
				data-sidebar-conversation-id={dm.id}
				oncontextmenu={(e) => onContextMenu(e, dm.id)}
				onmousedown={(e) => { startGesture(dm.id); drag.onMouseDown(e); }}
				ontouchstart={(e) => { startGesture(dm.id); drag.onTouchStart(e); }}
				ontouchmove={drag.onTouchMove}
				ontouchend={drag.onTouchEnd}
				ontouchcancel={drag.onTouchCancel}
				class="flex items-center gap-2 flex-1 min-w-0 text-left pl-3 pr-2 py-1.5 text-sm transition-colors {dms.selectedId ===
				dm.id
					? 'text-[var(--color-accent)]'
					: 'text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]'}"
			>
				<span class="w-5 shrink-0 flex items-center justify-center" title={botResponding ? 'Bot is responding' : undefined}>
					<span
						class="w-2 h-2 rounded-full {botResponding
							? 'bg-[#f59e0b]'
							: presence.isOnline(dm.partner.id)
								? 'bg-green-500'
								: 'bg-[var(--color-text-muted)]/30'}"
					></span>
				</span>
				<span
					class="truncate flex-1 {dm.has_unread || dm.unread_count > 0
						? 'font-semibold text-[var(--color-text)]'
						: ''}">{displayName(dm)}</span
				>
				{#if dm.unread_count > 0}
					<span
						class="ml-auto shrink-0 min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-semibold flex items-center justify-center"
						>{dm.unread_count > 99 ? '99+' : dm.unread_count}</span
					>
				{:else if dm.has_unread}
					<span class="ml-auto w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0"></span>
				{/if}
			</button>

			<!-- Action cluster: width reserved so badges align row-to-row. -->
			<div class="flex shrink-0 items-center gap-0.5 pr-1">
				<!-- Close: hover-reveal on desktop for every row; keep selected row visible on mobile. -->
				<button
					class="w-5 h-5 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors
					{ui.isMobile && dms.selectedId === dm.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
					title="Close conversation"
					onclick={(e) => {
						e.stopPropagation();
						hideDM(dm.id);
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
		</div>
	{/each}
	<!-- Drop slot at end of list -->
	<div
		class="h-0.5 mx-3 transition-colors {dropPosition === dms.list.length
			? 'bg-[var(--color-accent)]'
			: ''}"
		data-dm-slot
		data-position={dms.list.length}
		role="presentation"
	></div>
</div>
