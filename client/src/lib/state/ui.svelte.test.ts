import { beforeEach, describe, expect, test } from 'vitest';
import { ui } from './ui.svelte.js';

const TASK_AUTHOR_FILTERS_STORAGE_KEY = 'threads.tasks.author-filters';

function rehydrateUi() {
	const cleanup = ui.init();
	cleanup();
}

describe('task author filters', () => {
	beforeEach(() => {
		localStorage.removeItem(TASK_AUTHOR_FILTERS_STORAGE_KEY);
		rehydrateUi();
	});

	test('persists independent selections for each channel', () => {
		ui.setTaskAuthorFilter('channel-a', ['user:bot', 'user:bot']);
		ui.setTaskAuthorFilter('channel-b', []);

		expect(ui.taskAuthorFilters).toEqual({
			'channel-a': ['user:bot'],
			'channel-b': []
		});
		expect(JSON.parse(localStorage.getItem(TASK_AUTHOR_FILTERS_STORAGE_KEY) ?? '{}')).toEqual({
			'channel-a': ['user:bot'],
			'channel-b': []
		});
	});

	test('hydrates saved per-channel selections', () => {
		localStorage.setItem(
			TASK_AUTHOR_FILTERS_STORAGE_KEY,
			JSON.stringify({ 'channel-a': ['user:agent'], 'channel-b': ['user:person'] })
		);

		rehydrateUi();

		expect(ui.taskAuthorFilters['channel-a']).toEqual(['user:agent']);
		expect(ui.taskAuthorFilters['channel-b']).toEqual(['user:person']);
	});

	test('clearing a channel restores the all-authors default', () => {
		ui.setTaskAuthorFilter('channel-a', ['user:bot']);
		ui.setTaskAuthorFilter('channel-b', ['user:person']);

		ui.setTaskAuthorFilter('channel-a', null);

		expect(ui.taskAuthorFilters['channel-a']).toBeUndefined();
		expect(ui.taskAuthorFilters['channel-b']).toEqual(['user:person']);
	});
});
