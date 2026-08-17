import { describe, expect, test, beforeEach, vi } from 'vitest';
import { codeTheme, DEFAULT_CODE_THEME, isValidCodeTheme, CODE_THEME_KEYS } from './codeTheme.svelte.js';
import { api } from '$lib/api.js';

// Spy on the network call so we can assert what gets persisted without
// actually hitting an API.
const updateProfileSpy = vi.spyOn(api.users, 'updateProfile').mockResolvedValue({ ok: true } as any);

beforeEach(() => {
	updateProfileSpy.mockClear();
	// Reset to default before each test by hydrating with NULL.
	codeTheme.hydrate(null);
});

describe('codeTheme', () => {
	test('NULL profile field resolves to monokai-sublime default', () => {
		codeTheme.hydrate(null);
		expect(codeTheme.value).toBe(DEFAULT_CODE_THEME);
		expect(codeTheme.value).toBe('monokai-sublime');
	});

	test('undefined profile field resolves to default', () => {
		codeTheme.hydrate(undefined);
		expect(codeTheme.value).toBe(DEFAULT_CODE_THEME);
	});

	test('unknown profile value resolves to default', () => {
		codeTheme.hydrate('nonexistent-theme');
		expect(codeTheme.value).toBe(DEFAULT_CODE_THEME);
	});

	test('valid profile value hydrates that theme', () => {
		codeTheme.hydrate('dracula');
		expect(codeTheme.value).toBe('dracula');
	});

	test('className returns theme- prefixed key', () => {
		codeTheme.hydrate('github-dark');
		expect(codeTheme.className).toBe('theme-github-dark');
	});

	test('setting a non-default theme persists the value', async () => {
		await codeTheme.set('dracula');
		expect(codeTheme.value).toBe('dracula');
		expect(updateProfileSpy).toHaveBeenCalledWith({ codeTheme: 'dracula' });
	});

	test('setting back to default persists NULL (clears the field)', async () => {
		await codeTheme.set('dracula');
		updateProfileSpy.mockClear();
		await codeTheme.set(DEFAULT_CODE_THEME);
		expect(codeTheme.value).toBe(DEFAULT_CODE_THEME);
		expect(updateProfileSpy).toHaveBeenCalledWith({ codeTheme: null });
	});

	test('setting an invalid theme is a no-op (no state change, no PATCH)', async () => {
		codeTheme.hydrate('dracula');
		await codeTheme.set('not-a-real-theme');
		expect(codeTheme.value).toBe('dracula');
		expect(updateProfileSpy).not.toHaveBeenCalled();
	});

	test('isValidCodeTheme accepts registered keys', () => {
		for (const key of CODE_THEME_KEYS) {
			expect(isValidCodeTheme(key)).toBe(true);
		}
	});

	test('isValidCodeTheme rejects unknown values', () => {
		expect(isValidCodeTheme('nope')).toBe(false);
		expect(isValidCodeTheme(null)).toBe(false);
		expect(isValidCodeTheme(undefined)).toBe(false);
		expect(isValidCodeTheme(42)).toBe(false);
	});
});
