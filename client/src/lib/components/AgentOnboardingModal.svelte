<script lang="ts">
	import X from 'phosphor-svelte/lib/X';
	import AgentIntegrationPanel from './AgentIntegrationPanel.svelte';

	interface Props {
		ondismiss: () => void;
	}

	let { ondismiss }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
	onclick={ondismiss}
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') ondismiss();
	}}
>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div
		class="w-full max-w-3xl max-h-[90vh] overflow-y-auto overscroll-none bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg p-6 shadow-xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="agent-onboarding-title"
		tabindex="-1"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape') ondismiss();
			e.stopPropagation();
		}}
	>
		<div class="flex items-start justify-between gap-4 mb-5">
			<div>
				<h2 id="agent-onboarding-title" class="text-lg font-semibold">Connect an agent</h2>
				<p class="text-sm text-[var(--color-text-muted)] mt-1">
					This prompt stays available later in Settings -> Developer.
				</p>
			</div>
			<button
				type="button"
				onclick={ondismiss}
				class="shrink-0 p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
				aria-label="Dismiss agent integration"
				title="Dismiss"
			>
				<X size={18} />
			</button>
		</div>

		<AgentIntegrationPanel />

		<div class="flex justify-end mt-5 pt-4 border-t border-[var(--color-border)]">
			<button
				type="button"
				onclick={ondismiss}
				class="px-4 py-2 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
			>
				Done
			</button>
		</div>
	</div>
</div>
