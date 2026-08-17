<script lang="ts">
	interface Props {
		checked: boolean;
		onchange: () => void;
		disabled?: boolean;
		label?: string;
	}

	let { checked, onchange, disabled = false, label }: Props = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	{disabled}
	onclick={onchange}
	class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 {checked
		? 'bg-[var(--color-accent)]'
		: 'bg-[var(--color-border)]'}"
>
	<span
		class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform {checked
			? 'translate-x-6'
			: 'translate-x-1'}"
	></span>
</button>
