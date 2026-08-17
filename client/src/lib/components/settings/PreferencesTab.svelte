<script lang="ts">
	import { onMount } from 'svelte';
	import Bell from 'phosphor-svelte/lib/Bell';
	import BellSlash from 'phosphor-svelte/lib/BellSlash';
	import { api } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import { codeTheme, CODE_THEMES } from '$lib/state/codeTheme.svelte.js';
	import {
		preparePushNotifications,
		subscribeToPush,
		unsubscribeFromPush,
		isPushSubscribed,
		getUnsupportedPushBrowserMessage
	} from '$lib/push.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Select from '../ui/Select.svelte';

	// Push notifications.
	let pushSubscribed = $state(false);
	let pushLoading = $state(false);
	let pushError = $state('');
	let pushPermission = $state<NotificationPermission | 'unsupported'>('default');

	function refreshPushPermission() {
		const unsupportedMessage = getUnsupportedPushBrowserMessage();
		if (unsupportedMessage) {
			pushPermission = 'unsupported';
			pushError = unsupportedMessage;
			return;
		}
		if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
			pushPermission = 'unsupported';
			return;
		}
		pushPermission = Notification.permission;
	}

	function deniedPushMessage() {
		const site = typeof location !== 'undefined' ? location.host : 'this site';
		return `Browser notification permission is blocked for Threads. Enable notifications for ${site} in your browser/site settings, then try again.`;
	}

	async function togglePush() {
		if (pushLoading) return;
		refreshPushPermission();
		if (!pushSubscribed && pushPermission === 'unsupported') {
			pushError = 'Push notifications are not supported in this browser.';
			return;
		}
		if (!pushSubscribed && pushPermission === 'denied') {
			pushError = deniedPushMessage();
			return;
		}

		pushLoading = true;
		pushError = '';
		try {
			if (pushSubscribed) {
				await unsubscribeFromPush();
				pushSubscribed = false;
			} else {
				const ok = await subscribeToPush();
				refreshPushPermission();
				pushSubscribed = ok;
				if (!ok) {
					pushError = pushPermission === 'denied'
						? deniedPushMessage()
						: 'Push notifications were not enabled. If prompted, choose Allow and try again.';
				}
			}
		} catch (err: any) {
			refreshPushPermission();
			pushError = err.message || 'Failed to update notification settings';
		} finally {
			pushLoading = false;
		}
	}

	// Code theme — mirror the rune-backed value into a local for the <select>
	// binding; changes flow back through codeTheme.set().
	let selectedCodeTheme = $state(codeTheme.value);

	function handleCodeThemeChange(value: string) {
		codeTheme.set(value);
	}

	// Ephemeral-channel default bot (users.ephemeral_bot_id): the bot auto-added
	// to ephemeral channels this user creates. Empty = no bot.
	type Bot = { id: string; username: string; display_name: string | null };
	let bots = $state<Bot[]>([]);
	let selectedEphemeralBotId = $state(auth.user?.ephemeral_bot_id ?? '');
	let ephemeralBotError = $state('');
	let ephemeralBotSaving = $state(false);

	async function handleEphemeralBotChange(value: string) {
		ephemeralBotError = '';
		ephemeralBotSaving = true;
		try {
			const result = await api.users.updateProfile({ ephemeralBotId: value || null });
			auth.updateEphemeralBotId(result.ephemeralBotId ?? null);
		} catch (err: any) {
			ephemeralBotError = err.message || 'Failed to update default bot';
		} finally {
			ephemeralBotSaving = false;
		}
	}

	onMount(async () => {
		refreshPushPermission();
		preparePushNotifications();
		pushSubscribed = await isPushSubscribed();

		// Populate the default-bot picker. Fetch fresh /users/me too because the
		// cached auth user (from localStorage / login) may predate this setting.
		try {
			const me = await api.users.me();
			selectedEphemeralBotId = me?.ephemeral_bot_id ?? '';
			auth.updateEphemeralBotId(me?.ephemeral_bot_id ?? null);
		} catch {
			// Non-fatal: leave the picker on its cached value.
		}
		try {
			bots = (await api.users.listBots()) ?? [];
		} catch {
			// Non-fatal: leave the picker empty.
		}
	});
</script>

<Section first title="Notifications" description="What this device tells you about, even when Threads is closed.">
	<div class="flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<span class="w-4 flex items-center justify-center text-[var(--color-text-muted)]">
				{#if pushSubscribed}<Bell size={16} />{:else}<BellSlash size={16} />{/if}
			</span>
			<div>
				<div class="text-sm font-medium">Push notifications</div>
				<div class="text-xs text-[var(--color-text-muted)]">Get notified about new messages on this device</div>
			</div>
		</div>
		<Toggle
			checked={pushSubscribed}
			disabled={pushLoading || (pushPermission === 'unsupported' && !!pushError)}
			onchange={togglePush}
			label="Toggle push notifications"
		/>
	</div>
	{#if pushError}
		<div class="mt-2 text-xs text-[var(--color-danger)]">{pushError}</div>
	{:else if pushPermission === 'denied'}
		<div class="mt-2 text-xs text-amber-500">
			Notifications are blocked in this browser. Re-enable them in site settings to use this toggle.
		</div>
	{/if}
</Section>

<Section title="Code theme" description="Syntax highlighting for code blocks in messages.">
	<Select bind:value={selectedCodeTheme} onchange={handleCodeThemeChange}>
		{#each CODE_THEMES as theme (theme.key)}
			<option value={theme.key}>{theme.label}</option>
		{/each}
	</Select>
</Section>

<Section
	title="Ephemeral channel bot"
	description="Automatically added to new ephemeral channels you create. Choose “— None —” to add no bot."
>
	{#if ephemeralBotError}<Banner variant="error">{ephemeralBotError}</Banner>{/if}
	<Select bind:value={selectedEphemeralBotId} disabled={ephemeralBotSaving} onchange={handleEphemeralBotChange}>
		<option value="">— None —</option>
		{#each bots as bot (bot.id)}
			<option value={bot.id}>{bot.display_name || bot.username}</option>
		{/each}
	</Select>
</Section>
