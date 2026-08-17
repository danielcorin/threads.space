<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api.js';
	import { dms } from '$lib/state/dms.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import MagnifyingGlass from 'phosphor-svelte/lib/MagnifyingGlass';
	import ChatCircleDots from 'phosphor-svelte/lib/ChatCircleDots';
	import Robot from 'phosphor-svelte/lib/Robot';
	import Modal from './ui/Modal.svelte';
	import Banner from './ui/Banner.svelte';
	import Button from './ui/Button.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	let searchInputEl: HTMLInputElement | undefined = $state();
	let query = $state('');
	let results = $state<any[]>([]);
	let loading = $state(false);
	let error = $state('');
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		searchInputEl?.focus();
		searchUsers('');
	});

	function searchUsers(q: string) {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			loading = true;
			error = '';
			try {
				results = await api.users.search(q);
			} catch (err: any) {
				error = err.message || 'Failed to search users';
				results = [];
			} finally {
				loading = false;
			}
		}, q ? 200 : 0);
	}

	$effect(() => {
		searchUsers(query);
	});

	async function selectUser(userId: string) {
		loading = true;
		error = '';
		try {
			const dm = await dms.openDM(userId);
			dms.select(dm.id);
			if (ui.isMobile) ui.closeSidebar();
			onclose();
		} catch (err: any) {
			error = err.message || 'Failed to open DM';
		} finally {
			loading = false;
		}
	}
</script>

<Modal {onclose} title="New message" size="md">
	{#if error}<Banner variant="error">{error}</Banner>{/if}

	<div class="relative mb-4">
		<span class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
			<MagnifyingGlass size={16} />
		</span>
		<input
			bind:this={searchInputEl}
			type="text"
			bind:value={query}
			class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 pl-9 text-sm focus:outline-none focus:border-[var(--color-accent)]"
			placeholder="Search for a user..."
		/>
	</div>

	<div class="max-h-64 overflow-y-auto space-y-0.5">
		{#if loading && results.length === 0}
			<div class="px-3 py-4 text-sm text-[var(--color-text-muted)] text-center">Searching...</div>
		{:else if results.length === 0 && query}
			<div class="px-3 py-4 text-sm text-[var(--color-text-muted)] text-center">No users found</div>
		{:else}
			{#each results as user (user.id)}
				<button
					onclick={() => selectUser(user.id)}
					class="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded text-sm transition-colors hover:bg-[var(--color-bg-hover)]"
				>
					<span class="w-5 shrink-0 flex items-center justify-center text-[var(--color-text-muted)]">
						{#if user.role === 'bot'}
							<Robot size={16} />
						{:else}
							<ChatCircleDots size={16} />
						{/if}
					</span>
					<div class="min-w-0">
						<span class="font-medium">{user.display_name || user.username}</span>
						{#if user.display_name}
							<span class="text-[var(--color-text-muted)] ml-1">@{user.username}</span>
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
