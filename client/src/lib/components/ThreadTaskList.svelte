<script lang="ts">
	import { onMount } from 'svelte';
	import type { Message } from '$lib/state/messages.svelte.js';
	import { isStepMessage } from '$lib/utils/groupSteps.js';
	import { formatTime } from '$lib/utils/time.js';
	import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import ChatCircleDots from 'phosphor-svelte/lib/ChatCircleDots';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import Circle from 'phosphor-svelte/lib/Circle';
	import Clock from 'phosphor-svelte/lib/Clock';
	import FunnelSimple from 'phosphor-svelte/lib/FunnelSimple';
	import SortAscending from 'phosphor-svelte/lib/SortAscending';
	import SortDescending from 'phosphor-svelte/lib/SortDescending';
	import SpinnerGap from 'phosphor-svelte/lib/SpinnerGap';
	import XCircle from 'phosphor-svelte/lib/XCircle';

	interface Props {
		items: Message[];
		selectedAuthorKeys?: string[] | null;
		loading?: boolean;
		loadError?: boolean;
		hasMore?: boolean;
		loadingMore?: boolean;
		hasNewer?: boolean;
		loadingNewer?: boolean;
		onopen: (message: Message) => void;
		onresolve: (message: Message) => void | Promise<void>;
		onunresolve: (message: Message) => void | Promise<void>;
		onretry?: () => void | Promise<void>;
		onloadmore?: () => void | Promise<void>;
		onloadnewer?: () => void | Promise<void>;
		onauthorfilterchange?: (authorKeys: string[] | null) => void;
	}

	let {
		items,
		selectedAuthorKeys = null,
		loading = false,
		loadError = false,
		hasMore = false,
		loadingMore = false,
		hasNewer = false,
		loadingNewer = false,
		onopen,
		onresolve,
		onunresolve,
		onretry,
		onloadmore,
		onloadnewer,
		onauthorfilterchange
	}: Props = $props();

	let pendingIds = $state<string[]>([]);
	let sortDirection = $state<'asc' | 'desc'>('desc');
	let showOpen = $state(true);
	let showClosed = $state(false);
	let authorMenuOpen = $state(false);
	let authorMenuElement = $state<HTMLDetailsElement | null>(null);

	onMount(() => {
		function handlePointerDown(event: PointerEvent) {
			if (!authorMenuOpen || authorMenuElement?.contains(event.target as Node)) return;
			authorMenuOpen = false;
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key !== 'Escape' || !authorMenuOpen) return;
			event.preventDefault();
			authorMenuOpen = false;
			requestAnimationFrame(() => {
				authorMenuElement?.querySelector<HTMLElement>('summary')?.focus();
			});
		}

		document.addEventListener('pointerdown', handlePointerDown);
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('keydown', handleKeyDown);
		};
	});

	let allTaskItems = $derived.by(() =>
		items
			.filter(
				(message) =>
					!message.thread_id &&
					message.type !== 'system' &&
					!message.deleted_at &&
					!isStepMessage(message)
			)
			.toSorted((a, b) => b.created_at - a.created_at)
	);

	interface TaskAuthor {
		key: string;
		name: string;
		username: string | null;
	}

	function authorKey(message: Message): string {
		if (message.user_id) return `user:${message.user_id}`;
		if (message.username) return `username:${message.username.toLocaleLowerCase()}`;
		return 'unknown';
	}

	let authors = $derived.by(() => {
		const result: TaskAuthor[] = [];
		for (const message of allTaskItems) {
			const key = authorKey(message);
			if (!result.some((author) => author.key === key)) {
				result.push({
					key,
					name: authorName(message),
					username: message.username ?? null
				});
			}
		}
		return result.toSorted((a, b) => a.name.localeCompare(b.name));
	});

	let taskItems = $derived.by(() => {
		const filtered = selectedAuthorKeys === null
			? allTaskItems
			: allTaskItems.filter((message) => selectedAuthorKeys.includes(authorKey(message)));
		return filtered.toSorted((a, b) =>
			sortDirection === 'asc' ? a.created_at - b.created_at : b.created_at - a.created_at
		);
	});
	let openItems = $derived(taskItems.filter((message) => !message.resolved_at));
	let completedItems = $derived(taskItems.filter((message) => !!message.resolved_at));

	function taskTitle(message: Message): string {
		const explicit = message.thread_title?.trim();
		if (explicit) return explicit;
		const content = (message.content ?? '')
			.replace(/```[\s\S]*?```/g, ' code ')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, ' attachment ')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/[*_~`>#]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		return content || 'Untitled item';
	}

	function authorName(message: Message): string {
		return message.display_name || message.username || 'Unknown';
	}

	function isAuthorSelected(key: string): boolean {
		return selectedAuthorKeys === null || selectedAuthorKeys.includes(key);
	}

	function toggleAuthor(key: string) {
		const current = selectedAuthorKeys === null
			? authors.map((author) => author.key)
			: selectedAuthorKeys;
		const next = current.includes(key)
			? current.filter((authorKey) => authorKey !== key)
			: [...current, key];
		onauthorfilterchange?.(next);
	}

	function authorFilterLabel(): string {
		if (selectedAuthorKeys === null) return 'All authors';
		if (selectedAuthorKeys.length === 0) return 'No authors';
		if (selectedAuthorKeys.length === 1) {
			return authors.find((author) => author.key === selectedAuthorKeys[0])?.name ?? '1 author';
		}
		return `${selectedAuthorKeys.length} authors`;
	}

	function isPending(message: Message): boolean {
		return pendingIds.includes(message.id);
	}

	async function toggleComplete(message: Message) {
		if (isPending(message)) return;
		pendingIds = [...pendingIds, message.id];
		try {
			if (message.resolved_at) await onunresolve(message);
			else await onresolve(message);
		} finally {
			pendingIds = pendingIds.filter((id) => id !== message.id);
		}
	}
</script>

{#snippet taskRow(message: Message, completed: boolean)}
	<div class="task-row group flex items-start gap-3 px-3 py-3 transition-colors hover:bg-[var(--color-bg-hover)]/60" class:opacity-60={completed}>
		<button
			type="button"
			disabled={isPending(message)}
			onclick={() => toggleComplete(message)}
			class="mt-0.5 shrink-0 rounded-full text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-accent)] disabled:opacity-50"
			title={completed ? 'Mark as open' : 'Mark as complete'}
			aria-label={completed ? `Mark ${taskTitle(message)} as open` : `Mark ${taskTitle(message)} as complete`}
		>
			{#if completed}
				<CheckCircle size={19} weight="fill" class="text-[var(--color-accent)]" />
			{:else}
				<Circle size={19} />
			{/if}
		</button>

		<button
			type="button"
			onclick={() => onopen(message)}
			class="min-w-0 flex-1 text-left"
			title={`Open thread: ${taskTitle(message)}`}
		>
			<div class="truncate text-sm font-medium text-[var(--color-text)]" class:line-through={completed}>
				{taskTitle(message)}
			</div>
			<div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
				<span class="truncate">{authorName(message)}</span>
				<span aria-hidden="true">·</span>
				<span>{formatTime(message.created_at)}</span>
				{#if (message.reply_count ?? 0) > 0}
					<span aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1"><ChatCircleDots size={12} />{message.reply_count}</span>
				{/if}
				{#if message.thread_process_status === 'processing' || message.process_status === 'processing'}
					<span aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1 text-[var(--color-accent)]"><SpinnerGap size={12} class="animate-spin" />In progress</span>
				{:else if message.thread_process_status === 'queued' || message.process_status === 'queued'}
					<span aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1"><Clock size={12} />Queued</span>
				{:else if message.process_status === 'error'}
					<span aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1 text-[var(--color-danger)]"><XCircle size={12} />Error</span>
				{/if}
			</div>
		</button>

		<button
			type="button"
			onclick={() => onopen(message)}
			class="mt-0.5 shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text)] group-hover:opacity-100 focus-visible:opacity-100"
			title="Open thread"
			aria-label={`Open ${taskTitle(message)} thread`}
		>
			<CaretRight size={16} />
		</button>
	</div>
{/snippet}

<div class="dark-scrollbar flex-1 min-h-0 overflow-y-auto bg-[var(--color-bg)]">
	{#if loading}
		<div class="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">Loading items…</div>
	{:else if loadError && items.length === 0}
		<div class="flex h-full items-center justify-center">
			<div class="text-center text-[var(--color-text-muted)]">
				<p class="text-sm">Couldn't load items</p>
				{#if onretry}
					<button type="button" onclick={() => onretry?.()} class="mt-2 text-xs text-[var(--color-accent)] underline hover:no-underline">Retry</button>
				{/if}
			</div>
		</div>
	{:else}
		<div class="mx-auto w-full max-w-4xl px-4 py-5">
			{#if hasNewer && onloadnewer}
				<div class="mb-4 text-center">
					<button type="button" disabled={loadingNewer} onclick={() => onloadnewer?.()} class="inline-flex items-center gap-1.5 text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50">
						<ArrowClockwise size={13} />{loadingNewer ? 'Loading…' : 'Load newer items'}
					</button>
				</div>
			{/if}

			<div class="relative z-10 mb-4 flex flex-wrap items-center justify-between gap-2">
				<div class="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-0.5" role="group" aria-label="Task status visibility">
					<button
						type="button"
						onclick={() => showOpen = !showOpen}
						aria-pressed={showOpen}
						aria-label={showOpen ? 'Hide open items' : 'Show open items'}
						class="rounded-md px-2 py-1 text-xs font-medium transition-colors {showOpen ? 'bg-[var(--color-bg-hover)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>Open</button>
					<button
						type="button"
						onclick={() => showClosed = !showClosed}
						aria-pressed={showClosed}
						aria-label={showClosed ? 'Hide closed items' : 'Show closed items'}
						class="rounded-md px-2 py-1 text-xs font-medium transition-colors {showClosed ? 'bg-[var(--color-bg-hover)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>Closed</button>
				</div>

				<div class="flex items-center gap-1">
					<button
						type="button"
						onclick={() => sortDirection = sortDirection === 'desc' ? 'asc' : 'desc'}
						aria-label={sortDirection === 'desc' ? 'Sort oldest first' : 'Sort newest first'}
						title={sortDirection === 'desc' ? 'Newest first' : 'Oldest first'}
						class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
					>
						{#if sortDirection === 'desc'}<SortDescending size={13} />Newest{:else}<SortAscending size={13} />Oldest{/if}
					</button>

					{#if authors.length > 0 && onauthorfilterchange}
						<details bind:this={authorMenuElement} bind:open={authorMenuOpen} class="relative">
							<summary aria-label={`Filter by author: ${authorFilterLabel()}`} class="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors {selectedAuthorKeys === null ? 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]' : 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'}">
								<FunnelSimple size={13} weight={selectedAuthorKeys === null ? 'regular' : 'fill'} />
								<span class="max-w-36 truncate">{authorFilterLabel()}</span>
							</summary>
							<div class="absolute right-0 mt-1 w-64 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-xl">
								<div class="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
									<span class="text-xs font-medium text-[var(--color-text)]">Show items from</span>
									{#if selectedAuthorKeys !== null}
										<button type="button" onclick={() => onauthorfilterchange?.(null)} class="text-xs text-[var(--color-link)] hover:underline">Show all</button>
									{/if}
								</div>
								<div class="max-h-64 overflow-y-auto py-1">
									{#each authors as author (author.key)}
										<label class="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-[var(--color-bg-hover)]">
											<input
												type="checkbox"
												checked={isAuthorSelected(author.key)}
												onchange={() => toggleAuthor(author.key)}
												aria-label={`Show items from ${author.name}`}
												class="h-3.5 w-3.5 rounded border-[var(--color-border)] accent-[var(--color-accent)]"
											/>
											<span class="min-w-0 flex-1">
												<span class="block truncate text-sm text-[var(--color-text)]">{author.name}</span>
												{#if author.username && author.username !== author.name}
													<span class="block truncate text-xs text-[var(--color-text-muted)]">@{author.username}</span>
												{/if}
											</span>
										</label>
									{/each}
								</div>
							</div>
						</details>
					{/if}
				</div>
			</div>

			{#if showOpen}
				<section aria-labelledby="open-items-heading">
					<div class="mb-2 flex items-center gap-2">
						<h2 id="open-items-heading" class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Open</h2>
						<span class="rounded-full bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">{openItems.length}</span>
					</div>
					{#if openItems.length > 0}
						<div class="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] divide-y divide-[var(--color-border)]">
							{#each openItems as message (message.id)}
								{@render taskRow(message, false)}
							{/each}
						</div>
					{:else if allTaskItems.length > 0}
						<div class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
							{selectedAuthorKeys === null ? 'No open items' : 'No open items from selected authors'}
						</div>
					{/if}
				</section>
			{/if}

			{#if showClosed}
				<section class:mt-5={showOpen} aria-labelledby="closed-items-heading">
					<div class="mb-2 flex items-center gap-2">
						<h2 id="closed-items-heading" class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Closed</h2>
						<span class="rounded-full bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">{completedItems.length}</span>
					</div>
					{#if completedItems.length > 0}
						<div class="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] divide-y divide-[var(--color-border)]">
							{#each completedItems as message (message.id)}
								{@render taskRow(message, true)}
							{/each}
						</div>
					{:else if allTaskItems.length > 0}
						<div class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
							{selectedAuthorKeys === null ? 'No closed items' : 'No closed items from selected authors'}
						</div>
					{/if}
				</section>
			{/if}

			{#if !showOpen && !showClosed && allTaskItems.length > 0}
				<div class="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">Open and closed items are hidden.</div>
			{/if}

			{#if allTaskItems.length === 0}
				<p class="mt-5 text-center text-xs text-[var(--color-text-muted)]">Top-level messages will appear here as work items.</p>
			{/if}

			{#if hasMore && onloadmore}
				<div class="mt-5 text-center">
					<button type="button" disabled={loadingMore} onclick={() => onloadmore?.()} class="inline-flex items-center gap-1.5 text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50">
						<ArrowClockwise size={13} />{loadingMore ? 'Loading…' : 'Load older items'}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
