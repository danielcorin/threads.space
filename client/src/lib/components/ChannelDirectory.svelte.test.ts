import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChannelDirectory from './ChannelDirectory.svelte';

vi.mock('$lib/api.js', () => ({
	api: {
		channels: {
			browse: vi.fn().mockResolvedValue([
				{ id: 'ch1', name: 'general', description: 'General chat', is_member: 1, member_count: 3 }
			])
		}
	}
}));

vi.mock('$lib/state/channels.svelte.js', () => ({
	channels: {
		join: vi.fn().mockResolvedValue(undefined),
		select: vi.fn()
	}
}));

describe('ChannelDirectory', () => {
	const onclose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('focuses the search input on open', async () => {
		render(ChannelDirectory, { onclose });

		const input = page.getByTestId('browse-search-input');
		await expect.element(input).toBeVisible();

		expect(document.activeElement).toBe(input.element());
	});
});
