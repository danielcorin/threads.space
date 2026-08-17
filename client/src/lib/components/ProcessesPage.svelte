<script lang="ts">
	import { onMount } from 'svelte';
	import { processes, type Process } from '$lib/state/processes.svelte.js';
	import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
	import List from 'phosphor-svelte/lib/List';

	interface Props {
		onnavigatetomessage?: (messageId: string, channelId: string, isDm: boolean, dmPartnerId?: string | null) => void;
		onopensidebar?: () => void;
	}
	let { onnavigatetomessage, onopensidebar }: Props = $props();

	let statusFilter = $state<string>('');
	let killingAll = $state(false);
	let killing = $state<Set<string>>(new Set());

	onMount(() => {
		// Reconcile once on entry. The owner-scoped /events stream keeps this
		// cross-channel collection live after the initial snapshot.
		processes.load();
	});

	const filtered = $derived(
		statusFilter === 'resolved'
			? processes.list.filter(isResolvedProcess)
			: statusFilter === 'unresolved'
				? processes.list.filter((p) => !isResolvedProcess(p))
			: statusFilter === 'done'
				? processes.list.filter((p) => p.status === 'done' && !isResolvedProcess(p))
				: statusFilter
					? processes.list.filter((p) => p.status === statusFilter)
					: processes.list
	);

	function isActive(p: Process): boolean {
		return p.status === 'running' || p.status === 'queued';
	}

	function isResolvedProcess(p: Process): boolean {
		return !!p.resolved_at;
	}

	async function killOne(p: Process) {
		if (!isActive(p)) return;
		killing = new Set(killing).add(p.id);
		try {
			await processes.kill(p.id);
		} finally {
			const next = new Set(killing);
			next.delete(p.id);
			killing = next;
		}
	}

	async function killAll() {
		killingAll = true;
		try {
			await processes.killAll();
		} finally {
			killingAll = false;
		}
	}

	function displayStatus(p: Process): string {
		return p.status;
	}

	function statusClass(p: Process): string {
		switch (displayStatus(p)) {
			case 'running':
			case 'queued':
				return 'bg-blue-500/15 text-blue-400';
			case 'done':
				return 'bg-green-500/15 text-green-400';
			case 'error':
				return 'bg-red-500/15 text-red-400';
			case 'killed':
				return 'bg-zinc-500/15 text-zinc-400';
			case 'restarted':
				return 'bg-yellow-500/15 text-yellow-400';
			default:
				return 'bg-zinc-500/15 text-zinc-400';
		}
	}

	function statusTitle(p: Process): string {
		return `Process status: ${p.status}`;
	}

	function resolutionTitle(p: Process): string {
		return p.thread_id ? 'Parent thread resolved' : 'Parent message resolved';
	}

	function botLabel(p: Process): string {
		return p.bot_display_name || p.bot_username || '—';
	}

	function channelLabel(p: Process): string {
		if (p.is_dm) {
			return `DM · ${p.dm_partner_display_name || p.dm_partner_username || p.channel_name || ''}`;
		}
		return p.channel_name || p.channel_id;
	}

	function processLocationLabel(p: Process): string {
		return p.thread_id ? `${channelLabel(p)} · Thread` : channelLabel(p);
	}

	function actorLabel(p: Process): string {
		return p.display_name || p.username || '—';
	}

	function ago(iso: string | null): string {
		if (!iso) return '';
		const ms = Date.now() - new Date(iso).getTime();
		if (Number.isNaN(ms)) return '';
		const s = Math.max(0, Math.floor(ms / 1000));
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		return `${Math.floor(h / 24)}d`;
	}

	function startDateTime(iso: string | null): string {
		if (!iso) return '—';
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return '—';
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(date);
	}

	function tokens(p: Process): number {
		return (p.input_tokens || 0) + (p.output_tokens || 0);
	}
</script>

<div class="flex flex-col h-full min-h-0 bg-zinc-900 text-zinc-100">
	<header class="flex flex-wrap md:flex-nowrap items-center gap-2 px-3 md:px-4 py-2 md:py-3 border-b border-zinc-800 shrink-0">
		<div class="flex items-center gap-2 min-w-0">
			{#if onopensidebar}
				<button
					class="md:hidden text-zinc-400 hover:text-zinc-100 transition-colors -ml-1 p-1 shrink-0"
					title="Open sidebar"
					onclick={() => onopensidebar?.()}
				>
					<List size={20} />
				</button>
			{/if}
			<h1 class="text-base font-semibold shrink-0">Processes</h1>
			<span class="text-xs text-zinc-400 whitespace-nowrap">{processes.runningCount} running</span>
		</div>

		<div class="ml-auto flex items-center justify-end gap-2 min-w-0">
			<select
				bind:value={statusFilter}
				class="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs max-w-[7rem] md:max-w-none"
				data-testid="process-status-filter"
			>
				<option value="">All</option>
				<option value="running">Running</option>
				<option value="queued">Queued</option>
				<option value="done">Done</option>
				<option value="resolved">Resolved</option>
				<option value="unresolved">Not resolved</option>
				<option value="error">Error</option>
				<option value="killed">Killed</option>
				<option value="restarted">Restarted</option>
			</select>
			<button
				class="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 whitespace-nowrap"
				onclick={() => processes.load()}
			>
				Refresh
			</button>
			<button
				class="text-xs px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 disabled:opacity-40 whitespace-nowrap"
				disabled={killingAll || processes.runningCount === 0}
				onclick={killAll}
			>
				{killingAll ? 'Cancelling…' : 'Cancel all'}
			</button>
		</div>
	</header>

	<div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
		{#if filtered.length === 0}
			<div class="flex items-center justify-center h-full text-sm text-zinc-500">
				No processes{statusFilter ? ` with status “${statusFilter}”` : ''}.
			</div>
		{:else}
			<div class="md:hidden divide-y divide-zinc-800/70">
				{#each filtered as p (p.id)}
					<article class="px-3 py-3 {isResolvedProcess(p) ? 'bg-zinc-950/20' : ''}">
						<div class="flex items-start gap-2 min-w-0">
							<span
								class="inline-block px-2 py-0.5 rounded-full text-xs shrink-0 {statusClass(p)}"
								title={statusTitle(p)}
								data-testid="process-status"
							>
								{displayStatus(p)}
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-1.5 min-w-0">
									{#if onnavigatetomessage && p.message_id}
										<button
											class="block min-w-0 max-w-full text-blue-400 hover:underline text-left truncate"
											onclick={() => onnavigatetomessage?.(p.message_id, p.channel_id, !!p.is_dm, p.dm_partner_id)}
											title={processLocationLabel(p)}
										>
											{processLocationLabel(p)}
										</button>
									{:else}
										<div class="min-w-0 truncate" title={processLocationLabel(p)}>{processLocationLabel(p)}</div>
									{/if}
									{#if isResolvedProcess(p)}
										<span
											class="inline-flex text-zinc-500 shrink-0"
											role="img"
											aria-label={resolutionTitle(p)}
											title={resolutionTitle(p)}
											data-testid="process-resolved-marker"
										>
											<CheckCircle size={14} weight="fill" />
										</span>
									{/if}
								</div>
								<div class="mt-1 text-xs text-zinc-500 truncate" title={botLabel(p)}>
									Bot: {botLabel(p)}
								</div>
							</div>
							{#if isActive(p)}
								<button
									class="text-xs px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 disabled:opacity-40 shrink-0"
									disabled={killing.has(p.id)}
									onclick={() => killOne(p)}
								>
									{killing.has(p.id) ? 'Cancelling…' : 'Cancel'}
								</button>
							{/if}
						</div>

						<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
							<span class="min-w-0 max-w-full truncate" title={actorLabel(p)}>By {actorLabel(p)}</span>
							<span class="whitespace-nowrap">{ago(p.started_at) || '—'} ago</span>
							<span class="whitespace-nowrap tabular-nums">{p.tool_call_count || 0} tools</span>
							<span class="whitespace-nowrap tabular-nums">{p.reply_count || 0} replies</span>
							<span class="whitespace-nowrap tabular-nums">{tokens(p).toLocaleString()} tokens</span>
						</div>
					</article>
				{/each}
			</div>

			<table class="hidden md:table w-full text-sm">
				<thead class="sticky top-0 bg-zinc-900 text-left text-xs text-zinc-500 border-b border-zinc-800">
					<tr>
						<th class="px-4 py-2 font-medium">Status</th>
						<th class="px-4 py-2 font-medium">Bot</th>
						<th class="px-4 py-2 font-medium">Channel</th>
						<th class="px-4 py-2 font-medium">Started by</th>
						<th class="px-4 py-2 font-medium">Started</th>
						<th class="px-4 py-2 font-medium">Age</th>
						<th class="px-4 py-2 font-medium text-right">Tools</th>
						<th class="px-4 py-2 font-medium text-right">Replies</th>
						<th class="px-4 py-2 font-medium text-right">Tokens</th>
						<th class="px-4 py-2"></th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as p (p.id)}
						<tr class="border-b border-zinc-800/60 hover:bg-zinc-800/40 {isResolvedProcess(p) ? 'bg-zinc-950/20' : ''}">
							<td class="px-4 py-2">
								<span
									class="inline-block px-2 py-0.5 rounded-full text-xs {statusClass(p)}"
									title={statusTitle(p)}
									data-testid="process-status"
								>
									{displayStatus(p)}
								</span>
							</td>
							<td class="px-4 py-2">{botLabel(p)}</td>
							<td class="px-4 py-2">
								<div class="flex items-center gap-1.5 min-w-0">
									{#if onnavigatetomessage && p.message_id}
										<button
											class="min-w-0 text-blue-400 hover:underline text-left truncate"
											onclick={() => onnavigatetomessage?.(p.message_id, p.channel_id, !!p.is_dm, p.dm_partner_id)}
										>
											{processLocationLabel(p)}
										</button>
									{:else}
										<span class="min-w-0 truncate">{processLocationLabel(p)}</span>
									{/if}
									{#if isResolvedProcess(p)}
										<span
											class="inline-flex text-zinc-500 shrink-0"
											role="img"
											aria-label={resolutionTitle(p)}
											title={resolutionTitle(p)}
											data-testid="process-resolved-marker"
										>
											<CheckCircle size={14} weight="fill" />
										</span>
									{/if}
								</div>
							</td>
							<td class="px-4 py-2 text-zinc-400">{actorLabel(p)}</td>
							<td class="px-4 py-2 text-zinc-400 whitespace-nowrap">{startDateTime(p.started_at)}</td>
							<td class="px-4 py-2 text-zinc-400">{ago(p.started_at)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{p.tool_call_count || 0}</td>
							<td class="px-4 py-2 text-right tabular-nums">{p.reply_count || 0}</td>
							<td class="px-4 py-2 text-right tabular-nums">{tokens(p).toLocaleString()}</td>
							<td class="px-4 py-2 text-right">
								{#if isActive(p)}
									<button
										class="text-xs px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 disabled:opacity-40"
										disabled={killing.has(p.id)}
										onclick={() => killOne(p)}
									>
										{killing.has(p.id) ? 'Cancelling…' : 'Cancel'}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
