<script lang="ts">
	import { onMount } from 'svelte';
	import X from 'phosphor-svelte/lib/X';
	import DownloadSimple from 'phosphor-svelte/lib/DownloadSimple';
	import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
	import Papa from 'papaparse';
	import { detectViewerType, type ViewerType } from '$lib/utils/file-viewer.js';
	import { renderMarkdown } from '$lib/utils/markdown.js';
	import JsonNode from './file-viewers/JsonNode.svelte';

	interface Props {
		url: string;
		contentType: string;
		filename: string;
		sizeBytes: number;
		onclose: () => void;
	}

	let { url, contentType, filename, sizeBytes, onclose }: Props = $props();

	let viewerType: ViewerType = $derived(detectViewerType(contentType, filename));

	// Body fetch — populated for text-based sub-viewers (text/markdown/json/csv).
	let bodyText = $state<string | null>(null);
	let bodyError = $state<string | null>(null);
	let bodyLoading = $state(false);

	// Text/markdown rendering toggle for .md files.
	let renderMarkdownToggle = $state(true);

	// CSV sort state.
	let csvSortColumn = $state<number | null>(null);
	let csvSortDir = $state<'asc' | 'desc'>('asc');

	const NEEDS_BODY: ReadonlySet<ViewerType> = new Set(['text', 'markdown', 'json', 'csv']);
	const BODY_FETCH_TIMEOUT_MS = 12_000;

	function previewFetchUrl(fileUrl: string): string {
		const parsed = new URL(fileUrl, window.location.href);
		parsed.searchParams.set('preview', '1');
		return parsed.toString();
	}

	async function fetchBodyWithTimeout(fileUrl: string): Promise<string> {
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), BODY_FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(previewFetchUrl(fileUrl), {
				credentials: 'include',
				cache: 'reload',
				signal: controller.signal
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				throw new Error('Timed out loading preview. Open in a new tab or download the file.', { cause: err });
			}
			throw err;
		} finally {
			window.clearTimeout(timeout);
		}
	}

	$effect(() => {
		if (!NEEDS_BODY.has(viewerType)) return;
		if (bodyText !== null || bodyLoading) return;
		bodyLoading = true;
		bodyError = null;
		fetchBodyWithTimeout(url)
			.then((text) => {
				bodyText = text;
			})
			.catch((err) => {
				bodyError = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				bodyLoading = false;
			});
	});

	// JSON parsing — falls back to text viewer on parse failure.
	let parsedJson = $derived.by(() => {
		if (viewerType !== 'json' || bodyText === null) return null;
		try {
			return { ok: true as const, value: JSON.parse(bodyText) };
		} catch (err) {
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// CSV parsing — falls back to text viewer on parse failure.
	let parsedCsv = $derived.by(() => {
		if (viewerType !== 'csv' || bodyText === null) return null;
		try {
			const delimiter = filename.toLowerCase().endsWith('.tsv') || contentType === 'text/tab-separated-values' ? '\t' : ',';
			const result = Papa.parse<string[]>(bodyText, { delimiter, skipEmptyLines: true });
			if (result.errors.length > 0 && result.data.length === 0) {
				return { ok: false as const, error: result.errors[0]?.message || 'Parse failed' };
			}
			const rows = result.data as string[][];
			if (rows.length === 0) return { ok: true as const, header: [], body: [] };
			const [header, ...body] = rows;
			return { ok: true as const, header, body };
		} catch (err) {
			return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
		}
	});

	let csvSortedBody = $derived.by(() => {
		if (!parsedCsv || !parsedCsv.ok) return [] as string[][];
		if (csvSortColumn === null) return parsedCsv.body;
		const col = csvSortColumn;
		const dir = csvSortDir === 'asc' ? 1 : -1;
		const copy = parsedCsv.body.slice();
		copy.sort((a, b) => {
			const av = a[col] ?? '';
			const bv = b[col] ?? '';
			const an = Number(av);
			const bn = Number(bv);
			if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== '' && bv !== '') {
				return (an - bn) * dir;
			}
			return av.localeCompare(bv) * dir;
		});
		return copy;
	});

	function toggleCsvSort(col: number) {
		if (csvSortColumn === col) {
			csvSortDir = csvSortDir === 'asc' ? 'desc' : 'asc';
		} else {
			csvSortColumn = col;
			csvSortDir = 'asc';
		}
	}

	async function handleDownload(e: MouseEvent) {
		e.stopPropagation();
		try {
			const res = await fetch(url, { credentials: 'include' });
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
			console.error('[FileViewer] download failed', err);
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	onMount(() => {
		document.addEventListener('keydown', handleKeydown);
		return () => document.removeEventListener('keydown', handleKeydown);
	});

	let isMarkdownFile = $derived(viewerType === 'markdown');
</script>

<div
	data-testid="file-viewer-backdrop"
	role="presentation"
	class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 file-viewer-backdrop"
	onclick={handleBackdropClick}
>
	<div class="file-viewer-panel flex flex-col bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg shadow-xl">
		<!-- Header -->
		<div class="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0">
			<div class="flex-1 min-w-0">
				<div class="text-sm font-medium text-[var(--color-text)] truncate">{filename}</div>
				<div class="text-xs text-[var(--color-text-muted)]">
					{contentType || 'unknown'}{sizeBytes > 0 ? ` · ${formatFileSize(sizeBytes)}` : ''}
				</div>
			</div>
			{#if isMarkdownFile && bodyText !== null}
				<button
					type="button"
					onclick={() => { renderMarkdownToggle = !renderMarkdownToggle; }}
					class="text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)] transition-colors"
					title={renderMarkdownToggle ? 'Show raw source' : 'Show rendered'}
				>
					{renderMarkdownToggle ? 'Raw' : 'Rendered'}
				</button>
			{/if}
			<a
				href={url}
				target="_blank"
				rel="noopener"
				class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Open in new tab"
				aria-label="Open in new tab"
			>
				<ArrowSquareOut size={18} />
			</a>
			<button
				type="button"
				onclick={handleDownload}
				class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Download"
				aria-label="Download {filename}"
			>
				<DownloadSimple size={18} />
			</button>
			<button
				type="button"
				onclick={onclose}
				class="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
				title="Close"
				aria-label="Close"
			>
				<X size={18} />
			</button>
		</div>

		<!-- Body -->
		<div class="flex-1 min-h-0 overflow-auto">
			{#if viewerType === 'audio'}
				<div class="flex items-center justify-center p-6">
					<!-- svelte-ignore a11y_media_has_caption -->
					<audio src={url} crossorigin="use-credentials" controls class="w-full max-w-xl"></audio>
				</div>
			{:else if viewerType === 'pdf'}
				<iframe
					src={url}
					title={filename}
					class="w-full h-full min-h-[60vh]"
				></iframe>
				<div class="md:hidden text-center p-3 border-t border-[var(--color-border)]">
					<a
						href={url}
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-2 px-3 py-2 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
					>
						<ArrowSquareOut size={14} />
						Open in browser tab
					</a>
				</div>
			{:else if bodyLoading && bodyText === null}
				<div class="p-6 text-center text-sm text-[var(--color-text-muted)]">Loading…</div>
			{:else if bodyError}
				<div class="p-6 text-center text-sm text-[var(--color-danger)]">
					Failed to load: {bodyError}
				</div>
			{:else if viewerType === 'markdown' && bodyText !== null}
				{#if renderMarkdownToggle}
					<div class="markdown-rendered prose-sm max-w-none p-4 text-[var(--color-text)]">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html renderMarkdown(bodyText)}
					</div>
				{:else}
					<pre class="text-xs leading-relaxed font-mono p-4 whitespace-pre-wrap break-words text-[var(--color-text)]">{bodyText}</pre>
				{/if}
			{:else if viewerType === 'json' && bodyText !== null}
				{#if parsedJson?.ok}
					<div class="p-4">
						<JsonNode value={parsedJson.value} />
					</div>
				{:else}
					<div class="p-3 text-xs text-[var(--color-danger)] border-b border-[var(--color-border)]">
						JSON parse failed{parsedJson ? `: ${parsedJson.error}` : ''} — showing raw text.
					</div>
					<pre class="text-xs leading-relaxed font-mono p-4 whitespace-pre-wrap break-words text-[var(--color-text)]">{bodyText}</pre>
				{/if}
			{:else if viewerType === 'csv' && bodyText !== null}
				{#if parsedCsv?.ok && parsedCsv.header.length > 0}
					<div class="overflow-auto">
						<table class="w-full text-sm border-collapse">
							<thead class="bg-[var(--color-bg-hover)] sticky top-0">
								<tr>
									{#each parsedCsv.header as h, i (i)}
										<th
											class="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg-input)] select-none"
											onclick={() => toggleCsvSort(i)}
										>
											{h}{csvSortColumn === i ? (csvSortDir === 'asc' ? ' ↑' : ' ↓') : ''}
										</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each csvSortedBody as row, ri (ri)}
									<tr class="border-b border-[var(--color-border)]">
										{#each parsedCsv.header as _h, ci (ci)}
											<td class="px-3 py-1.5 text-[var(--color-text)] align-top break-words">{row[ci] ?? ''}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="p-3 text-xs text-[var(--color-danger)] border-b border-[var(--color-border)]">
						CSV parse failed{parsedCsv && !parsedCsv.ok ? `: ${parsedCsv.error}` : ''} — showing raw text.
					</div>
					<pre class="text-xs leading-relaxed font-mono p-4 whitespace-pre-wrap break-words text-[var(--color-text)]">{bodyText}</pre>
				{/if}
			{:else if viewerType === 'text' && bodyText !== null}
				<pre class="text-xs leading-relaxed font-mono p-4 whitespace-pre-wrap break-words text-[var(--color-text)]">{bodyText}</pre>
			{:else}
				<div class="p-8 text-center">
					<div class="text-sm text-[var(--color-text-muted)] mb-3">
						Preview not supported for this file type.
					</div>
					<div class="flex items-center justify-center gap-2">
						<button
							type="button"
							onclick={handleDownload}
							class="inline-flex items-center gap-2 px-3 py-2 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
						>
							<DownloadSimple size={14} />
							Download
						</button>
						<a
							href={url}
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-2 px-3 py-2 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
						>
							<ArrowSquareOut size={14} />
							Open in new tab
						</a>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.file-viewer-panel {
		width: min(960px, 90vw);
		height: min(80vh, 720px);
		max-width: 100%;
	}

	/* Mobile: full-screen modal — matches DebugPanel / ChannelSettingsModal pattern. */
	@media (max-width: 767px) {
		.file-viewer-backdrop {
			padding: 0;
		}
		.file-viewer-panel {
			width: 100%;
			height: 100dvh;
			max-width: 100%;
			border-radius: 0;
			border: none;
			padding-top: env(safe-area-inset-top, 0px);
			padding-bottom: env(safe-area-inset-bottom, 0px);
		}
	}

	.markdown-rendered :global(h1) {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 1rem 0 0.5rem;
	}
	.markdown-rendered :global(h2) {
		font-size: 1.25rem;
		font-weight: 700;
		margin: 0.875rem 0 0.5rem;
	}
	.markdown-rendered :global(h3) {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0.75rem 0 0.5rem;
	}
	.markdown-rendered :global(p) {
		margin: 0.5rem 0;
	}
	.markdown-rendered :global(ul),
	.markdown-rendered :global(ol) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}
	.markdown-rendered :global(ul) {
		list-style: disc;
	}
	.markdown-rendered :global(ol) {
		list-style: decimal;
	}
	.markdown-rendered :global(blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 0.75rem;
		color: var(--color-text-muted);
		margin: 0.5rem 0;
	}
	.markdown-rendered :global(table) {
		border-collapse: collapse;
		margin: 0.75rem 0;
	}
	.markdown-rendered :global(th),
	.markdown-rendered :global(td) {
		border: 1px solid var(--color-border);
		padding: 0.25rem 0.5rem;
	}
</style>
