<script lang="ts">
	import Copy from 'phosphor-svelte/lib/Copy';
	import Check from 'phosphor-svelte/lib/Check';
	import {
		buildAgentIntegrationPrompts,
		resolveAgentIntegrationUrls,
		type AgentIntegrationPromptKind,
	} from '$lib/agentOnboarding.js';

	interface Props {
		/** Hide the built-in title when a parent Section already provides one. */
		showHeader?: boolean;
	}

	let { showHeader = true }: Props = $props();

	const urls = resolveAgentIntegrationUrls();
	const prompts = buildAgentIntegrationPrompts(urls);
	let selectedPromptId = $state<AgentIntegrationPromptKind>('generic');
	let copied = $state(false);
	const selectedPrompt = $derived(prompts.find((option) => option.id === selectedPromptId) ?? prompts[0]);

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(selectedPrompt.prompt);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// Clipboard may be unavailable; the textarea stays selectable.
		}
	}

	function selectPrompt(id: AgentIntegrationPromptKind) {
		selectedPromptId = id;
		copied = false;
	}
</script>

<div class="space-y-4">
	<div>
		{#if showHeader}
			<h3 class="text-sm font-semibold uppercase text-[var(--color-text-muted)] mb-1">Agent integration</h3>
		{/if}
		<p class="text-sm text-[var(--color-text-muted)]">
			Choose the closest target, then paste the prompt into your coding agent. Give credentials only when it asks for them.
		</p>
	</div>

	<ol class="space-y-1 text-sm text-[var(--color-text-muted)] list-decimal list-inside">
		<li><span class="text-[var(--color-text)]">Create an admin token</span> in Settings -> Developer -> API tokens.</li>
		<li><span class="text-[var(--color-text)]">Pick a prompt</span> for a generic agent, Hermes, or OpenClaw.</li>
		<li><span class="text-[var(--color-text)]">Verify it</span> by checking that the bot replies and reports process/tool activity.</li>
	</ol>

	<div class="flex flex-wrap gap-2" role="tablist" aria-label="Agent integration prompt type">
		{#each prompts as option (option.id)}
			<button
				type="button"
				role="tab"
				aria-selected={selectedPromptId === option.id}
				onclick={() => selectPrompt(option.id)}
				class={`px-3 py-1.5 text-sm rounded border transition-colors ${
					selectedPromptId === option.id
						? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-white'
						: 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
				}`}
			>
				{option.label}
			</button>
		{/each}
	</div>

	<p class="text-sm text-[var(--color-text-muted)]">{selectedPrompt.description}</p>

	<textarea
		readonly
		class="w-full min-h-72 bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-xs font-mono leading-relaxed focus:outline-none focus:border-[var(--color-accent)] resize-y"
		aria-label={`${selectedPrompt.label} prompt to paste into your agent`}
		onclick={(e: MouseEvent) => (e.currentTarget as HTMLTextAreaElement).select()}
	>{selectedPrompt.prompt}</textarea>

	<div class="flex flex-wrap items-center gap-2">
		<button
			type="button"
			onclick={copyPrompt}
			class="inline-flex items-center gap-2 px-3 py-2 text-sm rounded bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
		>
			{#if copied}<Check size={16} /> Copied{:else}<Copy size={16} /> Copy prompt{/if}
		</button>
		<a
			href={urls.agentGuideUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex items-center px-3 py-2 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
		>
			agents.txt
		</a>
		<a
			href={urls.apiDocsUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex items-center px-3 py-2 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
		>
			API docs
		</a>
	</div>
</div>
