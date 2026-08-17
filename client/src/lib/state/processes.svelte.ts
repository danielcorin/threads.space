import { api } from '$lib/api.js';

// A process is one agent turn. It has no OS pid — it is identified by its own id, and
// "cancel" is cooperative: the API marks it killed and signals the agent (WS + webhook).
export interface Process {
	id: string;
	channel_id: string;
	channel_name: string;
	message_id: string;
	thread_id?: string | null;
	user_id: string;
	username: string;
	display_name: string | null;
	status: 'queued' | 'running' | 'done' | 'error' | 'killed' | 'restarted';
	started_at: string;
	ended_at: string | null;
	tool_call_count: number;
	reply_count: number;
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	updated_at: string | null;
	bot_id?: string | null;
	bot_username?: string | null;
	bot_display_name?: string | null;
	is_dm?: number;
	dm_partner_id?: string | null;
	dm_partner_display_name?: string | null;
	dm_partner_username?: string | null;
	resolved_at?: number | null;
	resolved_by?: string | null;
}

let _processes = $state<Process[]>([]);

export const processes = {
	get list() {
		return _processes;
	},
	get running(): Process[] {
		return _processes.filter((p) => p.status === 'running' || p.status === 'queued');
	},
	get runningCount(): number {
		return _processes.filter((p) => p.status === 'running' || p.status === 'queued').length;
	},
	get activeChannelIds(): Set<string> {
		const ids = new Set<string>();
		for (const p of _processes) {
			if (p.status === 'running' || p.status === 'queued') {
				ids.add(p.channel_id);
			}
		}
		return ids;
	},

	async load(status?: string) {
		try {
			const data = (await api.processes.list(status)) as { processes: Process[] };
			// Deduplicate by id in case JOINs produce duplicate rows
			const seen = new Set<string>();
			_processes = data.processes.filter((p) => {
				if (seen.has(p.id)) return false;
				seen.add(p.id);
				return true;
			});
		} catch (e) {
			console.error('Failed to load processes:', e);
		}
	},

	async killAll() {
		await api.processes.killAll();
		const now = new Date().toISOString();
		_processes = _processes.map((p) =>
			p.status === 'running' || p.status === 'queued'
				? { ...p, status: 'killed' as const, ended_at: now }
				: p
		);
	},

	async kill(id: string) {
		await api.processes.kill(id);
		// Optimistically update local state; the process_updated event confirms it.
		const idx = _processes.findIndex((p) => p.id === id);
		if (idx >= 0) {
			_processes[idx] = {
				..._processes[idx],
				status: 'killed',
				ended_at: new Date().toISOString()
			};
		}
	},

	updateFromEvent(data: { process: Partial<Process> }) {
		const incoming = data.process;
		if (!incoming?.id) return;

		const idx = _processes.findIndex((p) => p.id === incoming.id);
		if (idx >= 0) {
			_processes[idx] = { ..._processes[idx], ...incoming };
		} else {
			// New process — add it to the list
			_processes = [incoming as Process, ..._processes];
		}
	},

	updateMessageResolution(messageId: string, resolvedAt: number | null, resolvedBy: string | null) {
		_processes = _processes.map((p) =>
			p.message_id === messageId || p.thread_id === messageId
				? { ...p, resolved_at: resolvedAt, resolved_by: resolvedBy }
				: p
		);
	},

	clear() {
		_processes = [];
	}
};
