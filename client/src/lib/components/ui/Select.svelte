<script lang="ts" generics="T extends string">
	import type { Snippet } from 'svelte';

	interface Props {
		value: T;
		label?: string;
		id?: string;
		disabled?: boolean;
		onchange?: (value: T) => void;
		/** The <option> elements. */
		children: Snippet;
	}

	let { value = $bindable(), label, id, disabled = false, onchange, children }: Props = $props();
</script>

<div>
	{#if label}
		<label for={id} class="block text-sm font-medium mb-1">{label}</label>
	{/if}
	<select
		{id}
		{disabled}
		bind:value
		onchange={(e) => onchange?.((e.currentTarget as HTMLSelectElement).value as T)}
		class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
	>
		{@render children()}
	</select>
</div>
