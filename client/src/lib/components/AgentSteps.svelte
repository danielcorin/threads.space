<script lang="ts">
	import { renderMarkdown, renderInlineMarkdown } from '$lib/utils/markdown.js';
	import { formatTime } from '$lib/utils/time.js';
	import { processes } from '$lib/state/processes.svelte.js';
	import BrailleSpinner from './BrailleSpinner.svelte';
	import Stop from 'phosphor-svelte/lib/Stop';
	import type { Message } from '$lib/state/messages.svelte.js';

	interface Props {
		messages: Message[];
		open?: boolean;
		// Process status of the triggering message — drives the summary indicator
		// (spinner / green check / red error / yellow restarted / stopped) so it
		// stays in lockstep with the process pill. Undefined → fall back to `open`.
		status?: string;
		triggerMessageId?: string;
		processId?: string;
		onprocesskill?: (messageId: string, processId: string) => void;
		knownUsernames?: Set<string>;
		knownChannelNames?: Set<string>;
	}

	let { messages, open = false, status, triggerMessageId, processId, onprocesskill, knownUsernames, knownChannelNames }: Props = $props();

	let agentName = $derived(messages[0]?.display_name || messages[0]?.username || 'Agent');
	let count = $derived(messages.length);
	// A trailing run is rendered open by the grouping pass — treat that as "still working".
	let running = $derived(open);

	// Map the trigger's process status onto a summary indicator. Mirrors the
	// pill's vocabulary (MessageItem.svelte): processing/queued spin, done is a
	// green check, error a red cross, restarted a yellow loop, killed a muted
	// stop. When status is absent (legacy/orphaned run) fall back to the `open`
	// heuristic: still-open = working, otherwise treat as done.
	type Indicator = 'working' | 'done' | 'error' | 'restarted' | 'killed';
	let indicator: Indicator = $derived.by(() => {
		switch (status) {
			case 'queued':
			case 'running':
			case 'processing':
				return 'working';
			case 'done':
				return 'done';
			case 'error':
				return 'error';
			case 'restarted':
				return 'restarted';
			case 'killed':
				return 'killed';
			default:
				return running ? 'working' : 'done';
		}
	});
	let tools = $derived(`${count} ${count === 1 ? 'tool' : 'tools'}`);
	let nowMs = $state(Date.now());
	let previousIndicator = $state<Indicator | null>(null);
	let terminalFallbackAtMs = $state<number | null>(null);
	let process = $derived.by(() => processId ? processes.list.find((p) => p.id === processId) : undefined);

	function parseDateMs(value: string | null | undefined): number | null {
		if (!value) return null;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function secondsToMs(value: number | null | undefined): number | null {
		return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null;
	}

	function formatElapsed(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainder = seconds % 60;
		if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
		const hours = Math.floor(minutes / 60);
		const minuteRemainder = minutes % 60;
		return `${hours}h ${String(minuteRemainder).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`;
	}

	let elapsed = $derived.by(() => {
		const startedAtMs = parseDateMs(process?.started_at) ?? secondsToMs(messages[0]?.created_at);
		if (!startedAtMs) return null;

		const lastStepAtMs = secondsToMs(messages[messages.length - 1]?.created_at);
		const endedAtMs = indicator === 'working'
			? nowMs
			: parseDateMs(process?.ended_at) ?? terminalFallbackAtMs ?? lastStepAtMs ?? nowMs;
		const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
		return formatElapsed(elapsedSeconds);
	});
	let metaVerb = $derived(
		(indicator === 'working'
			? `running ${tools}`
			: indicator === 'error'
				? `ran ${tools} · error`
				: indicator === 'restarted'
					? `ran ${tools} · restarted`
					: indicator === 'killed'
						? `ran ${tools} · stopped`
						: `ran ${tools}`) + (elapsed ? ` · ${elapsed}` : '')
	);

	$effect(() => {
		if (indicator === 'working') {
			terminalFallbackAtMs = null;
		} else if (previousIndicator === 'working' && terminalFallbackAtMs === null) {
			terminalFallbackAtMs = Date.now();
		}
		previousIndicator = indicator;
	});

	$effect(() => {
		if (indicator !== 'working') return;
		nowMs = Date.now();
		const timer = setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	// Expand/collapse is user-owned, NOT driven by the `open` prop. It starts
	// closed and only the user toggles it. Decoupling from `open` means a new
	// tool call arriving (which re-renders this block) never re-opens a list the
	// user has collapsed, and the list always starts collapsed.
	let detailsOpen = $state(false);

	const KIND: Record<string, { glyph: string; color: string; label: string }> = {
		thinking: { glyph: '✦', color: '#a371f7', label: 'Thinking' },
		progress: { glyph: '›', color: 'var(--color-accent)', label: 'Working' },
		tool_output: { glyph: '↳', color: '#3fb950', label: 'Output' }
	};

	function kind(type: string | undefined) {
		return (type && KIND[type]) || KIND.progress;
	}

	// Derive the chip's one-line "base command" from a step's markdown content:
	// prefer the first line inside a fenced code block, else the first non-empty
	// line. Light leading-markup (headings / list bullets) is stripped, but
	// inline markdown — code spans, bold, italic, links — is preserved so the
	// chip row can render it (see summaryHtml).
	function summaryLine(content: string | null | undefined): string {
		if (!content) return '';
		const fence = content.match(/```[^\n]*\n([^\n]+)/);
		const raw = fence ? fence[1] : (content.split('\n').find((l) => l.trim()) ?? '');
		return raw
			.replace(/^#+\s*/, '') // headings
			.replace(/^[-*]\s+/, '') // list bullets
			.trim();
	}

	// Render the chip's summary line with inline markdown (code, bold, italic,
	// strikethrough) so a `code`-formatted command shows as code in the row.
	function summaryHtml(content: string | null | undefined): string {
		const line = summaryLine(content);
		return line ? renderInlineMarkdown(line) : '';
	}

	// A chip is expandable only when there's more than the one summary line.
	function isMultiline(content: string | null | undefined): boolean {
		if (!content) return false;
		return content.split('\n').filter((l) => l.trim()).length > 1;
	}

	// The row already renders the first meaningful line as the tool title. Hide
	// that line from the expanded body so opening a row reveals only details.
	function detailContent(content: string | null | undefined): string {
		if (!content) return '';
		const lines = content.split('\n');
		const firstMeaningfulLine = lines.findIndex((line) => line.trim());
		if (firstMeaningfulLine === -1) return '';
		return lines.slice(firstMeaningfulLine + 1).join('\n').trim();
	}

	// Per-chip expansion state, keyed by message id.
	let expanded = $state<Record<string, boolean>>({});
	function toggle(id: string) {
		expanded[id] = !expanded[id];
	}

	// Collapsing the whole list resets any chips the user had expanded, so
	// re-opening the list always starts with every chip collapsed.
	$effect(() => {
		if (!detailsOpen) expanded = {};
	});
</script>

<div class="px-4 py-0.5">
	<details class="agent-steps" bind:open={detailsOpen}>
		<summary>
			<span class="chevron" aria-hidden="true">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="6 4 10 8 6 12" />
				</svg>
			</span>
			{#if indicator === 'working'}
				<span class="spinner"><BrailleSpinner /></span>
			{:else if indicator === 'error'}
				<span class="err" aria-hidden="true">✗</span>
			{:else if indicator === 'restarted'}
				<span class="restarted" aria-hidden="true">↻</span>
			{:else if indicator === 'killed'}
				<span class="killed" aria-hidden="true">◼</span>
			{:else}
				<span class="check" aria-hidden="true">✓</span>
			{/if}
			<span class="title">{agentName}</span>
			<span class="meta" class:meta-error={indicator === 'error'} class:meta-restarted={indicator === 'restarted'}>{metaVerb}</span>
			{#if indicator === 'working' && triggerMessageId && processId && onprocesskill}
				<button
					type="button"
					class="cancel"
					title={status === 'queued' ? 'Cancel queued process' : 'Stop process'}
					aria-label={status === 'queued' ? 'Cancel queued process' : 'Stop process'}
					onclick={(e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						onprocesskill?.(triggerMessageId, processId);
					}}
				>
					<Stop size={12} weight="fill" />
				</button>
			{/if}
		</summary>

		<div class="chips" role="list">
			{#each messages as step (step.id)}
				{@const k = kind(step.message_type)}
				{@const summary = summaryHtml(step.content)}
				{@const multi = isMultiline(step.content)}
				{@const isOpen = !!expanded[step.id]}
				{@const detail = detailContent(step.content)}
				<div class="chip" class:open={isOpen} role="listitem">
					<button
						type="button"
						class="chip-head"
						onclick={() => multi && toggle(step.id)}
						disabled={!multi}
						aria-expanded={multi ? isOpen : undefined}
					>
						{#if multi}
							<span class="chip-caret" aria-hidden="true">
								<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="6 4 10 8 6 12" />
								</svg>
							</span>
						{/if}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<span class="chip-label">{#if summary}{@html summary}{:else}{k.label}{/if}</span>
						<span class="chip-time">{formatTime(step.created_at)}</span>
					</button>
					{#if isOpen && detail}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						<div class="chip-detail">{@html renderMarkdown(detail, knownUsernames, knownChannelNames)}</div>
					{/if}
				</div>
			{/each}
		</div>
	</details>
</div>

<style>
	.agent-steps {
		font-size: 0.8125rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-bg-surface, #111) 60%, transparent);
		overflow: hidden;
	}

	summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.625rem;
		cursor: pointer;
		user-select: none;
		color: var(--color-text-muted);
		list-style: none;
		transition: color 0.15s, background 0.15s;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover {
		color: var(--color-text);
		background: color-mix(in srgb, var(--color-text) 4%, transparent);
	}

	.chevron {
		display: inline-flex;
		transition: transform 0.15s ease;
		color: var(--color-text-muted);
	}
	.agent-steps[open] .chevron {
		transform: rotate(90deg);
	}

	.spinner {
		display: inline-flex;
		color: var(--color-accent);
		font-size: 0.75rem;
	}
	.check {
		color: #3fb950;
		font-weight: 700;
		font-size: 0.75rem;
	}
	.err {
		color: var(--color-danger, #f85149);
		font-weight: 700;
		font-size: 0.75rem;
	}
	.restarted {
		color: #d29922;
		font-weight: 700;
		font-size: 0.75rem;
	}
	.killed {
		color: var(--color-text-muted);
		font-weight: 700;
		font-size: 0.7rem;
	}
	.meta-error {
		color: var(--color-danger, #f85149);
		opacity: 1;
	}
	.meta-restarted {
		color: #d29922;
		opacity: 1;
	}

	.title {
		font-weight: 600;
		color: var(--color-text);
	}
	.meta {
		opacity: 0.7;
	}
	.cancel {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.125rem;
		border-radius: 9999px;
		color: var(--color-text-muted);
		transition: color 0.15s, background 0.15s;
	}
	.cancel:hover {
		color: var(--color-danger, #f85149);
		background: color-mix(in srgb, var(--color-danger, #f85149) 10%, transparent);
	}

	/* Scrollable chip rail — one chip per tool call. Caps height so a long run
	   doesn't push the conversation down; scrolls within the block instead. */
	.chips {
		border-top: 1px solid var(--color-border);
		padding: 0.125rem 0;
		display: flex;
		flex-direction: column;
		max-height: 15rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.chip {
		flex: 0 0 auto; /* never let a tall expanded chip squeeze its neighbors — scroll the rail instead */
		overflow: hidden;
	}
	/* Dividing hairline between tool calls instead of a box per chip — quieter rail. */
	.chip:not(:first-child) {
		border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
	}
	.chip.open {
		background: color-mix(in srgb, var(--color-text) 3%, transparent);
	}

	.chip-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.3125rem 0.5rem;
		background: none;
		border: none;
		color: var(--color-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.chip-head:disabled {
		cursor: default;
	}
	.chip-head:not(:disabled):hover {
		background: color-mix(in srgb, var(--color-text) 5%, transparent);
	}

	.chip-label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
	}
	.chip-time {
		flex: 0 0 auto;
		font-size: 0.6875rem;
		color: var(--color-text-muted);
		opacity: 0.7;
	}
	.chip-caret {
		flex: 0 0 auto;
		display: inline-flex;
		color: var(--color-text-muted);
		transition: transform 0.15s ease;
	}
	.chip.open .chip-caret {
		transform: rotate(90deg);
	}

	.chip-detail {
		border-top: 1px solid var(--color-border);
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text);
		word-break: break-word;
		/* No inner scroll — the chip grows to fit its content and the outer
		   .chips rail handles overflow for the whole list. */
	}

	/* Tame markdown spacing inside an expanded chip. */
	.chip-detail :global(p) {
		margin: 0 0 0.25rem;
	}
	.chip-detail :global(p:last-child) {
		margin-bottom: 0;
	}
	.chip-detail :global(pre) {
		margin: 0.25rem 0;
		padding: 0.375rem 0.5rem;
		background: var(--color-bg, #000);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow-x: auto;
		font-size: 0.75rem;
	}
	.chip-detail :global(code) {
		font-size: 0.75rem;
	}
</style>
