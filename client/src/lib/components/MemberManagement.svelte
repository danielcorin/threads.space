<script lang="ts">
	import { api } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import X from 'phosphor-svelte/lib/X';

	interface Props {
		channelId: string;
		isPrivate: boolean;
		onclose: () => void;
	}

	let { channelId, isPrivate: _isPrivate, onclose }: Props = $props();

	interface Member {
		id: string;
		username: string;
		display_name: string | null;
		avatar_url: string | null;
	}

	interface SearchResult {
		id: string;
		username: string;
		display_name: string | null;
		avatar_url: string | null;
	}

	let members = $state<Member[]>([]);
	let loading = $state(true);
	let addQuery = $state('');
	let addError = $state('');
	let addLoading = $state(false);
	let removingId = $state<string | null>(null);

	// Search autocomplete state
	let searchResults = $state<SearchResult[]>([]);
	let searchLoading = $state(false);
	let showDropdown = $state(false);
	let selectedIndex = $state(0);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function loadMembers() {
		loading = true;
		try {
			members = await api.channels.members(channelId);
		} finally {
			loading = false;
		}
	}

	loadMembers();

	function handleInput() {
		addError = '';
		const query = addQuery.trim();
		if (!query) {
			searchResults = [];
			showDropdown = false;
			return;
		}

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => searchUsers(query), 200);
	}

	async function searchUsers(query: string) {
		searchLoading = true;
		showDropdown = true;
		try {
			const results = await api.users.search(query, channelId);
			// Filter out users who are already members (client-side backup)
			const memberIds = new Set(members.map((m) => m.id));
			searchResults = results.filter((u: SearchResult) => !memberIds.has(u.id));
			selectedIndex = 0;
		} catch (err: any) {
			searchResults = [];
			addError = err.message || 'Search failed';
		} finally {
			searchLoading = false;
		}
	}

	async function addUser(user: SearchResult) {
		addError = '';
		addLoading = true;
		showDropdown = false;
		try {
			await api.channels.addMemberByUsername(channelId, user.username);
			addQuery = '';
			searchResults = [];
			await loadMembers();
		} catch (err: any) {
			addError = err.message || 'Failed to add member';
		} finally {
			addLoading = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!showDropdown || searchResults.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % searchResults.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			addUser(searchResults[selectedIndex]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			showDropdown = false;
		}
	}

	function handleBlur() {
		// Delay to allow click on dropdown items
		setTimeout(() => {
			showDropdown = false;
		}, 150);
	}

	async function handleRemoveMember(userId: string) {
		removingId = userId;
		try {
			await api.channels.removeMember(channelId, userId);
			members = members.filter((m) => m.id !== userId);
			// If user removed themselves, reload channels and close
			if (userId === auth.user?.id) {
				await channels.load();
				onclose();
			}
		} catch (err) {
			console.error('Failed to remove member:', err);
		} finally {
			removingId = null;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape' && !showDropdown) onclose();
	}}
	onclick={onclose}
>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div
		class="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg w-full max-w-md mx-4 p-6 max-h-[80vh] flex flex-col"
		onclick={(e: MouseEvent) => e.stopPropagation()}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape' && !showDropdown) onclose();
			e.stopPropagation();
		}}
	>
		<div class="flex items-start justify-between gap-4 mb-4">
			<h2 class="text-lg font-semibold">Channel members</h2>
			<button
				type="button"
				onclick={onclose}
				aria-label="Close"
				class="shrink-0 -mr-1 -mt-1 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
			>
				<X size={20} />
			</button>
		</div>

		<div class="mb-4">
				{#if addError}
					<div class="bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 rounded px-3 py-2 text-sm text-[var(--color-danger)] mb-2">
						{addError}
					</div>
				{/if}
				<div class="relative">
					<input
						type="text"
						bind:value={addQuery}
						oninput={handleInput}
						onkeydown={handleKeydown}
						onblur={handleBlur}
						onfocus={() => { if (addQuery.trim() && searchResults.length > 0) showDropdown = true; }}
						placeholder="Search users to add..."
						disabled={addLoading}
						class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
					/>
					{#if showDropdown}
						<div class="absolute top-full left-0 right-0 mt-1 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
							{#if searchLoading}
								<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">Searching...</div>
							{:else if searchResults.length === 0}
								<div class="px-3 py-2 text-sm text-[var(--color-text-muted)]">No users found</div>
							{:else}
								{#each searchResults as user, i (user.id)}
									<button
										type="button"
										class="w-full px-3 py-2 text-left flex items-center gap-2 text-sm hover:bg-[var(--color-bg-hover)] transition-colors {i === selectedIndex ? 'bg-[var(--color-bg-hover)]' : ''}"
										onmousedown={(e: MouseEvent) => { e.preventDefault(); addUser(user); }}
									>
										<div class="w-6 h-6 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center text-xs font-medium shrink-0">
											{(user.display_name || user.username).charAt(0).toUpperCase()}
										</div>
										<div class="min-w-0">
											<span class="font-medium text-[var(--color-text)]">{user.display_name || user.username}</span>
											{#if user.display_name}
												<span class="text-[var(--color-text-muted)] ml-1">@{user.username}</span>
											{:else}
												<span class="text-[var(--color-text-muted)] ml-1">@{user.username}</span>
											{/if}
										</div>
									</button>
								{/each}
							{/if}
						</div>
					{/if}
				</div>
			</div>

		{#if loading}
			<div class="text-sm text-[var(--color-text-muted)] py-4 text-center">Loading...</div>
		{:else}
			<div class="flex-1 overflow-y-auto space-y-1 -mx-2">
				{#each members as member (member.id)}
					<div class="flex items-center justify-between px-3 py-2 rounded hover:bg-[var(--color-bg-hover)] transition-colors">
						<div class="flex items-center gap-2 min-w-0">
							<div class="w-7 h-7 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center text-xs font-medium shrink-0">
								{(member.display_name || member.username).charAt(0).toUpperCase()}
							</div>
							<div class="min-w-0">
								<div class="text-sm font-medium truncate">{member.display_name || member.username}</div>
								{#if member.display_name}
									<div class="text-xs text-[var(--color-text-muted)] truncate">@{member.username}</div>
								{/if}
							</div>
						</div>
						{#if member.id !== auth.user?.id}
							<button
								onclick={() => handleRemoveMember(member.id)}
								disabled={removingId === member.id}
								class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors ml-2 shrink-0 disabled:opacity-50"
								title="Remove member"
							>
								{removingId === member.id ? '...' : 'Remove'}
							</button>
						{/if}
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
