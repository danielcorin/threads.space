<script lang="ts">
	import Section from '../ui/Section.svelte';
	import AgentIntegrationPanel from '../AgentIntegrationPanel.svelte';
	import ApiTokenManager from './ApiTokenManager.svelte';
</script>

<ApiTokenManager allowProvisioning />

<Section title="API reference" description="Browse the HTTP API and try requests against this instance.">
	<a
		href="/docs"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
	>
		Open API reference
	</a>
</Section>

<Section title="Agent integration">
	<AgentIntegrationPanel showHeader={false} />
</Section>
