<script lang="ts">
	import { onMount } from 'svelte';
	import { channels } from '$lib/state/channels.svelte.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import type { ShareDestination, SharedPayload } from '$lib/shareTarget.js';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import Hash from 'phosphor-svelte/lib/Hash';
	import Lock from 'phosphor-svelte/lib/Lock';
	import ChatCircleDots from 'phosphor-svelte/lib/ChatCircleDots';
	import Robot from 'phosphor-svelte/lib/Robot';
	import Paperclip from 'phosphor-svelte/lib/Paperclip';
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';

	interface Props {
		payload: SharedPayload;
		onselect: (destination: ShareDestination) => void;
		onclose: () => void;
	}

	let { payload, onselect, onclose }: Props = $props();

	let searchInputEl: HTMLInputElement | undefined = $state();
	let query = $state('');

	// Only offer places the user can post to right now.
	let destinations = $derived.by(() => {
		const q = query.trim().toLowerCase().replace(/^[#@]/, '');
		const channelRows = channels.list
			.filter((c) => !c.archived_at)
			.map((c) => ({ kind: 'channel' as const, id: c.id, label: c.name, sublabel: null, isPrivate: !!c.is_private, isBot: false }));
		const dmRows = dms.list
			.filter((d) => d.can_send_messages !== false)
			.map((d) => ({
				kind: 'dm' as const,
				id: d.id,
				label: d.partner.display_name || d.partner.username,
				sublabel: d.partner.display_name ? `@${d.partner.username}` : null,
				isPrivate: false,
				isBot: d.partner.role === 'bot' || d.partner.bot_capabilities != null,
			}));
		const rows = [...channelRows, ...dmRows];
		if (!q) return rows;
		return rows.filter(
			(r) => r.label.toLowerCase().includes(q) || r.sublabel?.toLowerCase().includes(q)
		);
	});

	onMount(() => {
		searchInputEl?.focus();
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && destinations.length > 0) {
			e.preventDefault();
			onselect({ kind: destinations[0].kind, id: destinations[0].id });
		}
	}
</script>

<Modal {onclose} title="Share to…" size="md">
	{#if payload.text || payload.files.length > 0}
		<div class="mb-4 rounded border border-[var(--color-border)] bg-[var(--color-bg-input)] px-3 py-2 text-sm">
			{#if payload.text}
				<p class="whitespace-pre-wrap break-words line-clamp-4">{payload.text}</p>
			{/if}
			{#if payload.files.length > 0}
				<p class="flex items-center gap-1.5 text-[var(--color-text-muted)] {payload.text ? 'mt-1.5' : ''}">
					<Paperclip size={14} />
					<span class="truncate">{payload.files.map((f) => f.name).join(', ')}</span>
				</p>
			{/if}
		</div>
	{/if}

	<div class="relative mb-4">
		<span class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
			<MagnifyingGlass size={16} />
		</span>
		<input
			bind:this={searchInputEl}
			type="text"
			bind:value={query}
			onkeydown={handleKeydown}
			class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 pl-9 text-sm focus:outline-none focus:border-[var(--color-accent)]"
			placeholder="Find a channel or person..."
		/>
	</div>

	<div class="max-h-64 overflow-y-auto space-y-0.5">
		{#if destinations.length === 0}
			<div class="px-3 py-4 text-sm text-[var(--color-text-muted)] text-center">
				{query ? 'No matches' : 'Loading conversations...'}
			</div>
		{:else}
			{#each destinations as row (`${row.kind}:${row.id}`)}
				<button
					onclick={() => onselect({ kind: row.kind, id: row.id })}
					class="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded text-sm transition-colors hover:bg-[var(--color-bg-hover)]"
				>
					<span class="w-5 shrink-0 flex items-center justify-center text-[var(--color-text-muted)]">
						{#if row.kind === 'channel'}
							{#if row.isPrivate}<Lock size={16} />{:else}<Hash size={16} />{/if}
						{:else if row.isBot}
							<Robot size={16} />
						{:else}
							<ChatCircleDots size={16} />
						{/if}
					</span>
					<div class="min-w-0 truncate">
						<span class="font-medium">{row.label}</span>
						{#if row.sublabel}
							<span class="text-[var(--color-text-muted)] ml-1">{row.sublabel}</span>
						{/if}
					</div>
				</button>
			{/each}
		{/if}
	</div>

	{#snippet footer()}
		<Button variant="secondary" onclick={onclose}>Cancel</Button>
	{/snippet}
</Modal>
