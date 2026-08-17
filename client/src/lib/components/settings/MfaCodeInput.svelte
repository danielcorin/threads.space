<script lang="ts">
	import { normalizeMfaCode } from '$lib/mfa-code.js';

	interface Props {
		id: string;
		value: string;
		label?: string;
		/** Muted suffix appended to the label, e.g. "(if enabled)". */
		hint?: string;
	}

	let { id, value = $bindable(), label = 'Authenticator code', hint }: Props = $props();

	function handleInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		value = normalizeMfaCode(input.value);
		input.value = value;
	}
</script>

<div>
	<label for={id} class="block text-sm font-medium mb-1">
		{label}{#if hint}<span class="font-normal text-[var(--color-text-muted)]"> {hint}</span>{/if}
	</label>
	<input
		{id}
		type="text"
		bind:value
		oninput={handleInput}
		inputmode="numeric"
		autocomplete="one-time-code"
		pattern="[0-9]*"
		maxlength="6"
		placeholder="000000"
		class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm tracking-[0.2em] focus:outline-none focus:border-[var(--color-accent)]"
	/>
</div>
