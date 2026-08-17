<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth } from '$lib/state/auth.svelte.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { codeTheme } from '$lib/state/codeTheme.svelte.js';

	let { children } = $props();

	onMount(() => {
		const cleanupUi = ui.init();
		auth.checkSession();

		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js');
		}

		return () => {
			cleanupUi();
		};
	});

	$effect(() => {
		if (auth.checked && !auth.loggedIn && page.url.pathname !== '/login') {
			goto(resolve('/login'));
		}
	});

	// Hydrate the code theme from the user profile when auth lands. Reading
	// auth.user makes this re-run on login/logout.
	$effect(() => {
		const u = auth.user;
		if (u) {
			codeTheme.hydrate(u.code_theme);
		}
	});
</script>

{#if !auth.checked || (!auth.loggedIn && page.url.pathname !== '/login')}
	<div class="h-full flex items-center justify-center bg-[var(--color-bg)]">
		<div class="text-[var(--color-text-muted)] text-sm">Loading...</div>
	</div>
{:else}
	{@render children()}
{/if}
