<script lang="ts">
	interface ChannelInfo {
		id: string;
		name: string;
	}

	interface Props {
		channels: ChannelInfo[];
		query: string;
		onselect: (channelName: string) => void;
		visible: boolean;
	}

	let { channels, query, onselect, visible }: Props = $props();

	let selectedIndex = $state(0);

	let filtered = $derived(
		query
			? channels.filter((c) =>
					c.name.toLowerCase().startsWith(query.toLowerCase())
				)
			: channels
	);

	// Reset selection when filtered list changes
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		filtered;
		selectedIndex = 0;
	});

	export function handleKeydown(e: KeyboardEvent): boolean {
		if (!visible || filtered.length === 0) return false;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % filtered.length;
			return true;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
			return true;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			onselect(filtered[selectedIndex].name);
			return true;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			onselect('');
			return true;
		}
		return false;
	}
</script>

{#if visible && filtered.length > 0}
	<div
		class="absolute bottom-full left-0 right-0 mb-1 bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-lg max-h-48 overflow-y-auto z-50"
	>
		{#each filtered as channel, i (channel.id)}
			<button
				type="button"
				class="w-full px-3 py-2 text-left flex items-center gap-2 text-sm hover:bg-[var(--color-bg-hover)] transition-colors {i === selectedIndex ? 'bg-[var(--color-bg-hover)]' : ''}"
				onmousedown={(e: MouseEvent) => { e.preventDefault(); onselect(channel.name); }}
			>
				<span class="font-medium text-[var(--color-text)]">#{channel.name}</span>
			</button>
		{/each}
	</div>
{/if}
