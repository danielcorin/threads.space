import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';

const mockProcesses = vi.hoisted(() => ({
	list: [] as Array<Record<string, unknown>>,
	load: vi.fn().mockResolvedValue(undefined),
	kill: vi.fn().mockResolvedValue(undefined),
	killAll: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/state/processes.svelte.js', () => ({
	processes: {
		get list() {
			return mockProcesses.list;
		},
		get runningCount() {
			return mockProcesses.list.filter((p) => p.status === 'running' || p.status === 'queued').length;
		},
		load: mockProcesses.load,
		kill: mockProcesses.kill,
		killAll: mockProcesses.killAll
	}
}));

import ProcessesPage from './ProcessesPage.svelte';

function makeProcess(overrides: Record<string, unknown> = {}) {
	return {
		id: 'proc-1',
		channel_id: 'ch-1',
		channel_name: 'general',
		message_id: 'msg-1',
		thread_id: null,
		user_id: 'user-1',
		username: 'alice',
		display_name: 'Alice',
		status: 'done',
		started_at: new Date().toISOString(),
		ended_at: new Date().toISOString(),
		tool_call_count: 0,
		reply_count: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		updated_at: null,
		bot_id: 'bot-1',
		bot_username: 'bot',
		bot_display_name: 'Bot',
		is_dm: 0,
		dm_partner_id: null,
		dm_partner_display_name: null,
		dm_partner_username: null,
		resolved_at: null,
		resolved_by: null,
		...overrides
	};
}

describe('ProcessesPage', () => {
	beforeEach(() => {
		mockProcesses.list = [];
		mockProcesses.load.mockClear();
		mockProcesses.kill.mockClear();
		mockProcesses.killAll.mockClear();
	});

	it('keeps resolved done processes labeled as done and adds a separate resolved marker', () => {
		mockProcesses.list = [
			makeProcess({
				resolved_at: Math.floor(Date.now() / 1000),
				resolved_by: 'user-1'
			})
		];

		const screen = render(ProcessesPage);
		const statuses = Array.from(screen.baseElement.querySelectorAll('[data-testid="process-status"]'));
		const markers = Array.from(screen.baseElement.querySelectorAll('[data-testid="process-resolved-marker"]'));

		expect(statuses.map((status) => status.textContent?.trim())).toEqual(['done', 'done']);
		expect(markers).toHaveLength(2);
		expect(markers.every((marker) => marker.getAttribute('title') === 'Parent message resolved')).toBe(true);
	});

	it('shows the resolved marker without replacing non-done process status', () => {
		mockProcesses.list = [
			makeProcess({
				status: 'error',
				resolved_at: Math.floor(Date.now() / 1000),
				resolved_by: 'user-1'
			})
		];

		const screen = render(ProcessesPage);
		const statuses = Array.from(screen.baseElement.querySelectorAll('[data-testid="process-status"]'));
		const markers = Array.from(screen.baseElement.querySelectorAll('[data-testid="process-resolved-marker"]'));

		expect(statuses.map((status) => status.textContent?.trim())).toEqual(['error', 'error']);
		expect(markers).toHaveLength(2);
	});

	it('renders restarted processes as a distinct terminal status', () => {
		mockProcesses.list = [makeProcess({ status: 'restarted' })];

		const screen = render(ProcessesPage);
		const statuses = Array.from(screen.baseElement.querySelectorAll('[data-testid="process-status"]'));
		const filter = screen.baseElement.querySelector('[data-testid="process-status-filter"]') as HTMLSelectElement;

		expect(statuses.map((status) => status.textContent?.trim())).toEqual(['restarted', 'restarted']);
		expect(Array.from(filter.options).some((option) => option.value === 'restarted')).toBe(true);
	});

	it('filters to processes that have not been resolved', async () => {
		mockProcesses.list = [
			makeProcess({
				id: 'resolved-proc',
				channel_name: 'resolved-channel',
				resolved_at: Math.floor(Date.now() / 1000),
				resolved_by: 'user-1'
			}),
			makeProcess({
				id: 'open-proc',
				channel_name: 'open-channel',
				message_id: 'msg-2'
			})
		];

		const screen = render(ProcessesPage);
		const filter = screen.baseElement.querySelector('[data-testid="process-status-filter"]') as HTMLSelectElement;
		filter.value = 'unresolved';
		filter.dispatchEvent(new Event('change', { bubbles: true }));
		await tick();

		expect(screen.baseElement.textContent).toContain('open-channel');
		expect(screen.baseElement.textContent).not.toContain('resolved-channel');
	});
});
