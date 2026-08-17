<script lang="ts">
	import { onMount } from 'svelte';
	import X from 'phosphor-svelte/lib/X';
	import DownloadSimple from 'phosphor-svelte/lib/DownloadSimple';

	interface Props {
		src: string;
		alt: string;
		filename: string;
		sizeBytes: number;
		onclose: () => void;
	}

	let { src, alt, filename, sizeBytes, onclose }: Props = $props();

	async function handleDownload(e: MouseEvent) {
		e.stopPropagation();
		try {
			const res = await fetch(src, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const blobUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = blobUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
		} catch (err) {
			console.error('[ImageLightbox] download failed', err);
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}

	onMount(() => {
		document.addEventListener('keydown', handleKeydown);
		return () => document.removeEventListener('keydown', handleKeydown);
	});
</script>

<div
	class="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/80"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
	role="dialog"
	tabindex="-1"
>
	<button
		onclick={handleDownload}
		class="absolute top-4 right-16 text-white/80 hover:text-white transition-colors z-10"
		title="Download"
		aria-label="Download image"
	>
		<DownloadSimple size={28} />
	</button>

	<button
		onclick={onclose}
		class="absolute top-4 right-4 text-white/80 hover:text-white transition-colors z-10"
		title="Close"
	>
		<X size={32} />
	</button>

	<img
		{src}
		{alt}
		crossorigin="use-credentials"
		class="max-w-[90vw] max-h-[80vh] object-contain rounded-lg"
	/>

	<div class="mt-3 text-center text-white/70 text-sm">
		<span>{filename}</span>
		{#if sizeBytes > 0}
			<span class="ml-2 text-white/50">({formatFileSize(sizeBytes)})</span>
		{/if}
	</div>
</div>
