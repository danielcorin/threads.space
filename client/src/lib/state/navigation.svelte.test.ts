import { beforeEach, describe, expect, it } from 'vitest';
import { navigation, type NavEntry } from './navigation.svelte.js';

function entry(view: NavEntry['view'], channelId: string | null = null): NavEntry {
	return { view, channelId, dmId: null, threadMessageId: null };
}

describe('navigation stack', () => {
	beforeEach(() => navigation.reset());

	it('preserves Inbox, Feedback, and Processes in back/forward order', () => {
		const channel = entry('channels', 'general');
		const inbox = entry('inbox');
		const feedback = entry('channels', 'feedback');
		const processes = entry('processes');

		navigation.push(channel);
		navigation.push(inbox);
		navigation.push(feedback);
		navigation.push(processes);

		expect(navigation.back()).toEqual(feedback);
		expect(navigation.back()).toEqual(inbox);
		expect(navigation.forward()).toEqual(feedback);
		expect(navigation.forward()).toEqual(processes);
	});

	it('treats different top-level views as distinct entries', () => {
		navigation.push(entry('inbox'));
		navigation.push(entry('processes'));

		expect(navigation.canGoBack).toBe(true);
		expect(navigation.back()).toEqual(entry('inbox'));
	});
});
