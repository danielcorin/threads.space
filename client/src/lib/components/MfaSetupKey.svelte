<script lang="ts">
	import Button from './ui/Button.svelte';
	let { secret }: { secret: string } = $props();
	const id = $props.id();
	let keyInput: HTMLTextAreaElement | undefined = $state();
	let feedback = $state('');

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(secret);
			feedback = 'Key copied';
		} catch {
			keyInput?.focus();
			keyInput?.select();
			feedback = 'Touch and hold the selected key to copy it.';
		}
	}
</script>

<div class="space-y-2">
	<label for={id} class="block text-xs text-[var(--color-text-muted)]">Can’t scan it? Enter this key manually:</label>
	<textarea
		{id}
		bind:this={keyInput}
		value={secret}
		readonly
		rows="2"
		spellcheck="false"
		aria-label="Authenticator setup key"
		onfocus={(event) => event.currentTarget.select()}
		class="block w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] p-2 font-mono text-sm"
	></textarea>
	<Button size="sm" onclick={copyKey}>Copy key</Button>
	<p role="status" class="text-xs text-[var(--color-text-muted)]">{feedback}</p>
</div>

<style>
	textarea {
		-webkit-touch-callout: default !important;
	}
</style>
