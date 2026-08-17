<script lang="ts">
	import { pins, type PinnedMessage } from '$lib/state/pins.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { formatTime } from '$lib/utils/time.js';
	import { onMount } from 'svelte';
	import X from 'phosphor-svelte/lib/X';
	import PushPin from 'phosphor-svelte/lib/PushPin';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';

	interface Props {
		channelId: string;
		onnavigatetomessage?: (messageId: string) => void;
	}

	let { channelId, onnavigatetomessage, embedded = false }: Props & { embedded?: boolean } = $props();

	let panelOpen = $state(false);

	onMount(() => {
		pins.load(channelId);
		requestAnimationFrame(() => {
			panelOpen = true;
		});
	});

	function handleClose() {
		if (ui.isMobile) {
			handleAnimatedClose();
		} else {
			ui.closePinsPanel();
		}
	}

	function handleAnimatedClose() {
		const screenWidth = window.innerWidth;
		ui.setPinsDragAnimating(true);
		ui.setPinsDragOffset(screenWidth);
		setTimeout(() => {
			ui.closePinsPanel();
			ui.setPinsDragOffset(null);
			ui.setPinsDragAnimating(false);
		}, 200);
	}

	async function handleUnpin(pin: PinnedMessage) {
		try {
			await pins.unpin(channelId, pin.message_id);
		} catch {
			// Error already logged in state
		}
	}

	function handleClickPin(pin: PinnedMessage) {
		onnavigatetomessage?.(pin.message_id);
		if (ui.isMobile) {
			ui.closePinsPanel();
		}
	}

	function truncate(text: string | null, maxLength: number): string {
		if (!text) return '';
		if (text.length <= maxLength) return text;
		return text.slice(0, maxLength) + '...';
	}
</script>

<aside
	class="pins-panel {embedded ? 'pins-panel-embedded' : ''} {panelOpen ? 'pins-panel-open' : ''}
		{ui.isDraggingPins ? 'pins-panel-dragging' : ''}
		{ui.pinsDragAnimating ? 'pins-panel-animating' : ''}"
	style={ui.isMobile && (ui.isDraggingPins || ui.pinsDragAnimating)
		? `transform: translateX(${ui.pinsDragOffset ?? 0}px);`
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
			<PushPin size={16} class="text-[var(--color-text-muted)]" />
			<span class="font-semibold text-sm">Pinned messages</span>
			{#if pins.list.length > 0}
				<span class="text-xs bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)] px-1.5 py-0.5 rounded-full">{pins.list.length}</span>
			{/if}
		</div>
		<button
			onclick={() => ui.closePinsPanel()}
			class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors {ui.isMobile ? 'hidden' : ''}"
			title="Close pins"
		>
			<X size={20} />
		</button>
	</div>

	<div class="flex-1 overflow-y-auto" style="overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
		{#if pins.loading}
			<div class="p-4 text-center text-sm text-[var(--color-text-muted)]">
				Loading pinned messages...
			</div>
		{:else if pins.list.length === 0}
			<div class="p-8 text-center text-sm text-[var(--color-text-muted)]">
				<PushPin size={32} class="mx-auto mb-2 opacity-50" />
				<p>No pinned messages yet</p>
				<p class="text-xs mt-1">Pin important messages to find them here</p>
			</div>
		{:else}
			<div class="py-2">
				{#each pins.list as pin (pin.id)}
					<div class="px-3 py-2">
						<div
							class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 cursor-pointer hover:border-[var(--color-accent)]/50 transition-colors"
							onclick={() => handleClickPin(pin)}
							onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') handleClickPin(pin); }}
							role="button"
							tabindex="0"
						>
							<div class="flex items-baseline justify-between gap-2 mb-1">
								<span class="font-semibold text-xs" style:color={pin.name_color || undefined}>
									{pin.display_name || pin.username || 'Unknown'}
								</span>
								<span class="text-xs text-[var(--color-text-muted)] shrink-0">
									{formatTime(pin.message_created_at)}
								</span>
							</div>
							<div class="text-sm text-[var(--color-text)] line-clamp-2 leading-snug">
								{truncate(pin.content, 200)}
							</div>
							<div class="flex items-center justify-between mt-2">
								<span class="text-xs text-[var(--color-text-muted)]">
									Pinned by {pin.pinned_by_username || 'unknown'}
								</span>
								<button
									onclick={(e: MouseEvent) => { e.stopPropagation(); handleUnpin(pin); }}
									class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors px-2 py-0.5 rounded hover:bg-[var(--color-bg-hover)]"
								>
									Unpin
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
	.pins-panel {
		width: 100%;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		flex: 1;
	}

	@media (min-width: 768px) {
		.pins-panel {
			width: 24rem;
			flex: none;
		}

		.pins-panel.pins-panel-embedded {
			width: 100%;
			border-left: 0;
			flex: 1;
			min-height: 0;
		}
	}

	@media (max-width: 767px) {
		.pins-panel {
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
		.pins-panel.pins-panel-open {
			transform: translateX(0);
		}
		.pins-panel.pins-panel-dragging {
			transition: none !important;
		}
		.pins-panel.pins-panel-animating {
			transition: transform 200ms ease-out !important;
		}
	}
</style>
