<script lang="ts" generics="T extends string">
	interface Props {
		options: { value: T; label: string }[];
		value: T;
		onchange: (value: T) => void;
	}

	let { options, value, onchange }: Props = $props();
</script>

<div class="flex gap-2">
	{#each options as opt (opt.value)}
		<button
			type="button"
			onclick={() => onchange(opt.value)}
			class="flex-1 px-3 py-2 text-sm rounded border transition-colors {value === opt.value
				? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
				: 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]'}"
		>
			{opt.label}
		</button>
	{/each}
</div>
