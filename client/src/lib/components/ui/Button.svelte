<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
		size?: 'md' | 'sm' | 'xs';
		type?: 'button' | 'submit';
		disabled?: boolean;
		onclick?: (e: MouseEvent) => void;
		title?: string;
		class?: string;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		type = 'button',
		disabled = false,
		onclick,
		title,
		class: extra = '',
		children
	}: Props = $props();

	const base =
		'inline-flex items-center gap-2 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

	const sizes = {
		md: 'px-4 py-2 text-sm',
		sm: 'px-3 py-1.5 text-sm',
		xs: 'px-2 py-1 text-xs'
	};

	const variants = {
		primary: 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white',
		secondary: 'border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]',
		danger: 'border border-[var(--color-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
		ghost: 'text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10'
	};
</script>

<button {type} {disabled} {onclick} {title} class="{base} {sizes[size]} {variants[variant]} {extra}">
	{@render children()}
</button>
