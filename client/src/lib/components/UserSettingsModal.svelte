<script lang="ts">
	import { auth } from '$lib/state/auth.svelte.js';
	import Modal from './ui/Modal.svelte';
	import Button from './ui/Button.svelte';
	import ProfileTab from './settings/ProfileTab.svelte';
	import SecurityTab from './settings/SecurityTab.svelte';
	import PreferencesTab from './settings/PreferencesTab.svelte';
	import AdminTab from './settings/AdminTab.svelte';
	import DeveloperTab from './settings/DeveloperTab.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	const isAdmin = $derived(!!auth.user?.is_admin);

	type Tab = 'profile' | 'security' | 'preferences' | 'admin' | 'developer';

	// Returning from an email-confirmation link lands directly on Security,
	// where SecurityTab shows the result.
	const returningFromEmailVerification =
		typeof location !== 'undefined' &&
		new URL(location.href).searchParams.get('email_verified') === '1';
	let activeTab = $state<Tab>(returningFromEmailVerification ? 'security' : 'profile');

	const tabs = $derived<{ id: Tab; label: string; blurb: string }[]>([
		{ id: 'profile', label: 'Profile', blurb: 'How you appear to others, and your session.' },
		{ id: 'security', label: 'Security', blurb: 'Recovery email, authenticator app, and password.' },
		{ id: 'preferences', label: 'Preferences', blurb: 'Notifications and personal defaults.' },
		...(isAdmin
			? [
					{ id: 'admin' as const, label: 'Admin', blurb: 'Workspace-wide security policy and members.' },
					{ id: 'developer' as const, label: 'Developer', blurb: 'API access and agent integration.' }
				]
			: [])
	]);

	const activeBlurb = $derived(tabs.find((t) => t.id === activeTab)?.blurb ?? '');

	const tabClass = (active: boolean) =>
		`shrink-0 whitespace-nowrap px-2 sm:px-3 py-2 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors ${active
			? 'border-[var(--color-accent)] text-[var(--color-text)]'
			: 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`;
</script>

<Modal {onclose} title="Settings" size="lg">
	<div class="scrollbar-hidden flex gap-0 sm:gap-1 overflow-x-auto border-b border-[var(--color-border)] mb-2" role="tablist" aria-label="Settings sections">
		{#each tabs as tab (tab.id)}
			<button
				type="button"
				role="tab"
				aria-selected={activeTab === tab.id}
				onclick={() => (activeTab = tab.id)}
				class={tabClass(activeTab === tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>
	<p class="text-xs text-[var(--color-text-muted)] mb-5">{activeBlurb}</p>

	<!-- All panels stay mounted (hidden via CSS) so in-progress forms — an MFA
	     enrollment mid-scan, a half-typed token name — survive tab switches. -->
	<div class:hidden={activeTab !== 'profile'}><ProfileTab {onclose} /></div>
	<div class:hidden={activeTab !== 'security'}><SecurityTab /></div>
	<div class:hidden={activeTab !== 'preferences'}><PreferencesTab /></div>
	{#if isAdmin}
		<div class:hidden={activeTab !== 'admin'}><AdminTab /></div>
		<div class:hidden={activeTab !== 'developer'}><DeveloperTab /></div>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" onclick={onclose}>Done</Button>
	{/snippet}
</Modal>
