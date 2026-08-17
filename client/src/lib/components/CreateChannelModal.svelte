<script lang="ts">
	import { onMount } from 'svelte';
	import { channels } from '$lib/state/channels.svelte.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Lock from 'phosphor-svelte/lib/Lock';
	import Modal from './ui/Modal.svelte';
	import Banner from './ui/Banner.svelte';
	import Field from './ui/Field.svelte';
	import Button from './ui/Button.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	let nameInputEl: HTMLInputElement | undefined = $state();

	onMount(() => {
		nameInputEl?.focus();
	});

	let name = $state('');
	let description = $state('');
	let isPrivate = $state(false);
	let error = $state('');
	let loading = $state(false);

	const canCreatePrivate = $derived(!!auth.user?.is_admin);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
		if (!trimmed) return;

		error = '';
		loading = true;
		try {
			const channel = await channels.create(trimmed, description.trim() || undefined, isPrivate || undefined);
			channels.select(channel.id);
			onclose();
		} catch (err: any) {
			error = err.message || 'Failed to create channel';
		} finally {
			loading = false;
		}
	}
</script>

<Modal {onclose} title="Create a channel" size="md">
	<form onsubmit={handleSubmit} class="space-y-4">
		{#if error}<Banner variant="error">{error}</Banner>{/if}

		<div>
			<label for="channel-name" class="block text-sm font-medium mb-1">Name</label>
			<div class="flex items-center">
				<span class="text-[var(--color-text-muted)] mr-1">{isPrivate ? '' : '#'}</span>
				{#if isPrivate}
					<span class="text-[var(--color-text-muted)] mr-1 shrink-0"><Lock size={16} /></span>
				{/if}
				<input
					bind:this={nameInputEl}
					id="channel-name"
					type="text"
					bind:value={name}
					class="flex-1 bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
					placeholder="e.g. general"
				/>
			</div>
		</div>

		<Field
			id="channel-desc"
			label="Description"
			hint="(optional)"
			bind:value={description}
			placeholder="What's this channel about?"
		/>

		{#if canCreatePrivate}
			<label class="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					bind:checked={isPrivate}
					class="w-4 h-4 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
				/>
				<span class="text-sm">Private channel</span>
				<span class="text-xs text-[var(--color-text-muted)]">-- only visible to members</span>
			</label>
		{/if}

		<div class="flex justify-end gap-2">
			<Button variant="secondary" onclick={onclose}>Cancel</Button>
			<Button variant="primary" type="submit" disabled={loading || !name.trim()}>
				{loading ? 'Creating…' : 'Create'}
			</Button>
		</div>
	</form>
</Modal>
