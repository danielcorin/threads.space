<script lang="ts">
	import { auth } from '$lib/state/auth.svelte.js';

	let { onsettings }: { onsettings?: () => void } = $props();

	function getInitial(user: typeof auth.user): string {
		if (!user) return '?';
		const name = user.display_name || user.username;
		return name.charAt(0).toUpperCase();
	}

	function getColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = name.charCodeAt(i) + ((hash << 5) - hash);
		}
		const hue = Math.abs(hash) % 360;
		return `hsl(${hue}, 50%, 40%)`;
	}
</script>

<div class="w-full px-3 pt-1.5 pb-safe">
	{#if auth.user}
		<div class="flex w-full items-center gap-1">
			<button
				onclick={() => onsettings?.()}
				class="flex min-w-0 flex-1 items-center rounded px-1 py-1 text-left transition-colors hover:bg-[var(--color-bg-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-bg)]"
				title="Settings"
				aria-label="Open user settings"
			>
				<span
					class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0"
					style="background-color: {getColor(auth.user.username)}"
				>
					{getInitial(auth.user)}
				</span>
				<span class="min-w-0 ml-2">
					<span class="block text-sm font-medium truncate">
						{auth.user.display_name || auth.user.username}
					</span>
					<span class="block text-xs text-[var(--color-text-muted)] truncate">
						{auth.user.username}
					</span>
				</span>
			</button>
		</div>
	{/if}
</div>
