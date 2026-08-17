<script lang="ts">
	import { onMount } from 'svelte';
	import { ui } from '$lib/state/ui.svelte.js';
	import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece';
	import X from 'phosphor-svelte/lib/X';
	import WidgetPanel from './WidgetPanel.svelte';

	let {
		widgetId,
		channelId,
		widgetName = 'Widget',
		embedded = false
	}: { widgetId: string; channelId: string; widgetName?: string; embedded?: boolean } = $props();

	let panelEl: HTMLElement | undefined = $state();
	let panelOpen = $state(false);

	function close() {
		ui.closeSplitPanel();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}

	onMount(() => {
		requestAnimationFrame(() => {
			panelOpen = true;
			panelEl?.focus();
		});
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
	bind:this={panelEl}
	tabindex="-1"
	class="split-widget-panel relative {embedded ? 'split-widget-panel-embedded' : ''} {panelOpen ? 'split-widget-panel-open' : ''}"
	onkeydown={handleKeydown}
>
	<div
		class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] relative z-10"
	>
		<div class="flex items-center gap-2 min-w-0">
			<PuzzlePiece size={16} class="text-[var(--color-text-muted)] shrink-0" />
			<span class="font-semibold text-sm truncate">{widgetName}</span>
		</div>
		<button
			onclick={close}
			class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
			title="Close widget"
		>
			<X size={20} />
		</button>
	</div>

	<WidgetPanel {widgetId} {channelId} {widgetName} />
</aside>

<style>
	.split-widget-panel {
		width: 50vw;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		outline: none;
		min-height: 0;
	}

	.split-widget-panel.split-widget-panel-embedded {
		width: 100%;
		border-left: 0;
		flex: 1;
	}

	@media (max-width: 767px) {
		.split-widget-panel {
			display: none;
		}
	}
</style>
