<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { auth } from '$lib/state/auth.svelte.js';
	import Login from '$lib/components/Login.svelte';

	$effect(() => {
		if (auth.loggedIn) {
			goto(resolve('/'));
		}
	});
</script>

<Login />
