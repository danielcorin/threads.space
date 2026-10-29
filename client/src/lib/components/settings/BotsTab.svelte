<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Button from '../ui/Button.svelte';
	import Field from '../ui/Field.svelte';
	import Select from '../ui/Select.svelte';
	import ApiTokenManager from './ApiTokenManager.svelte';

	type Bot = Awaited<ReturnType<typeof api.users.listBots>>[number];
	let bots = $state<Bot[]>([]);
	let selectedId = $state('');
	const selectedBot = $derived(bots.find((bot) => bot.id === selectedId));
	let loading = $state(false);
	let error = $state('');
	let showCreate = $state(false);
	let username = $state('');
	let displayName = $state('');
	let creating = $state(false);

	async function loadBots() {
		loading = true;
		error = '';
		try {
			bots = await api.users.listBots();
			if (!bots.some((bot) => bot.id === selectedId)) selectedId = bots[0]?.id ?? '';
		} catch (err: any) {
			error = err.message || 'Failed to load bots';
		} finally {
			loading = false;
		}
	}

	async function createBot() {
		creating = true;
		error = '';
		try {
			const bot = await api.users.create({
				username: username.trim(),
				displayName: displayName.trim() || undefined,
				role: 'bot',
				password: crypto.randomUUID()
			});
			bots = [...bots, { id: bot.id, username: bot.username, display_name: bot.displayName, name_color: null, avatar_url: null }];
			selectedId = bot.id;
			username = '';
			displayName = '';
			showCreate = false;
		} catch (err: any) {
			error = err.message || 'Failed to create bot';
		} finally {
			creating = false;
		}
	}

	onMount(loadBots);
</script>

<Section first title="Bot accounts" description="Create a bot or select an existing one to manage its runtime tokens. Your agent uses the token to connect to this workspace.">
	{#if error}<Banner variant="error">{error}</Banner>{/if}
	{#if bots.length}
		<Select id="settings-bot" label="Bot" bind:value={selectedId} disabled={creating}>
			{#each bots as bot (bot.id)}
				<option value={bot.id}>{bot.display_name || bot.username} (@{bot.username})</option>
			{/each}
		</Select>
	{:else if loading}
		<p class="text-sm text-[var(--color-text-muted)]">Loading bots…</p>
	{:else}
		<p class="text-sm text-[var(--color-text-muted)]">No bots yet. Create one to get started.</p>
	{/if}
	<div class="flex gap-2 mt-3">
		<Button variant="secondary" size="sm" onclick={() => (showCreate = !showCreate)} disabled={creating}>
			{showCreate ? 'Cancel' : 'New bot'}
		</Button>
		<Button variant="secondary" size="sm" onclick={loadBots} disabled={loading || creating}>Refresh bots</Button>
	</div>
	{#if showCreate}
		<div class="mt-4 space-y-3 rounded border border-[var(--color-border)] p-3">
			<Field id="new-bot-username" label="Bot username" bind:value={username} maxlength={100} autocomplete="off" placeholder="e.g. aster" />
			<Field id="new-bot-display-name" label="Bot display name" hint="(optional)" bind:value={displayName} maxlength={100} />
			<Button variant="primary" onclick={createBot} disabled={creating || !username.trim()}>
				{creating ? 'Creating…' : 'Create bot'}
			</Button>
		</div>
	{/if}
</Section>

{#if selectedBot}
	<p class="text-xs text-[var(--color-text-muted)] mt-3 break-all">Bot user ID: <code class="select-all">{selectedBot.id}</code></p>
	<div class="mt-6 pt-6 border-t border-[var(--color-border)]">
		{#key selectedBot.id}
			<ApiTokenManager userId={selectedBot.id} username={selectedBot.username} />
		{/key}
	</div>
{/if}
