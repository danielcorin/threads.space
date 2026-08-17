<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'error' | 'success' | 'warning';
		children: Snippet;
	}

	let { variant = 'error', children }: Props = $props();

	const styles = {
		error: 'bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30 text-[var(--color-danger)]',
		success: 'bg-[var(--color-success)]/10 border-[var(--color-success)]/30 text-[var(--color-success)]',
		warning: 'bg-amber-500/10 border-amber-500/30 text-amber-500'
	};
</script>

<div class="border rounded px-3 py-2 text-sm mb-3 {styles[variant]}">
	{@render children()}
</div>
