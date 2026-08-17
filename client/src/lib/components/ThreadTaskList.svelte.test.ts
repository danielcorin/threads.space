import { render } from 'vitest-browser-svelte';
import { describe, expect, test, vi } from 'vitest';
import type { Message } from '$lib/state/messages.svelte.js';
import ThreadTaskList from './ThreadTaskList.svelte';

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: 'msg-1',
		channel_id: 'ch-1',
		user_id: 'user-1',
		content: 'Investigate the deployment issue',
		thread_id: null,
		type: 'message',
		edited_at: null,
		deleted_at: null,
		created_at: Date.now() / 1000,
		username: 'alice',
		display_name: 'Alice',
		name_color: null,
		avatar_url: null,
		reactions: [],
		reply_count: 0,
		attachments: [],
		linkPreviews: [],
		process_id: null,
		process_status: null,
		metadata: null,
		...overrides
	};
}

describe('ThreadTaskList', () => {
	test('centers open top-level messages on their thread titles', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [makeMessage({ thread_title: 'Repair sim bot', reply_count: 4 })],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		await expect.element(screen.getByText('Repair sim bot')).toBeInTheDocument();
		await expect.element(screen.getByText('Alice')).toBeInTheDocument();
		await expect.element(screen.getByText('4', { exact: true })).toBeInTheDocument();
		expect(screen.baseElement.textContent).not.toContain('Investigate the deployment issue');
	});

	test('falls back to message content when a thread has no title', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [makeMessage({ content: '**Review** the launch checklist' })],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		await expect.element(screen.getByText('Review the launch checklist')).toBeInTheDocument();
	});

	test('shows only root messages as work items', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [
					makeMessage({ id: 'root', thread_title: 'Root item' }),
					makeMessage({ id: 'reply', thread_id: 'root', content: 'Thread reply' }),
					makeMessage({ id: 'system', type: 'system', content: 'System event' }),
					makeMessage({ id: 'step', message_type: 'thinking', content: 'Agent progress' })
				],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		await expect.element(screen.getByText('Root item')).toBeInTheDocument();
		expect(screen.baseElement.textContent).not.toContain('Thread reply');
		expect(screen.baseElement.textContent).not.toContain('System event');
		expect(screen.baseElement.textContent).not.toContain('Agent progress');
	});

	test('separates completed work and toggles completion from the row control', async () => {
		const onresolve = vi.fn();
		const onunresolve = vi.fn();
		const open = makeMessage({ id: 'open', thread_title: 'Open item' });
		const completed = makeMessage({ id: 'done', thread_title: 'Completed item', resolved_at: Date.now() / 1000 });
		const screen = render(ThreadTaskList, {
			props: { items: [open, completed], onopen: vi.fn(), onresolve, onunresolve }
		});

		await expect.element(screen.getByRole('heading', { name: 'Open' })).toBeInTheDocument();

		await screen.getByLabelText('Mark Open item as complete').click();
		expect(onresolve).toHaveBeenCalledWith(open);

		await screen.getByLabelText('Show closed items').click();
		await expect.element(screen.getByRole('heading', { name: 'Closed' })).toBeInTheDocument();
		await screen.getByLabelText('Mark Completed item as open').click();
		expect(onunresolve).toHaveBeenCalledWith(completed);
	});

	test('opens the underlying thread from its title', async () => {
		const onopen = vi.fn();
		const message = makeMessage({ thread_title: 'Open this task' });
		const screen = render(ThreadTaskList, {
			props: { items: [message], onopen, onresolve: vi.fn(), onunresolve: vi.fn() }
		});

		await screen.getByTitle('Open thread: Open this task').click();
		expect(onopen).toHaveBeenCalledWith(message);
	});

	test('filters work items to the selected authors', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [
					makeMessage({ id: 'alice-task', thread_title: 'Human request', user_id: 'alice', display_name: 'Alice' }),
					makeMessage({ id: 'bot-task', thread_title: 'Agent work', user_id: 'bot', username: 'sim-bot', display_name: 'Sim bot' })
				],
				selectedAuthorKeys: ['user:bot'],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		await expect.element(screen.getByText('Agent work')).toBeInTheDocument();
		expect(screen.baseElement.textContent).not.toContain('Human request');
	});

	test('supports narrowing the all-authors selection from the filter menu', async () => {
		const onauthorfilterchange = vi.fn();
		const screen = render(ThreadTaskList, {
			props: {
				items: [
					makeMessage({ id: 'alice-task', user_id: 'alice', display_name: 'Alice' }),
					makeMessage({ id: 'bot-task', user_id: 'bot', username: 'sim-bot', display_name: 'Sim bot' })
				],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn(),
				onauthorfilterchange
			}
		});

		await screen.getByText('All authors', { exact: true }).click();
		await screen.getByLabelText('Show items from Alice').click();

		expect(onauthorfilterchange).toHaveBeenCalledWith(['user:bot']);
	});

	test('dismisses the author menu on outside click and Escape', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [makeMessage()],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn(),
				onauthorfilterchange: vi.fn()
			}
		});
		const trigger = screen.getByLabelText('Filter by author: All authors');
		const menuHeading = screen.getByText('Show items from', { exact: true });

		await trigger.click();
		await expect.element(menuHeading).toBeVisible();
		await screen.getByLabelText('Sort oldest first').click();
		await expect.element(menuHeading).not.toBeVisible();

		await trigger.click();
		await expect.element(menuHeading).toBeVisible();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await expect.element(menuHeading).not.toBeVisible();
		expect(document.activeElement).toBe(trigger.element());
	});

	test('orders items by timestamp in either direction', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [
					makeMessage({ id: 'older', thread_title: 'Older item', created_at: 100 }),
					makeMessage({ id: 'newer', thread_title: 'Newer item', created_at: 200 })
				],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		let rows = screen.baseElement.querySelectorAll('.task-row');
		expect(rows[0]?.textContent).toContain('Newer item');

		await screen.getByLabelText('Sort oldest first').click();
		rows = screen.baseElement.querySelectorAll('.task-row');
		expect(rows[0]?.textContent).toContain('Older item');
	});

	test('independently hides and shows open and closed items', async () => {
		const screen = render(ThreadTaskList, {
			props: {
				items: [
					makeMessage({ id: 'open', thread_title: 'Visible open item' }),
					makeMessage({ id: 'closed', thread_title: 'Visible closed item', resolved_at: 100 })
				],
				onopen: vi.fn(),
				onresolve: vi.fn(),
				onunresolve: vi.fn()
			}
		});

		await expect.element(screen.getByText('Visible open item')).toBeInTheDocument();
		expect(screen.baseElement.textContent).not.toContain('Visible closed item');

		await screen.getByLabelText('Show closed items').click();
		await expect.element(screen.getByText('Visible closed item')).toBeInTheDocument();

		await screen.getByLabelText('Hide open items').click();
		expect(screen.baseElement.textContent).not.toContain('Visible open item');

		await screen.getByLabelText('Hide closed items').click();
		await expect.element(screen.getByText('Open and closed items are hidden.')).toBeInTheDocument();
	});
});
