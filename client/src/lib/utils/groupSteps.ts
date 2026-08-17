import type { Message } from '$lib/state/messages.svelte.js';

/**
 * Agent step message types. These are the intermediate tool-call / reasoning
 * messages an agent emits while working — they should NOT each render as their
 * own message bubble (clutter). Instead consecutive runs are collapsed into a
 * single styled, expandable AgentSteps block (Cursor-style).
 */
const STEP_TYPES = new Set(['progress', 'tool_output', 'thinking']);

export function isStepMessage(m: Message): boolean {
	return !!m.message_type && STEP_TYPES.has(m.message_type);
}

export type RenderItem =
	| { kind: 'message'; message: Message; hasStepBlock?: boolean }
	| {
			kind: 'steps';
			id: string;
			userId: string;
			messages: Message[];
			open: boolean;
			triggerMessageId?: string;
			processId?: string;
			// Process status of the triggering message (queued | processing | done |
			// error | killed | restarted), threaded through so the block's summary
			// indicator mirrors the same green/red/yellow states as the process pill.
			// Undefined for legacy/orphaned runs whose trigger is out of the window —
			// those fall back to the `open` heuristic.
			status?: string;
	  };

/**
 * Walk a chronological message list and collapse agent step messages into a
 * single `steps` render item per agent loop. Everything else passes through as
 * a `message` item.
 *
 * Anchoring: each step row carries `metadata.trigger_id` — the id of the message
 * that triggered the agent loop. All steps sharing a trigger collapse into one
 * block rendered right after that triggering message, regardless of where the
 * individual rows land in the timeline. This keeps a late step (e.g. a journal
 * write that fires after the agent's reply) attached to the originating block
 * rather than orphaning a second rail at the bottom of the channel.
 *
 * Out-of-window trigger: when a trigger_id is stamped but its message is paged
 * out of the loaded window (e.g. a deep link / jump-to-message centers the view
 * on a later message, leaving the human trigger above the window), the rows
 * still collapse into ONE block — grouped by trigger_id, rendered in place at
 * the first row, closed by default. This avoids the prior failure where an
 * interleaved `response` split the run into several open rails that read like
 * loose tool-call bubbles.
 *
 * Fallback: step rows with no trigger_id at all (older producers) collapse by
 * the legacy rule — maximal runs of consecutive same-sender steps.
 *
 * Open state: a block is "working" (open, spinner) while the most recent message
 * in the channel is one of its step rows; once the agent posts its reply (or any
 * newer message arrives) it collapses closed.
 */
export function groupMessages(list: Message[]): RenderItem[] {
	const items: RenderItem[] = [];

	// Anchors present in this window — only these can host an anchored block.
	const present = new Set(list.map((m) => m.id));

	// Bucket step rows by trigger id — both in-window anchors and out-of-window
	// triggers paged out of the loaded view.
	const buckets = new Map<string, Message[]>();
	for (const m of list) {
		if (!isStepMessage(m)) continue;
		const tid = m.metadata?.trigger_id;
		if (!tid) continue;
		const arr = buckets.get(tid);
		if (arr) arr.push(m);
		else buckets.set(tid, [m]);
	}

	const lastId = list.length ? list[list.length - 1].id : null;
	const bucketOpen = (msgs: Message[]) => msgs.some((m) => m.id === lastId);

	// Out-of-window trigger buckets render once, at the first row encountered.
	const emittedOrphan = new Set<string>();

	// Legacy consecutive run for step rows with no trigger_id at all.
	let run: Message[] = [];
	let runUser: string | null = null;
	const flush = (open: boolean) => {
		if (run.length === 0) return;
		items.push({
			kind: 'steps',
			id: `steps-${run[0].id}`,
			userId: runUser as string,
			messages: run,
			open,
		});
		run = [];
		runUser = null;
	};

	for (const m of list) {
		if (isStepMessage(m)) {
			const tid = m.metadata?.trigger_id;
			if (tid && buckets.has(tid)) {
				if (present.has(tid)) {
					// Anchored at its in-window trigger — rendered there, skip in place.
					continue;
				}
				// Trigger paged out of the window: render the whole bucket once,
				// in place at the first row, collapsed (no trigger to attach to).
				if (emittedOrphan.has(tid)) continue;
				emittedOrphan.add(tid);
				flush(false);
				const bucket = buckets.get(tid) as Message[];
				items.push({
					kind: 'steps',
					id: `steps-${tid}`,
					userId: bucket[0].user_id as string,
					messages: bucket,
					open: bucketOpen(bucket),
				});
				continue;
			}
			// No trigger id at all → legacy consecutive run. A run only spans one
			// sender; a new sender starts a fresh block.
			if (run.length > 0 && runUser !== m.user_id) {
				flush(false);
			}
			run.push(m);
			runUser = m.user_id;
		} else {
			// A non-step message concludes any open run, then renders normally.
			flush(false);
			// m is in-window, so buckets.get(m.id) is its anchored bucket (if any).
			const bucket = buckets.get(m.id);
			items.push({ kind: 'message', message: m, hasStepBlock: !!bucket && bucket.length > 0 });
			// If this message anchors a step bucket, drop the rail right after it.
			if (bucket && bucket.length > 0) {
				items.push({
					kind: 'steps',
					id: `steps-${m.id}`,
					userId: bucket[0].user_id as string,
					messages: bucket,
					open: bucketOpen(bucket),
					triggerMessageId: m.id,
					processId: m.process_id ?? undefined,
					status: m.process_status ?? undefined,
				});
			}
		}
	}
	// Trailing run has no following message → still in progress → leave open.
	flush(true);
	return items;
}
