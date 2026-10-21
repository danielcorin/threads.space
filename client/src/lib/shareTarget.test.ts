import { describe, expect, it } from 'vitest';
import { SHARE_TARGET_CACHE, sharedMessageText, takeSharedFiles } from './shareTarget.js';

describe('sharedMessageText', () => {
	it('joins title and url from a shared web page', () => {
		const params = new URLSearchParams({ title: 'An article', url: 'https://example.com/a' });
		expect(sharedMessageText(params)).toBe('An article\nhttps://example.com/a');
	});

	it('skips fields the text already contains', () => {
		const params = new URLSearchParams({
			title: 'An article',
			text: 'An article https://example.com/a',
			url: 'https://example.com/a',
		});
		expect(sharedMessageText(params)).toBe('An article https://example.com/a');
	});

	it('skips a title that is just the url', () => {
		const params = new URLSearchParams({ title: 'https://example.com/a', url: 'https://example.com/a' });
		expect(sharedMessageText(params)).toBe('https://example.com/a');
	});

	it('returns empty text when nothing was shared', () => {
		expect(sharedMessageText(new URLSearchParams({ 'share-target': '1' }))).toBe('');
	});
});

describe('takeSharedFiles', () => {
	it('reads files stored the way sw.js stores them, then clears them', async () => {
		const cache = await caches.open(SHARE_TARGET_CACHE);
		await cache.put(
			'/share-target/file/0',
			new Response(new Blob(['hello'], { type: 'text/plain' }), {
				headers: { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('notes è.txt') },
			})
		);

		const files = await takeSharedFiles();
		expect(files).toHaveLength(1);
		expect(files[0].name).toBe('notes è.txt');
		expect(files[0].type).toBe('text/plain');
		expect(await files[0].text()).toBe('hello');

		expect(await caches.has(SHARE_TARGET_CACHE)).toBe(false);
		expect(await takeSharedFiles()).toEqual([]);
	});
});
