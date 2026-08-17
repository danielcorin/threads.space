<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title?: string;
		description?: string;
		/** The first section in a panel omits the top divider and top margin. */
		first?: boolean;
		children: Snippet;
	}

	let { title, description, first = false, children }: Props = $props();
</script>

<section class={first ? '' : 'mt-6 pt-6 border-t border-[var(--color-border)]'}>
	{#if title || description}
		<div class="mb-3">
			{#if title}
				<h3 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
					{title}
				</h3>
			{/if}
			{#if description}
				<p class="text-xs text-[var(--color-text-muted)] {title ? 'mt-1' : ''}">{description}</p>
			{/if}
		</div>
	{/if}
	{@render children()}
</section>
