<script lang="ts">
	import { api } from '$lib/api.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import X from 'phosphor-svelte/lib/X';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	interface BrowseChannel {
		id: string;
		name: string;
		description?: string | null;
		is_member: number;
		member_count: number;
	}

	let allChannels = $state<BrowseChannel[]>([]);
	let loading = $state(true);
	let joiningId = $state<string | null>(null);
	let searchQuery = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		searchInput?.focus();
	});

	let filteredChannels = $derived(
		searchQuery.trim()
			? allChannels.filter(c =>
				c.name.toLowerCase().includes(searchQuery.trim().toLowerCase()) ||
				(c.description && c.description.toLowerCase().includes(searchQuery.trim().toLowerCase()))
			)
			: allChannels
	);

	async function loadChannels() {
		loading = true;
		try {
			allChannels = await api.channels.browse();
		} finally {
			loading = false;
		}
	}

	loadChannels();

	async function handleJoin(channelId: string) {
		joiningId = channelId;
		try {
			await channels.join(channelId);
			channels.select(channelId);
			onclose();
		} catch (err) {
			console.error('Failed to join channel:', err);
		} finally {
			joiningId = null;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') onclose();
	}}
	onclick={onclose}
>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div
		class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg w-full max-w-lg mx-4 p-6 max-h-[80vh] flex flex-col"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
			e.stopPropagation();
		}}
	>
		<div class="flex items-start justify-between gap-4 mb-3">
			<h2 class="text-lg font-semibold">Browse channels</h2>
			<button
				type="button"
				onclick={onclose}
				aria-label="Close"
				class="shrink-0 -mr-1 -mt-1 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
			>
				<X size={20} />
			</button>
		</div>

		<input
			type="text"
			placeholder="Search channels..."
			data-testid="browse-search-input"
			bind:this={searchInput}
			bind:value={searchQuery}
			class="w-full px-3 py-2 mb-3 text-sm rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
		/>

		{#if loading}
			<div class="text-sm text-[var(--color-text-muted)] py-4 text-center">Loading...</div>
		{:else if allChannels.length === 0}
			<div class="text-sm text-[var(--color-text-muted)] py-4 text-center">No channels found</div>
		{:else if filteredChannels.length === 0}
			<div class="text-sm text-[var(--color-text-muted)] py-4 text-center">No channels matching "{searchQuery.trim()}"</div>
		{:else}
			<div class="flex-1 overflow-y-auto space-y-1 -mx-2">
				{#each filteredChannels as channel (channel.id)}
					<div class="flex items-center justify-between px-3 py-2 rounded hover:bg-[var(--color-bg-hover)] transition-colors">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="text-[var(--color-text-muted)] text-sm">#</span>
								<span class="text-sm font-medium truncate">{channel.name}</span>
								<span class="text-xs text-[var(--color-text-muted)] shrink-0">
									{channel.member_count} {channel.member_count === 1 ? 'member' : 'members'}
								</span>
							</div>
							{#if channel.description}
								<p class="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{channel.description}</p>
							{/if}
						</div>
						<div class="ml-3 shrink-0">
							{#if channel.is_member}
								<span class="text-xs text-[var(--color-text-muted)] px-2 py-1">Joined</span>
							{:else}
								<button
									onclick={() => handleJoin(channel.id)}
									disabled={joiningId === channel.id}
									class="text-xs px-3 py-1 rounded bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50 font-medium transition-colors"
								>
									{joiningId === channel.id ? 'Joining...' : 'Join'}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="flex justify-end mt-4 pt-3 border-t border-[var(--color-border)]">
			<button
				type="button"
				onclick={onclose}
				class="px-4 py-2 text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors"
			>
				Close
			</button>
		</div>
	</div>
</div>
