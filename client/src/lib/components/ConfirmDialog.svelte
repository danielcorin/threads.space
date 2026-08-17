<script lang="ts">
	interface Props {
		title: string;
		message: string;
		warning?: string;
		confirmLabel?: string;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { title, message, warning, confirmLabel = 'Confirm', onconfirm, oncancel }: Props = $props();

	let confirmBtn: HTMLButtonElement | undefined = $state();

	$effect(() => {
		confirmBtn?.focus();

		function handleKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				oncancel();
			} else if (e.key === 'Enter') {
				const tag = (e.target as HTMLElement)?.tagName;
				if (tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
				e.preventDefault();
				onconfirm();
			}
		}

		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
	onclick={oncancel}
	onkeydown={(e) => {
		if (e.key === 'Escape') oncancel();
	}}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-xl max-w-sm w-full p-5"
		onclick={(e) => e.stopPropagation()}
		onkeydown={() => {}}
	>
		<h3 class="text-base font-semibold text-[var(--color-text)] mb-2">{title}</h3>
		<p class="text-sm text-[var(--color-text-muted)] mb-3">{message}</p>
		{#if warning}
			<p class="text-sm text-amber-400 mb-3">{warning}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<button
				class="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] transition-colors"
				onclick={oncancel}
			>Cancel</button>
			<button
				bind:this={confirmBtn}
				class="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
				onclick={onconfirm}
			>{confirmLabel}</button>
		</div>
	</div>
</div>
