<script lang="ts">
	import { onDestroy } from 'svelte';
	import SignOut from 'phosphor-svelte/lib/SignOut';
	import Check from 'phosphor-svelte/lib/Check';
	import { api } from '$lib/api.js';
	import { auth } from '$lib/state/auth.svelte.js';
	import Section from '../ui/Section.svelte';
	import Banner from '../ui/Banner.svelte';
	import Field from '../ui/Field.svelte';
	import Button from '../ui/Button.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	// Profile — auto-saved. Display name persists on blur; color persists on
	// selection. `lastSaved*` guards against redundant PATCHes.
	let displayName = $state(auth.user?.display_name ?? auth.user?.username ?? '');
	let nameColor = $state(auth.user?.name_color ?? '');
	let customColor = $state(auth.user?.name_color ?? '#e74c3c');
	let profileError = $state('');
	let profileStatus = $state<'idle' | 'saving' | 'saved'>('idle');
	let lastSavedName = $state((auth.user?.display_name ?? auth.user?.username ?? '').trim());
	let lastSavedColor = $state(auth.user?.name_color ?? '');
	let savedTimer: ReturnType<typeof setTimeout> | undefined;

	const presetColors = [
		'#e74c3c',
		'#e67e22',
		'#f1c40f',
		'#2ecc71',
		'#1abc9c',
		'#3498db',
		'#9b59b6',
		'#e91e63',
		'#795548',
	];

	let previewName = $derived(displayName.trim() || auth.user?.username || 'Preview');

	async function saveProfile() {
		const trimmed = displayName.trim();
		if (!trimmed) {
			profileError = 'Display name is required';
			return;
		}
		if (trimmed === lastSavedName && nameColor === lastSavedColor) return;

		profileError = '';
		profileStatus = 'saving';
		try {
			const result = await api.users.updateProfile({
				displayName: trimmed,
				nameColor: nameColor || null,
			});
			auth.updateDisplayName(result.displayName || null);
			auth.updateNameColor(result.nameColor || null);
			lastSavedName = trimmed;
			lastSavedColor = nameColor;
			profileStatus = 'saved';
			clearTimeout(savedTimer);
			savedTimer = setTimeout(() => {
				if (profileStatus === 'saved') profileStatus = 'idle';
			}, 1500);
		} catch (err: any) {
			profileError = err.message || 'Failed to update profile';
			profileStatus = 'idle';
		}
	}

	function selectColor(color: string) {
		nameColor = color;
		customColor = color;
		saveProfile();
	}

	function resetColor() {
		nameColor = '';
		saveProfile();
	}

	function handleCustomColorInput(e: Event) {
		// Live preview while dragging the picker; the save happens on `change`.
		const value = (e.target as HTMLInputElement).value;
		customColor = value;
		nameColor = value;
	}

	function handleCustomColorCommit(e: Event) {
		const value = (e.target as HTMLInputElement).value;
		customColor = value;
		nameColor = value;
		saveProfile();
	}

	onDestroy(() => clearTimeout(savedTimer));

	async function handleLogout() {
		onclose();
		await auth.logout();
	}
</script>

<Section first title="Profile" description="How your name appears in messages. Changes save automatically.">
	{#if profileError}<Banner variant="error">{profileError}</Banner>{/if}

	<Field
		id="settings-display-name"
		label="Display name"
		bind:value={displayName}
		maxlength={100}
		placeholder="Your display name"
		onblur={saveProfile}
	/>

	<div class="mt-3">
		<div class="block text-sm font-medium mb-2">Name color</div>
		<div class="flex flex-wrap gap-2">
			{#each presetColors as color (color)}
				<button
					type="button"
					onclick={() => selectColor(color)}
					class="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
					style:background-color={color}
					style:border-color={nameColor === color ? 'white' : 'transparent'}
					title={color}
					aria-label={`Use color ${color}`}
				></button>
			{/each}
			<label
				class="w-7 h-7 rounded-full border-2 overflow-hidden cursor-pointer relative hover:scale-110 transition-transform"
				style:border-color={nameColor && !presetColors.includes(nameColor) ? 'white' : 'transparent'}
				title="Custom color"
			>
				<input
					type="color"
					value={customColor}
					oninput={handleCustomColorInput}
					onchange={handleCustomColorCommit}
					class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
				/>
				<div
					class="w-full h-full"
					style:background="conic-gradient(red, yellow, lime, aqua, blue, magenta, red)"
				></div>
			</label>
		</div>
		{#if nameColor}
			<button
				type="button"
				onclick={resetColor}
				class="mt-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
			>
				Reset to default
			</button>
		{/if}
	</div>

	<div class="bg-[var(--color-bg-input)] border border-[var(--color-border)] rounded px-3 py-2 mt-3">
		<div class="text-xs text-[var(--color-text-muted)] mb-1">Preview</div>
		<span class="font-semibold text-sm" style:color={nameColor || undefined}>{previewName}</span>
		<span class="text-[var(--color-text-muted)] text-sm ml-2">Hello, this is a preview message!</span>
	</div>

	<div class="h-4 mt-2 text-xs" aria-live="polite">
		{#if profileStatus === 'saving'}
			<span class="text-[var(--color-text-muted)]">Saving…</span>
		{:else if profileStatus === 'saved'}
			<span class="inline-flex items-center gap-1 text-[var(--color-success)]"><Check size={12} /> Saved</span>
		{/if}
	</div>
</Section>

<Section title="Session" description="You are signed in as {auth.user?.username}.">
	<Button variant="ghost" size="sm" class="w-full" onclick={handleLogout}>
		<SignOut size={16} /> Sign out
	</Button>
</Section>
