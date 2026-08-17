import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { thread } from './thread.svelte.js';
import type { Message } from './messages.svelte.js';

function msg(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		channel_id: 'chan-1',
		user_id: 'u1',
		content: `message ${id}`,
		thread_id: null,
		type: 'message',
		edited_at: null,
		deleted_at: null,
		created_at: 1,
		...overrides,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('thread reply loading', () => {
	beforeEach(() => {
		thread.close();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		thread.close();
	});

	it('opens on the latest reply page and pages older replies with before cursor', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('latest=true')) {
				return jsonResponse({
					messages: [
						msg('reply-03', { thread_id: 'parent-1' }),
						msg('reply-04', { thread_id: 'parent-1' }),
					],
					cursor: 'reply-03',
				});
			}
			if (url.includes('before=reply-03')) {
				return jsonResponse({
					messages: [
						msg('reply-01', { thread_id: 'parent-1' }),
						msg('reply-02', { thread_id: 'parent-1' }),
					],
					cursor: null,
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await thread.openThread(msg('parent-1'));
		expect(thread.replies.map((m) => m.id)).toEqual(['reply-03', 'reply-04']);
		expect(thread.hasMore).toBe(true);

		await thread.loadMore();
		expect(thread.replies.map((m) => m.id)).toEqual([
			'reply-01',
			'reply-02',
			'reply-03',
			'reply-04',
		]);
		expect(thread.hasMore).toBe(false);

		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls[0]).toContain('/messages/parent-1/replies?latest=true');
		expect(urls[1]).toContain('/messages/parent-1/replies?before=reply-03');
	});

	it('opens around a target reply and can page newer replies', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/messages/parent-1')) {
				return jsonResponse(msg('parent-1'));
			}
			if (url.includes('around=reply-02')) {
				return jsonResponse({
					messages: [
						msg('reply-01', { thread_id: 'parent-1' }),
						msg('reply-02', { thread_id: 'parent-1' }),
						msg('reply-03', { thread_id: 'parent-1' }),
					],
					cursor: 'reply-01',
					afterCursor: 'reply-03',
					hasNewer: true,
				});
			}
			if (url.includes('after=reply-03')) {
				return jsonResponse({
					messages: [msg('reply-04', { thread_id: 'parent-1' })],
					afterCursor: null,
					hasNewer: false,
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await thread.openThread(
			msg('reply-02', { thread_id: 'parent-1' }),
			{ aroundReplyId: 'reply-02', highlightReplyId: 'reply-02' }
		);
		expect(thread.parentMessage?.id).toBe('parent-1');
		expect(thread.replies.map((m) => m.id)).toEqual(['reply-01', 'reply-02', 'reply-03']);
		expect(thread.highlightReplyId).toBe('reply-02');
		expect(thread.hasMore).toBe(true);
		expect(thread.hasNewer).toBe(true);

		await thread.loadNewer();
		expect(thread.replies.map((m) => m.id)).toEqual([
			'reply-01',
			'reply-02',
			'reply-03',
			'reply-04',
		]);
		expect(thread.hasNewer).toBe(false);

		const urls = fetchMock.mock.calls.map((call) => String(call[0]));
		expect(urls[1]).toContain('/messages/parent-1/replies?around=reply-02');
		expect(urls[2]).toContain('/messages/parent-1/replies?after=reply-03');
	});
});
