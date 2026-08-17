<script lang="ts">
	import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
	import 'emoji-picker-element';

	let pickerRef: HTMLElement | undefined = $state();

	$effect(() => {
		if (!pickerRef) return;
		const el = pickerRef;
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.unicode) {
				emojiPicker.select(detail.unicode);
			}
		};
		el.addEventListener('emoji-click', handler);
		return () => el.removeEventListener('emoji-click', handler);
	});
</script>

{#if emojiPicker.isOpen}
	<button type="button" class="emoji-sheet-backdrop" onclick={() => emojiPicker.close()} aria-label="Close emoji picker"></button>
	<div class="emoji-sheet" onclick={(e: MouseEvent) => e.stopPropagation()} onkeydown={(e: KeyboardEvent) => e.stopPropagation()} role="dialog" tabindex="-1">
		<div class="emoji-sheet-handle"></div>
		<emoji-picker bind:this={pickerRef}></emoji-picker>
	</div>
{/if}

<style>
	.emoji-sheet-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 9998;
	}

	.emoji-sheet {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--color-bg-surface);
		border-radius: 0.75rem 0.75rem 0 0;
		padding: 0.5rem 0 0;
		padding-bottom: env(safe-area-inset-bottom, 0px);
		z-index: 9999;
		box-shadow: 0 -4px 6px -1px rgb(0 0 0 / 0.3);
	}

	/* Desktop: center as a modal instead of bottom sheet */
	@media (min-width: 768px) {
		.emoji-sheet {
			bottom: auto;
			top: 50%;
			left: 50%;
			right: auto;
			transform: translate(-50%, -50%);
			border-radius: 0.75rem;
			padding: 0;
			width: auto;
			max-width: 90vw;
		}
	}

	.emoji-sheet-handle {
		width: 2rem;
		height: 0.25rem;
		background: var(--color-text-muted);
		border-radius: 9999px;
		margin: 0 auto 0.25rem;
		opacity: 0.4;
	}

	@media (min-width: 768px) {
		.emoji-sheet-handle {
			display: none;
		}
	}

	.emoji-sheet :global(emoji-picker) {
		width: 100%;
		height: 45dvh;
		--background: var(--color-bg-surface);
		--border-color: var(--color-border);
		--indicator-color: var(--color-accent);
		--input-border-color: var(--color-border);
		--input-font-color: var(--color-text);
		--input-placeholder-color: var(--color-text-muted);
		--outline-color: var(--color-accent);
		--category-font-color: var(--color-text-muted);
		--button-active-background: var(--color-bg-hover);
		--button-hover-background: var(--color-bg-hover);
		--num-columns: 8;
		--emoji-padding: 0.5rem;
		--emoji-size: 1.25rem;
		border: none;
		border-radius: 0;
	}

	@media (min-width: 768px) {
		.emoji-sheet :global(emoji-picker) {
			border-radius: 0.75rem;
			width: 400px;
			height: 400px;
		}
	}
</style>
