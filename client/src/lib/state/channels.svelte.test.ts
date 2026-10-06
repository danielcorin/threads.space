import { afterEach, expect, test, vi } from 'vitest';
import { channels } from './channels.svelte.js';

afterEach(() => {
	for (const channel of [...channels.list]) channels.removeLocal(channel.id);
	channels.select(null);
	vi.unstubAllGlobals();
});

test('selects a new ephemeral channel without waiting for a channel-list request', async () => {
	const channel = { id: 'ephemeral-1', name: 'ephemeral-test', is_ephemeral: 1, is_private: 1, is_dm: 0 };
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		if (String(input).endsWith('/channels/ephemeral')) return new Response(JSON.stringify(channel));
		throw new Error('Unexpected channel-list request');
	});
	vi.stubGlobal('fetch', fetchMock);
	await channels.createEphemeral();
	expect(channels.selectedId).toBe(channel.id);
	expect(channels.selected).toMatchObject({ ...channel, notifications: 'all', has_unread: 0 });
	expect(fetchMock).toHaveBeenCalledTimes(1);
});
