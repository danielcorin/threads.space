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

describe('iOS keyboard viewport tracking', () => {
	function measureDvh() {
		const probe = document.createElement('div');
		probe.style.cssText = 'position:absolute;height:100dvh;width:0';
		document.body.appendChild(probe);
		const height = probe.offsetHeight;
		probe.remove();
		return height;
	}

	function fakeVisualViewport(height: number) {
		const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number; scale: number };
		vv.height = height;
		vv.offsetTop = 0;
		vv.scale = 1;
		return vv;
	}

	test('detects the keyboard when innerHeight shrinks with it but 100dvh does not', async () => {
		const keyboardOpenHeight = measureDvh() - 300;
		expect(keyboardOpenHeight).toBeGreaterThan(0);

		const vv = fakeVisualViewport(keyboardOpenHeight);
		Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: keyboardOpenHeight, configurable: true });
		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const cleanup = ui.init();
		try {
			textarea.focus();
			vv.dispatchEvent(new Event('resize'));

			expect(ui.viewportHeight).toBe(keyboardOpenHeight);
			expect(document.documentElement.style.getPropertyValue('--keyboard-viewport-height')).toBe(
				`${keyboardOpenHeight}px`
			);

			textarea.blur();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(ui.viewportHeight).toBeNull();
			expect(document.documentElement.style.getPropertyValue('--keyboard-viewport-height')).toBe('');
		} finally {
			cleanup();
			textarea.remove();
			delete (window as { visualViewport?: unknown }).visualViewport;
			delete (window as { innerHeight?: unknown }).innerHeight;
		}
	});
});
