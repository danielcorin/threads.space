<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		ariaLabel?: string;
	}

	let { children, ariaLabel = 'Resize right sidebar' }: Props = $props();

	const DEFAULT_PANEL_WIDTH = 384;
	const MIN_PANEL_WIDTH = 320;
	const MAX_PANEL_WIDTH = 640;
	const PANEL_WIDTH_STORAGE_KEY = 'threads-thread-panel-width';

	let panelWidth = $state(DEFAULT_PANEL_WIDTH);
	let isResizing = $state(false);

	function clampPanelWidth(width: number) {
		return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
	}

	function persistPanelWidth(width: number) {
		try {
			localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
		} catch {}
	}

	function adjustPanelWidth(delta: number) {
		panelWidth = clampPanelWidth(panelWidth + delta);
		persistPanelWidth(panelWidth);
	}

	function handleResizeKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			adjustPanelWidth(e.shiftKey ? 40 : 16);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			adjustPanelWidth(e.shiftKey ? -40 : -16);
		} else if (e.key === 'Home') {
			e.preventDefault();
			panelWidth = MIN_PANEL_WIDTH;
			persistPanelWidth(panelWidth);
		} else if (e.key === 'End') {
			e.preventDefault();
			panelWidth = MAX_PANEL_WIDTH;
			persistPanelWidth(panelWidth);
		}
	}

	function handleResizePointerDown(e: PointerEvent) {
		e.preventDefault();
		isResizing = true;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const handlePointerMove = (moveEvent: PointerEvent) => {
			panelWidth = clampPanelWidth(window.innerWidth - moveEvent.clientX);
		};

		const handlePointerUp = () => {
			isResizing = false;
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			persistPanelWidth(panelWidth);
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerUp);
		};

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerUp);
	}

	$effect(() => {
		try {
			const storedWidth = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
			if (Number.isFinite(storedWidth) && storedWidth > 0) {
				panelWidth = clampPanelWidth(storedWidth);
			}
		} catch {}
	});
</script>

<aside
	class="resizable-right-panel relative {isResizing ? 'resizable-right-panel-resizing' : ''}"
	style={`--right-panel-width: ${panelWidth}px;`}
>
	{@render children()}

	<button
		type="button"
		class="right-panel-resizer"
		aria-label={ariaLabel}
		onpointerdown={handleResizePointerDown}
		onkeydown={handleResizeKeydown}
	></button>
</aside>

<style>
	.resizable-right-panel {
		width: var(--right-panel-width, 24rem);
		border-left: 1px solid var(--color-border);
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		flex: none;
		min-height: 0;
	}

	.right-panel-resizer {
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

	.right-panel-resizer::after {
		content: '';
		position: absolute;
		top: 0;
		left: 3px;
		bottom: 0;
		width: 1px;
		background: transparent;
		transition: background-color 120ms ease;
	}

	.right-panel-resizer:hover::after,
	.right-panel-resizer:focus-visible::after,
	.resizable-right-panel.resizable-right-panel-resizing .right-panel-resizer::after {
		background: var(--color-accent);
	}
</style>
