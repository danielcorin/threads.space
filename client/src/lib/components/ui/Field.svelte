<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props {
		value: string;
		label?: string;
		type?: 'text' | 'email' | 'password';
		id?: string;
		placeholder?: string;
		maxlength?: number;
		autocomplete?: HTMLInputAttributes['autocomplete'];
		disabled?: boolean;
		required?: boolean;
		/** Muted suffix appended to the label, e.g. "(optional)". */
		hint?: string;
		onblur?: () => void;
	}

	let {
		value = $bindable(),
		label,
		type = 'text',
		id,
		placeholder,
		maxlength,
		autocomplete,
		disabled = false,
		required = false,
		hint,
		onblur
	}: Props = $props();

	const inputClass =
		'w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-60';
</script>

<div>
	{#if label}
		<label for={id} class="block text-sm font-medium mb-1">
			{label}{#if hint}<span class="font-normal text-[var(--color-text-muted)]"> {hint}</span>{/if}
		</label>
	{/if}
	<input {id} {type} {placeholder} {maxlength} {disabled} {required} {autocomplete} {onblur} bind:value class={inputClass} />
</div>
