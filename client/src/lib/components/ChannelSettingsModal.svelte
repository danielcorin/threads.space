<script lang="ts">
	import type { Channel } from '$lib/state/channels.svelte.js';
	import { channels } from '$lib/state/channels.svelte.js';
	import { api } from '$lib/api.js';
	import Trash from 'phosphor-svelte/lib/Trash';
	import Modal from './ui/Modal.svelte';
	import Section from './ui/Section.svelte';
	import Banner from './ui/Banner.svelte';
	import Toggle from './ui/Toggle.svelte';
	import Select from './ui/Select.svelte';
	import SegmentedControl from './ui/SegmentedControl.svelte';
	import Button from './ui/Button.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	interface Props {
		channel: Channel;
		onclose: () => void;
		ondelete: () => void;
	}

	let { channel, onclose, ondelete }: Props = $props();
	let confirmingDelete = $state(false);
	let settingsError = $state('');

	function focus(node: HTMLElement) {
		node.focus();
	}

	// Local mirrors of the channel settings. Each control auto-saves on change;
	// this $effect re-seeds them from the channel (initial open + external
	// updates). Saved values match what we wrote, so it never clobbers edits.
	let editDescValue = $state('');
	let processingModeValue = $state('immediate');
	let boardEnabledValue = $state(false);
	let autoRespondBotId = $state('');
	let notificationTier = $state<'all' | 'mentions' | 'none'>('all');

	$effect(() => {
		editDescValue = channel.description || '';
		processingModeValue = channel.processing_mode || (channel.auto_respond_bot_id ? 'serial' : 'immediate');
		boardEnabledValue = channel.board_enabled ? true : false;
		autoRespondBotId = channel.auto_respond_bot_id ?? '';
		notificationTier = (channel.notifications as 'all' | 'mentions' | 'none') || 'all';
	});

	interface BotMember {
		id: string;
		username: string;
		display_name: string | null;
	}

	let botMembers = $state<BotMember[]>([]);

	$effect(() => {
		api.channels.members(channel.id).then((members: any[]) => {
			botMembers = members.filter((m: any) => m.role === 'bot');
		});
	});

	async function saveField(patch: {
		description?: string;
		processing_mode?: string;
		board_enabled?: number;
		auto_respond_bot_id?: string | null;
	}) {
		settingsError = '';
		try {
			await channels.updateSettings(channel.id, patch);
		} catch (err: any) {
			settingsError = err.message || 'Failed to save channel settings';
		}
	}

	function saveDescription() {
		const trimmed = editDescValue.trim();
		if ((channel.description || '') === trimmed) return;
		saveField({ description: trimmed });
	}

	function handleBotChange(value: string) {
		const id = value || null;
		autoRespondBotId = value;
		// Picking a bot with immediate processing switches to serial by default.
		if (id && processingModeValue === 'immediate') processingModeValue = 'serial';
		saveField({ auto_respond_bot_id: id, processing_mode: id ? processingModeValue : 'immediate' });
	}

	function handleModeChange(value: string) {
		processingModeValue = value;
		saveField({ processing_mode: value });
	}

	function handleBoardToggle() {
		boardEnabledValue = !boardEnabledValue;
		saveField({ board_enabled: boardEnabledValue ? 1 : 0 });
	}

	function handleNotifChange(value: 'all' | 'mentions' | 'none') {
		notificationTier = value;
		channels.updateNotifications(channel.id, value);
	}

	async function promoteEphemeralChannel() {
		const nextName = window.prompt('Promote to channel', channel.name);
		if (nextName === null) return;
		await channels.promote(channel.id, nextName.trim() || channel.name);
		onclose();
	}

	async function restoreEphemeralChannel() {
		await channels.unarchive(channel.id);
		onclose();
	}

	const modeOptions = [
		{ value: 'serial', label: 'Serial' },
		{ value: 'immediate', label: 'Immediate' }
	];
	const notifOptions: { value: 'all' | 'mentions' | 'none'; label: string }[] = [
		{ value: 'all', label: 'All messages' },
		{ value: 'mentions', label: 'Mentions only' },
		{ value: 'none', label: 'Muted' }
	];
</script>

<Modal onclose={() => onclose()} title="Channel settings" size="md">
	{#if settingsError}<Banner variant="error">{settingsError}</Banner>{/if}

	<div>
		<label for="channel-description" class="block text-sm font-medium mb-1">Description</label>
		<textarea
			id="channel-description"
			bind:value={editDescValue}
			onblur={saveDescription}
			class="w-full bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)] resize-none"
			rows="4"
			placeholder="What's this channel about?"
			use:focus
		></textarea>
	</div>

	{#if botMembers.length > 0}
		<Section title="Auto-respond bot" description="Select a bot to auto-respond to all messages, or none for mention-only.">
			<Select bind:value={autoRespondBotId} onchange={handleBotChange}>
				<option value="">— none (mention only) —</option>
				{#each botMembers as bot (bot.id)}
					<option value={bot.id}>{bot.display_name || bot.username}</option>
				{/each}
			</Select>
		</Section>

		{#if autoRespondBotId}
			<Section title="Processing mode" description="How messages are handled when auto-respond is enabled.">
				<SegmentedControl options={modeOptions} value={processingModeValue} onchange={handleModeChange} />
			</Section>
		{/if}
	{/if}

	<Section title="Board">
		<div class="flex items-center justify-between gap-3">
			<div>
				<div class="text-sm font-medium">Show board</div>
				<div class="text-xs text-[var(--color-text-muted)]">Enable kanban board for this channel</div>
			</div>
			<Toggle checked={boardEnabledValue} onchange={handleBoardToggle} label="Toggle channel board" />
		</div>
	</Section>

	<!-- Notifications tier — non-DM channels only; DM tier UI is a follow-up -->
	<Section
		title="Notifications"
		description="Choose which messages push to your devices and mark this channel as unread. Mute to silence it entirely."
	>
		<SegmentedControl options={notifOptions} value={notificationTier} onchange={handleNotifChange} />
	</Section>

	{#if channel.is_ephemeral}
		<Section title="Ephemeral channel">
			{#if channel.archived_at}
				<button
					type="button"
					onclick={restoreEphemeralChannel}
					class="px-3 py-1.5 text-sm rounded text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
				>
					Restore channel
				</button>
			{:else}
				<button
					type="button"
					onclick={promoteEphemeralChannel}
					class="px-3 py-1.5 text-sm rounded text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
				>
					Promote to channel…
				</button>
			{/if}
		</Section>
	{/if}

	{#snippet footer()}
		<Button variant="ghost" size="sm" class="mr-auto" onclick={() => (confirmingDelete = true)}>
			<Trash size={14} /> Delete channel
		</Button>
		<Button variant="secondary" onclick={() => onclose()}>Done</Button>
	{/snippet}
</Modal>

{#if confirmingDelete}
	<ConfirmDialog
		title="Delete channel"
		message={`Delete #${channel.name}? All messages in this channel will be removed.`}
		warning="This cannot be undone."
		confirmLabel="Delete"
		onconfirm={() => {
			confirmingDelete = false;
			ondelete();
		}}
		oncancel={() => (confirmingDelete = false)}
	/>
{/if}
