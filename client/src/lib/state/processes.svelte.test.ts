import { beforeEach, describe, expect, it } from 'vitest';
import { processes, type Process } from './processes.svelte.js';

function updateProcess(id: string, channelId: string, status: Process['status']) {
	processes.updateFromEvent({
		process: { id, channel_id: channelId, status }
	});
}

describe('processes.activeChannelIds', () => {
	beforeEach(() => {
		processes.clear();
	});

	it('includes channels with running or queued processes', () => {
		updateProcess('running-process', 'running-channel', 'running');
		updateProcess('queued-process', 'queued-channel', 'queued');
		updateProcess('done-process', 'done-channel', 'done');

		expect(processes.activeChannelIds).toEqual(new Set(['running-channel', 'queued-channel']));
	});

	it('stops marking a channel active when its process becomes terminal', () => {
		updateProcess('process-1', 'channel-1', 'running');
		expect(processes.activeChannelIds.has('channel-1')).toBe(true);

		updateProcess('process-1', 'channel-1', 'done');
		expect(processes.activeChannelIds.has('channel-1')).toBe(false);
	});
});
