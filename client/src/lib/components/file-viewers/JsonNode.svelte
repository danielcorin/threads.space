<script lang="ts">
	import { untrack } from 'svelte';
	import Self from './JsonNode.svelte';

	interface Props {
		value: unknown;
		name?: string;
		depth?: number;
	}

	let { value, name, depth = 0 }: Props = $props();

	// Initial expansion is based on depth at mount only; reading `depth` directly
	// during $state() initialization captures it eagerly. `untrack` quiets the
	// "state referenced locally" warning without changing behavior.
	let expanded = $state(untrack(() => depth < 2));

	function isObject(v: unknown): v is Record<string, unknown> {
		return typeof v === 'object' && v !== null && !Array.isArray(v);
	}
	function isArray(v: unknown): v is unknown[] {
		return Array.isArray(v);
	}

	let kind = $derived(
		value === null
			? 'null'
			: isArray(value)
				? 'array'
				: isObject(value)
					? 'object'
					: typeof value
	);

	let entries = $derived.by(() => {
		if (isArray(value)) return value.map((v, i) => [String(i), v] as const);
		if (isObject(value)) return Object.entries(value);
		return [] as Array<readonly [string, unknown]>;
	});

	let isCollapsible = $derived(
		(kind === 'object' || kind === 'array') && entries.length > 0
	);

	let preview = $derived.by(() => {
		if (kind === 'array') return `[${entries.length}]`;
		if (kind === 'object') return `{${entries.length}}`;
		return '';
	});

	function toggle() {
		if (isCollapsible) expanded = !expanded;
	}
</script>

<div class="json-node" style="padding-left: {depth === 0 ? 0 : 12}px;">
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="json-row" role="presentation" onclick={toggle} class:collapsible={isCollapsible}>
		{#if isCollapsible}
			<span class="json-toggle">{expanded ? '▾' : '▸'}</span>
		{:else}
			<span class="json-toggle-spacer"></span>
		{/if}
		{#if name !== undefined}
			<span class="json-key">{name}</span><span class="json-colon">:</span>
		{/if}
		{#if kind === 'string'}
			<span class="json-string">"{value as string}"</span>
		{:else if kind === 'number' || kind === 'bigint'}
			<span class="json-number">{String(value)}</span>
		{:else if kind === 'boolean'}
			<span class="json-bool">{String(value)}</span>
		{:else if kind === 'null'}
			<span class="json-null">null</span>
		{:else if kind === 'undefined'}
			<span class="json-null">undefined</span>
		{:else if !expanded}
			<span class="json-preview">{preview}</span>
		{:else}
			<span class="json-preview">{kind === 'array' ? '[' : '{'}</span>
		{/if}
	</div>
	{#if isCollapsible && expanded}
		<div class="json-children">
			{#each entries as [k, v] (k)}
				<Self value={v} name={kind === 'array' ? undefined : k} depth={depth + 1} />
			{/each}
		</div>
		<div class="json-row" style="padding-left: 0;">
			<span class="json-toggle-spacer"></span>
			<span class="json-preview">{kind === 'array' ? ']' : '}'}</span>
		</div>
	{/if}
</div>

<style>
	.json-node {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 13px;
		line-height: 1.5;
	}
	.json-row {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		align-items: baseline;
	}
	.json-row.collapsible {
		cursor: pointer;
	}
	.json-toggle,
	.json-toggle-spacer {
		display: inline-block;
		width: 12px;
		text-align: center;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}
	.json-key {
		color: var(--color-accent);
	}
	.json-colon {
		color: var(--color-text-muted);
	}
	.json-string {
		color: var(--color-success, #4ade80);
		word-break: break-all;
	}
	.json-number {
		color: var(--color-link, #60a5fa);
	}
	.json-bool {
		color: var(--color-warning, #f59e0b);
	}
	.json-null {
		color: var(--color-text-muted);
		font-style: italic;
	}
	.json-preview {
		color: var(--color-text-muted);
	}
</style>
