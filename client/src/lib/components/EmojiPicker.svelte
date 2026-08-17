<script lang="ts">
	import { onMount } from 'svelte';
	import { emojiPicker } from '$lib/state/emoji-picker.svelte.js';
	import Plus from 'phosphor-svelte/lib/Plus';
	import 'emoji-picker-element';

	interface Props {
		onselect: (emoji: string) => void;
		onclose: () => void;
	}

	let { onselect, onclose }: Props = $props();

	let desktopPickerRef: HTMLElement | undefined = $state();
	let desktopPopoverRef: HTMLDivElement | undefined = $state();
	let desktopPosition = $state<{ left: number; top: number } | null>(null);

	function select(emoji: string) {
		onselect(emoji);
		onclose();
	}

	$effect(() => {
		if (!desktopPickerRef) return;
		const el = desktopPickerRef;
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.unicode) {
				select(detail.unicode);
			}
		};
		el.addEventListener('emoji-click', handler);
		return () => el.removeEventListener('emoji-click', handler);
	});

	function openFullPicker(e: MouseEvent) {
		e.stopPropagation();
		emojiPicker.open((emoji) => {
			onselect(emoji);
			onclose();
		});
	}

	// Flip mobile bar below when it would be hidden behind the header
	let mobileBarEl: HTMLElement | undefined = $state();
	let flipBelow = $state(false);

	function positionDesktopPopover() {
		if (!desktopPopoverRef) return;

		const anchor = desktopPopoverRef.parentElement;
		if (!anchor) return;

		const anchorRect = anchor.getBoundingClientRect();
		const popoverRect = desktopPopoverRef.getBoundingClientRect();
		const gap = 6;
		const margin = 8;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const popoverWidth = popoverRect.width || 352;
		const popoverHeight = popoverRect.height || 420;

		const idealLeft = anchorRect.right - popoverWidth;
		const left = Math.max(margin, Math.min(idealLeft, viewportWidth - popoverWidth - margin));
		const belowTop = anchorRect.bottom + gap;
		const aboveTop = anchorRect.top - popoverHeight - gap;
		const fitsBelow = belowTop + popoverHeight <= viewportHeight - margin;
		const top = fitsBelow ? belowTop : Math.max(margin, aboveTop);

		desktopPosition = { left, top };
	}

	// Close on outside click — delayed to avoid catching the opening click
	let closeListener: ((e: MouseEvent) => void) | null = null;

	onMount(() => {
		if (mobileBarEl) {
			const rect = mobileBarEl.getBoundingClientRect();
			if (rect.top < 60) {
				flipBelow = true;
			}
		}

		const positionRaf = requestAnimationFrame(positionDesktopPopover);
		window.addEventListener('resize', positionDesktopPopover);
		window.addEventListener('scroll', positionDesktopPopover, true);

		const raf = requestAnimationFrame(() => {
			closeListener = (e: MouseEvent) => {
				// Don't close if the full emoji sheet is open — clicks there
				// should not dismiss this picker via the capture listener
				if (emojiPicker.isOpen) return;
				const target = e.target as HTMLElement;
				if (target.closest('.mobile-bar') || target.closest('.mobile-emoji') || target.closest('.desktop-emoji')) {
					return;
				}
				onclose();
			};
			document.addEventListener('click', closeListener, true);
		});

		return () => {
			cancelAnimationFrame(positionRaf);
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', positionDesktopPopover);
			window.removeEventListener('scroll', positionDesktopPopover, true);
			if (closeListener) {
				document.removeEventListener('click', closeListener, true);
			}
		};
	});
</script>

<!-- Mobile: compact 3-emoji bar -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="mobile-emoji" onclick={(e: MouseEvent) => e.stopPropagation()} onkeydown={() => {}}>
	<div class="mobile-bar" class:flip-below={flipBelow} bind:this={mobileBarEl}>
		{#each emojiPicker.quickEmojis as emoji (emoji)}
			<button
				onclick={(e: MouseEvent) => { e.stopPropagation(); select(emoji); }}
				class="mobile-bar-btn"
			>
				{emoji}
			</button>
		{/each}
		<button
			onclick={openFullPicker}
			class="mobile-bar-btn mobile-bar-more"
			title="More emojis"
		>
			<Plus size={20} />
		</button>
	</div>
</div>

<!-- Desktop: emoji-picker-element popup -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="desktop-emoji"
	class:positioned={desktopPosition}
	style:left={desktopPosition ? `${desktopPosition.left}px` : undefined}
	style:top={desktopPosition ? `${desktopPosition.top}px` : undefined}
	bind:this={desktopPopoverRef}
	onclick={(e: MouseEvent) => e.stopPropagation()}
	onkeydown={() => {}}
>
	<emoji-picker bind:this={desktopPickerRef}></emoji-picker>
</div>

<style>
	/* -- Desktop emoji picker -- */
	.desktop-emoji {
		position: fixed;
		top: 0;
		left: 0;
		visibility: hidden;
		background: var(--color-bg-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.25);
		overflow: hidden;
		z-index: 1000;
	}

	.desktop-emoji.positioned {
		visibility: visible;
	}

	.desktop-emoji :global(emoji-picker) {
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
	}

	/* -- Mobile emoji bar -- */
	.mobile-emoji {
		display: none;
	}

	.mobile-bar-btn {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		font-size: 20px;
		line-height: 1;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.mobile-bar-btn:active {
		background: var(--color-bg-hover);
	}

	.mobile-bar-more {
		font-size: 14px;
		color: var(--color-text-muted);
	}

	@media (max-width: 767px) {
		.desktop-emoji {
			display: none;
		}

		.mobile-emoji {
			display: block;
		}

		.mobile-bar {
			position: absolute;
			bottom: 100%;
			right: 0;
			margin-bottom: 4px;
			display: flex;
			align-items: center;
			background: var(--color-bg-surface);
			border: 1px solid var(--color-border);
			border-radius: 8px;
			box-shadow: 0 4px 12px rgb(0 0 0 / 0.25);
			padding: 4px;
			z-index: 50;
		}

		.mobile-bar.flip-below {
			bottom: auto;
			top: 100%;
			margin-bottom: 0;
			margin-top: 4px;
		}
	}
</style>
