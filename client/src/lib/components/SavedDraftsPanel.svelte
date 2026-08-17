<script lang="ts">
	import { savedDrafts, type SavedDraft } from '$lib/state/saved-drafts.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { onMount } from 'svelte';
	import X from 'phosphor-svelte/lib/X';
	import NotePencil from 'phosphor-svelte/lib/NotePencil';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';
	import Trash from 'phosphor-svelte/lib/Trash';
	import Clock from 'phosphor-svelte/lib/Clock';

	interface Props {
		channelId: string;
		onloaddraft?: (content: string, draftId: string) => void;
	}

	let { channelId, onloaddraft, embedded = false }: Props & { embedded?: boolean } = $props();

	let panelOpen = $state(false);
	let dateTimeInput: HTMLInputElement;
	let schedulingDraftId: string | null = $state(null);

	onMount(() => {
		savedDrafts.load(channelId);
		requestAnimationFrame(() => {
			panelOpen = true;
		});
	});

	function handleClose() {
		if (ui.isMobile) {
			handleAnimatedClose();
		} else {
			ui.closeSavedDraftsPanel();
		}
	}

	function handleAnimatedClose() {
		const screenWidth = window.innerWidth;
		ui.setSavedDraftsDragAnimating(true);
		ui.setSavedDraftsDragOffset(screenWidth);
		setTimeout(() => {
			ui.closeSavedDraftsPanel();
			ui.setSavedDraftsDragOffset(null);
			ui.setSavedDraftsDragAnimating(false);
		}, 200);
	}

	async function handleDelete(draft: SavedDraft) {
		try {
			await savedDrafts.delete(draft.id);
		} catch {
			// Error already logged in state
		}
	}

	function handleClickDraft(draft: SavedDraft) {
		onloaddraft?.(draft.content, draft.id);
		// Delete the draft after loading it (this also cancels any schedule)
		savedDrafts.delete(draft.id).catch(() => {});
		if (ui.isMobile) {
			ui.closeSavedDraftsPanel();
		}
	}

	function toLocalDateTimeString(date: Date): string {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	function openSchedulePicker(draftId: string, currentScheduledAt?: string | null) {
		schedulingDraftId = draftId;
		const now = new Date();
		now.setMinutes(now.getMinutes() + 1);
		dateTimeInput.min = toLocalDateTimeString(now);
		if (currentScheduledAt) {
			dateTimeInput.value = toLocalDateTimeString(new Date(currentScheduledAt));
		} else {
			dateTimeInput.value = '';
		}
		try {
			dateTimeInput.showPicker();
		} catch {
			// Fallback for browsers that don't support showPicker
			dateTimeInput.click();
		}
	}

	async function handleDateTimeChange() {
		if (!schedulingDraftId || !dateTimeInput.value) return;
		const scheduledAt = new Date(dateTimeInput.value).toISOString();
		try {
			await savedDrafts.schedule(schedulingDraftId, scheduledAt);
		} catch {
			// Error already logged in state
		}
		schedulingDraftId = null;
	}

	async function handleUnschedule(draftId: string) {
		try {
			await savedDrafts.unschedule(draftId);
		} catch {
			// Error already logged in state
		}
	}

	function truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return text.slice(0, maxLength) + '...';
	}

	function formatTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) return `${diffHours}h ago`;
		const diffDays = Math.floor(diffHours / 24);
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	}

	function formatScheduledTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = date.getTime() - now.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		if (diffMins < 1) return 'sending soon';
		if (diffMins < 60) return `in ${diffMins}m`;
		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) return `in ${diffHours}h`;
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
</script>

<!-- Hidden datetime input for native picker — avoids mobile layout issues -->
<input
	type="datetime-local"
	bind:this={dateTimeInput}
	class="sr-only"
	onchange={handleDateTimeChange}
/>

<aside
	class="saved-drafts-panel {embedded ? 'saved-drafts-panel-embedded' : ''} {panelOpen ? 'saved-drafts-panel-open' : ''}
		{ui.isDraggingSavedDrafts ? 'saved-drafts-panel-dragging' : ''}
		{ui.savedDraftsDragAnimating ? 'saved-drafts-panel-animating' : ''}"
	style={ui.isMobile && (ui.isDraggingSavedDrafts || ui.savedDraftsDragAnimating)
		? `transform: translateX(${ui.savedDraftsDragOffset ?? 0}px);`
		: ''}
>
	<div
		class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] relative z-10"
	>
		<div class="flex items-center gap-2">
			{#if ui.isMobile}
				<button
					onclick={handleClose}
					class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 p-1"
					title="Back"
				>
					<CaretLeft size={20} />
				</button>
			{/if}
			<NotePencil size={16} class="text-[var(--color-text-muted)]" />
			<span class="font-semibold text-sm">Saved drafts</span>
			{#if savedDrafts.list.length > 0}
				<span class="text-xs bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)] px-1.5 py-0.5 rounded-full">{savedDrafts.list.length}</span>
			{/if}
		</div>
		<button
			onclick={() => ui.closeSavedDraftsPanel()}
			class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors {ui.isMobile ? 'hidden' : ''}"
			title="Close saved drafts"
		>
			<X size={20} />
		</button>
	</div>

	<div class="flex-1 overflow-y-auto" style="overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
		{#if savedDrafts.loading}
			<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
				Loading saved drafts...
			</div>
		{:else if savedDrafts.list.length === 0}
			<div class="p-8 text-center text-sm text-[var(--color-text-muted)]">
				<NotePencil size={32} class="mx-auto mb-2 opacity-50" />
				<p>No saved drafts</p>
				<p class="text-xs mt-1">Save a draft from the message input to find it here</p>
			</div>
		{:else}
			<div class="py-2">
				{#each savedDrafts.list as draft (draft.id)}
					<div class="px-3 py-2">
						<div
							class="rounded-lg border {draft.scheduled_at ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'} p-3 cursor-pointer hover:border-[var(--color-accent)]/50 transition-colors"
							onclick={() => handleClickDraft(draft)}
							onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') handleClickDraft(draft); }}
							role="button"
							tabindex="0"
						>
							<div class="flex items-baseline justify-between gap-2 mb-1">
								<span class="text-xs text-[var(--color-text-muted)]">
									{formatTime(draft.created_at)}
								</span>
							</div>
							<div class="text-sm text-[var(--color-text)] line-clamp-3 leading-snug whitespace-pre-wrap">
								{truncate(draft.content, 300)}
							</div>
							{#if draft.scheduled_at}
								<div class="flex items-center gap-1 mt-2">
									<button
										onclick={(e: MouseEvent) => { e.stopPropagation(); openSchedulePicker(draft.id, draft.scheduled_at); }}
										class="inline-flex items-center gap-1 text-xs bg-[var(--color-accent)]/15 text-[var(--color-accent)] px-2 py-0.5 rounded-full hover:bg-[var(--color-accent)]/25 transition-colors"
									>
										<Clock size={12} />
										{formatScheduledTime(draft.scheduled_at)}
									</button>
									<button
										onclick={(e: MouseEvent) => { e.stopPropagation(); handleUnschedule(draft.id); }}
										class="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors p-0.5 rounded"
										title="Remove schedule"
									>
										<X size={12} />
									</button>
								</div>
							{/if}
							<div class="flex items-center justify-end mt-2 gap-1">
								{#if !draft.scheduled_at}
									<button
										onclick={(e: MouseEvent) => { e.stopPropagation(); openSchedulePicker(draft.id); }}
										class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors px-2 py-0.5 rounded hover:bg-[var(--color-bg-hover)] flex items-center gap-1"
										title="Schedule message"
									>
										<Clock size={12} />
										Schedule
									</button>
								{/if}
								<button
									onclick={(e: MouseEvent) => { e.stopPropagation(); handleDelete(draft); }}
									class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors px-2 py-0.5 rounded hover:bg-[var(--color-bg-hover)] flex items-center gap-1"
								>
									<Trash size={12} />
									Delete
								</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</aside>

<style>
	.saved-drafts-panel {
		width: 100%;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		flex: 1;
	}

	@media (min-width: 768px) {
		.saved-drafts-panel {
			width: 24rem;
			flex: none;
		}

		.saved-drafts-panel.saved-drafts-panel-embedded {
			width: 100%;
			border-left: 0;
			flex: 1;
			min-height: 0;
		}
	}

	@media (max-width: 767px) {
		.saved-drafts-panel {
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
			padding-top: env(safe-area-inset-top, 0px);
		}
		.saved-drafts-panel.saved-drafts-panel-open {
			transform: translateX(0);
		}
		.saved-drafts-panel.saved-drafts-panel-dragging {
			transition: none !important;
		}
		.saved-drafts-panel.saved-drafts-panel-animating {
			transition: transform 200ms ease-out !important;
		}
	}
</style>
