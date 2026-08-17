<script lang="ts">
	import type { Snippet } from 'svelte';
	import X from 'phosphor-svelte/lib/X';

	interface Props {
		onclose: () => void;
		title?: string;
		/** sm = max-w-sm, md = max-w-md, lg = max-w-2xl. */
		size?: 'sm' | 'md' | 'lg';
		children: Snippet;
		/** Optional right-aligned button row pinned to the bottom of the panel. */
		footer?: Snippet;
	}

	let { onclose, title, size = 'md', children, footer }: Props = $props();

	const maxWidth = $derived({ sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl' }[size]);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') onclose();
	}}
	onclick={onclose}
>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div
		class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-xl w-full {maxWidth} max-h-[90vh] overflow-y-auto overscroll-none p-6"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
			e.stopPropagation();
		}}
	>
		<div class="flex items-start justify-between gap-4 {title ? 'mb-4' : ''}">
			{#if title}
				<h2 class="text-lg font-semibold">{title}</h2>
			{:else}
				<span></span>
			{/if}
			<button
				type="button"
				onclick={onclose}
				aria-label="Close"
				class="shrink-0 -mr-1 -mt-1 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
			>
				<X size={20} />
			</button>
		</div>
		{@render children()}
		{#if footer}
			<div class="flex justify-end gap-2 mt-6">
				{@render footer()}
			</div>
		{/if}
	</div>
</div>
