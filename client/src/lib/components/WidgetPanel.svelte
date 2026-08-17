<script lang="ts">
	import { API_BASE } from '$lib/api.js';
	import { buildWidgetDataUrl } from '$lib/widgetBridge.js';
	import { ui } from '$lib/state/ui.svelte.js';
	import { onMount, onDestroy } from 'svelte';
	import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece';
	import CaretLeft from 'phosphor-svelte/lib/CaretLeft';

	let { widgetId, channelId, widgetName = 'Widget' }: { widgetId: string; channelId: string; widgetName?: string } = $props();

	function handleClose() {
		if (ui.isMobile) {
			const screenWidth = window.innerWidth;
			ui.setPanelDragAnimating(true);
			ui.setPanelDragOffset(screenWidth);
			setTimeout(() => {
				ui.closeCurrentPanel();
			}, 200);
		} else {
			ui.closeWidget();
		}
	}

	// /w/:id is at the server root, not under /api
	let runtimeBase = $derived(API_BASE.replace('/api', ''));
	let runtimeUrl = $derived(
		`${runtimeBase}/w/${widgetId}?channelId=${channelId}&parentOrigin=${encodeURIComponent(window.location.origin)}`
	);

	// Resolve the widget iframe origin for postMessage targeting.
	// For relative URLs (dev, same-origin) this yields the current origin;
	// for absolute URLs (production) it yields the API worker origin.
	let widgetOrigin = $derived(new URL(runtimeBase, window.location.origin).origin);

	function handleWidgetMessage(event: MessageEvent) {
		// Sandboxed iframes (without allow-same-origin) have a "null" origin,
		// so we can't validate by origin alone. Instead we verify event.source
		// matches our specific iframe's contentWindow — this is unforgeable.
		if (event.origin !== widgetOrigin && event.origin !== 'null') return;
		if (!event.data || event.data.type !== 'widget-data-request') return;
		if (event.data.widgetId !== widgetId) return;

		const { requestId, path, method, body } = event.data;
		const iframe = document.querySelector(`iframe[src*="/w/${widgetId}"]`) as HTMLIFrameElement;
		if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;

		const url = buildWidgetDataUrl(API_BASE, widgetId, path);
		if (!url) {
			iframe.contentWindow.postMessage(
				{ type: 'widget-data-response', requestId, error: 'Invalid widget data path' },
				'*' // Sandboxed iframe has null origin; widget SDK validates PARENT_ORIGIN
			);
			return;
		}
		const fetchOpts: RequestInit = { method: method || 'GET' };
		if (body) {
			fetchOpts.body = body;
			fetchOpts.headers = { 'Content-Type': 'application/json' };
		}

		fetch(url, { ...fetchOpts, credentials: 'include' })
			.then(async (res) => {
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				const data = await res.json();
				iframe.contentWindow?.postMessage(
					{
						type: 'widget-data-response',
						requestId,
						body: data
					},
					'*' // Sandboxed iframe has null origin; widget SDK validates PARENT_ORIGIN
				);
			})
			.catch((err) => {
				iframe.contentWindow?.postMessage(
					{
						type: 'widget-data-response',
						requestId,
						error: err.message
					},
					'*' // Sandboxed iframe has null origin; widget SDK validates PARENT_ORIGIN
				);
			});
	}

	onMount(() => {
		window.addEventListener('message', handleWidgetMessage);
	});

	onDestroy(() => {
		window.removeEventListener('message', handleWidgetMessage);
	});
</script>

<div class="flex-1 flex flex-col min-h-0">
	{#if ui.isMobile}
		<div
			class="h-12 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] relative z-10"
		>
			<div class="flex items-center gap-2">
				<button
					onclick={handleClose}
					class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors -ml-1 p-1"
					title="Back"
				>
					<CaretLeft size={20} />
				</button>
				<PuzzlePiece size={16} class="text-[var(--color-text-muted)]" />
				<span class="font-semibold text-sm">{widgetName}</span>
			</div>
		</div>
	{/if}
	<iframe
		src={runtimeUrl}
		title={widgetName}
		class="flex-1 w-full border-0"
		sandbox="allow-scripts allow-popups"
	></iframe>
</div>
