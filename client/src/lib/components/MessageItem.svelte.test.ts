import { render } from 'vitest-browser-svelte';
import { expect, test, vi, describe } from 'vitest';
import type { Message } from '$lib/state/messages.svelte.js';

// Mock the stores and api before importing the component
vi.mock('$lib/state/auth.svelte.js', () => ({
	auth: {
		get user() {
			return { id: 'user-1', username: 'testuser' };
		}
	}
}));

vi.mock('$lib/api.js', () => ({
	api: {
		reactions: {
			add: vi.fn(),
			remove: vi.fn()
		},
		messages: {
			get: vi.fn()
		}
	},
	API_BASE: '/api'
}));

vi.mock('$lib/state/message-actions.svelte.js', () => ({
	messageActions: {
		open: vi.fn()
	}
}));

vi.mock('$lib/state/emoji-picker.svelte.js', () => ({
	emojiPicker: {
		get quickEmojis() {
			return ['👍', '❤️', '😂'];
		}
	}
}));

import MessageItem from './MessageItem.svelte';

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: 'msg-1',
		channel_id: 'ch-1',
		user_id: 'user-1',
		content: 'Hello, world!',
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

describe('MessageItem', () => {
	test('renders message content', async () => {
		const screen = render(MessageItem, {
			props: { message: makeMessage({ content: 'Test message content' }) }
		});

		await expect
			.element(screen.getByText('Test message content'))
			.toBeInTheDocument();
	});

	test('shows optimistic delivery state on a pending message', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					id: '~pending-1',
					client_delivery_status: 'sending'
				})
			}
		});

		await expect.element(screen.getByText('Sending…')).toBeInTheDocument();
	});

	test('surfaces a failed optimistic delivery', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					id: '~pending-1',
					client_delivery_status: 'failed'
				})
			}
		});

		await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to send');
	});

	test('collapses a resolved titled root to a title-only thread row', async () => {
		const onreply = vi.fn();
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					content: 'Full root content should be hidden',
					thread_title: 'Compact resolved thread',
					resolved_at: Date.now() / 1000,
					reply_count: 2
				}),
				onreply
			}
		});

		await expect.element(screen.getByText('Compact resolved thread')).toBeInTheDocument();
		expect(screen.baseElement.querySelector('.message-content')).toBeNull();
		expect(screen.baseElement.textContent).not.toContain('Full root content should be hidden');

		await screen.getByTitle('Open resolved thread').click();
		expect(onreply).toHaveBeenCalledTimes(1);
	});

	test('keeps the root content visible until a titled thread is resolved', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					content: 'Still active',
					thread_title: 'Active title',
					resolved_at: null
				}),
				onreply: vi.fn()
			}
		});

		await expect.element(screen.getByText('Still active')).toBeInTheDocument();
		expect(screen.baseElement.querySelector('.resolved-thread-title')).toBeNull();
	});

	test('keeps resolved roots without titles expanded', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					content: 'Resolved but untitled',
					thread_title: null,
					resolved_at: Date.now() / 1000
				}),
				onreply: vi.fn()
			}
		});

		await expect.element(screen.getByText('Resolved but untitled')).toBeInTheDocument();
		expect(screen.baseElement.querySelector('.resolved-thread-title')).toBeNull();
	});

	test('copies message content from the desktop hover action', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText }
		});

		try {
			const screen = render(MessageItem, {
				props: { message: makeMessage({ content: 'Copy this message' }) }
			});

			await screen.getByText('Copy this message').hover();
			await screen.getByTitle('Copy message').click();

			expect(writeText).toHaveBeenCalledWith('Copy this message');
		} finally {
			if (clipboardDescriptor) {
				Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
			} else {
				delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
			}
		}
	});

	test('renders display name', async () => {
		const screen = render(MessageItem, {
			props: { message: makeMessage({ display_name: 'Alice Smith' }) }
		});

		await expect.element(screen.getByText('Alice Smith')).toBeInTheDocument();
	});

	test('falls back to username when no display name', async () => {
		const screen = render(MessageItem, {
			props: { message: makeMessage({ display_name: null, username: 'alice' }) }
		});

		await expect.element(screen.getByText('alice')).toBeInTheDocument();
	});

	test('shows "[deleted]" for deleted messages', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					deleted_at: Date.now() / 1000,
					content: 'This should not appear'
				})
			}
		});

		await expect.element(screen.getByText('[deleted]')).toBeInTheDocument();
	});

	test('does not render content for deleted messages', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					deleted_at: Date.now() / 1000,
					content: 'Secret content'
				})
			}
		});

		const el = screen.baseElement.querySelector('.message-content');
		expect(el).toBeNull();
	});

	test('renders system messages with italic style', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					type: 'system',
					content: 'User joined the channel'
				})
			}
		});

		await expect
			.element(screen.getByText('User joined the channel'))
			.toBeInTheDocument();
	});

	test('shows "(edited)" for edited messages', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ edited_at: Date.now() / 1000 })
			}
		});

		await expect.element(screen.getByText('(edited)')).toBeInTheDocument();
	});

	test('does not show "(edited)" for unedited messages', async () => {
		const screen = render(MessageItem, {
			props: { message: makeMessage({ edited_at: null }) }
		});

		const editedEl = screen.baseElement.ownerDocument.evaluate(
			"//*[contains(text(),'(edited)')]",
			screen.baseElement,
			null,
			XPathResult.FIRST_ORDERED_NODE_TYPE,
			null
		).singleNodeValue;
		expect(editedEl).toBeNull();
	});

	test('shows reply count when replies exist', async () => {
		const onreply = vi.fn();
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ reply_count: 5 }),
				onreply
			}
		});

		await expect.element(screen.getByText('5 replies')).toBeInTheDocument();
	});

	test('shows singular "reply" for count of 1', async () => {
		const onreply = vi.fn();
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ reply_count: 1 }),
				onreply
			}
		});

		await expect.element(screen.getByText('1 reply')).toBeInTheDocument();
	});

	test('renders grouped reactions', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					reactions: [
						{ emoji: '👍', userId: 'user-1', username: 'alice' },
						{ emoji: '👍', userId: 'user-2', username: 'bob' },
						{ emoji: '❤️', userId: 'user-1', username: 'alice' }
					]
				})
			}
		});

		// Reaction buttons use aria-label with emoji + "reaction from" + usernames
		await expect.element(screen.getByLabelText('👍 reaction from alice, bob')).toBeInTheDocument();
		await expect.element(screen.getByLabelText('❤️ reaction from alice')).toBeInTheDocument();
	});

	test('renders image attachments', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					attachments: [
						{
							id: 'att-1',
							filename: 'photo.jpg',
							contentType: 'image/jpeg',
							sizeBytes: 1024,
							url: 'https://example.com/photo.jpg'
						}
					]
				})
			}
		});

		await expect
			.element(screen.getByRole('img', { name: 'photo.jpg' }))
			.toBeInTheDocument();
	});

	test('renders file attachments with size', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					attachments: [
						{
							id: 'att-1',
							filename: 'document.pdf',
							contentType: 'application/pdf',
							sizeBytes: 2048,
							url: '/uploads/document.pdf'
						}
					]
				})
			}
		});

		await expect.element(screen.getByText('document.pdf')).toBeInTheDocument();
		await expect.element(screen.getByText('2KB')).toBeInTheDocument();
	});

	test('clicking a non-image/non-video attachment opens the FileViewer modal (desktop)', async () => {
		// Ensure desktop conditions: not standalone PWA, no mobile UA token.
		const originalMatchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false
		})) as typeof window.matchMedia;
		const originalUA = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0',
			configurable: true
		});

		try {
			const screen = render(MessageItem, {
				props: {
					message: makeMessage({
						attachments: [
							{
								id: 'att-1',
								filename: 'document.pdf',
								contentType: 'application/pdf',
								sizeBytes: 2048,
								url: '/uploads/document.pdf'
							}
						]
					})
				}
			});

			// Initially no modal.
			expect(screen.baseElement.querySelector('[data-testid="file-viewer-backdrop"]')).toBeNull();

			await screen.getByTitle('Preview document.pdf').click();

			// FileViewer modal mounts with an iframe for the PDF.
			const backdrop = screen.baseElement.querySelector('[data-testid="file-viewer-backdrop"]');
			expect(backdrop).not.toBeNull();
			const iframe = screen.baseElement.querySelector('iframe');
			expect(iframe).not.toBeNull();
		} finally {
			window.matchMedia = originalMatchMedia;
			Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
		}
	});

	test('on desktop installed PWA (display-mode: standalone), clicking a non-image attachment opens the FileViewer modal', async () => {
		const originalMatchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes('display-mode: standalone'),
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false
		})) as typeof window.matchMedia;
		const originalUA = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0',
			configurable: true
		});

		try {
			const screen = render(MessageItem, {
				props: {
					message: makeMessage({
						attachments: [
							{
								id: 'att-1',
								filename: 'notes.txt',
								contentType: 'text/plain',
								sizeBytes: 512,
								url: '/uploads/notes.txt'
							}
						]
					})
				}
			});

			expect(screen.baseElement.querySelector('a[data-testid="attachment-link"]')).toBeNull();
			await screen.getByTitle('Preview notes.txt').click();
			expect(screen.baseElement.querySelector('[data-testid="file-viewer-backdrop"]')).not.toBeNull();
		} finally {
			window.matchMedia = originalMatchMedia;
			Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
		}
	});

	test('on iPhone user agent, clicking a non-image attachment renders an anchor link', async () => {
		const originalMatchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false
		})) as typeof window.matchMedia;
		const originalUA = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
			configurable: true
		});

		try {
			const screen = render(MessageItem, {
				props: {
					message: makeMessage({
						attachments: [
							{
								id: 'att-1',
								filename: 'data.json',
								contentType: 'application/json',
								sizeBytes: 256,
								url: '/uploads/data.json'
							}
						]
					})
				}
			});

			const link = screen.baseElement.querySelector(
				'a[data-testid="attachment-link"]'
			) as HTMLAnchorElement | null;
			expect(link).not.toBeNull();
			expect(link!.getAttribute('href')).toContain('/uploads/data.json');
			expect(link!.textContent).toContain('data.json');
			expect(screen.baseElement.querySelector('button[title="Preview data.json"]')).toBeNull();
		} finally {
			window.matchMedia = originalMatchMedia;
			Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
		}
	});

	test('renders link preview', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					linkPreviews: [
						{
							url: 'https://example.com',
							urlHash: 'abc',
							title: 'Example Site',
							description: 'A description of the site',
							imageUrl: null,
							siteName: 'Example'
						}
					]
				})
			}
		});

		await expect.element(screen.getByText('Example Site')).toBeInTheDocument();
		await expect
			.element(screen.getByText('A description of the site'))
			.toBeInTheDocument();
		await expect.element(screen.getByText('Example', { exact: true })).toBeInTheDocument();
	});

	test('renders process status badges', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'processing' })
			}
		});

		await expect.element(screen.getByText('Processing')).toBeInTheDocument();
	});

	test('renders queued process status', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'queued' })
			}
		});

		await expect.element(screen.getByText('Queued')).toBeInTheDocument();
	});

	test('renders done process status', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'done' })
			}
		});

		await expect.element(screen.getByText('Done')).toBeInTheDocument();
	});

	test('renders error process status', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'error' })
			}
		});

		await expect.element(screen.getByText('Error')).toBeInTheDocument();
	});

	test('shows error details affordance when error text is available', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					process_status: 'error',
					process_error_text: 'boom'
				})
			}
		});

		const detailsChip = screen.getByLabelText('View error details');
		await expect.element(detailsChip).toBeInTheDocument();
		await expect.element(detailsChip).toHaveTextContent(/Error/);
	});

	test('renders stopped process status', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'killed' })
			}
		});

		await expect.element(screen.getByText('Stopped')).toBeInTheDocument();
	});

	test('renders restarted process status', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ process_status: 'restarted' })
			}
		});

		await expect.element(screen.getByText('Restarted')).toBeInTheDocument();
	});

	test('renders memories details when present', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					metadata: {
						memories: [
							{ label: 'User preference', content: 'Likes dark mode', relevance: '0.95' }
						]
					}
				})
			}
		});

		await expect
			.element(screen.getByText('1 memory loaded'))
			.toBeInTheDocument();
	});

	test('shows plural "memories" for multiple', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					metadata: {
						memories: [
							{ label: 'Pref 1', content: 'Content 1' },
							{ label: 'Pref 2', content: 'Content 2' }
						]
					}
				})
			}
		});

		await expect
			.element(screen.getByText('2 memories loaded'))
			.toBeInTheDocument();
	});

	test('renders memory search details when present', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({
					metadata: {
						memory_searches: [{ query: 'memory searched UI', count: 0 }]
					}
				})
			}
		});

		await expect.element(screen.getByText('1 memory search')).toBeInTheDocument();
		await expect.element(screen.getByText('memory searched UI')).toBeInTheDocument();
		await expect.element(screen.getByText('(0 results)')).toBeInTheDocument();
	});

	test('renders markdown in message content', async () => {
		const screen = render(MessageItem, {
			props: {
				message: makeMessage({ content: '**bold text**' })
			}
		});

		const bold = screen.baseElement.querySelector('strong');
		expect(bold).not.toBeNull();
		expect(bold!.textContent).toBe('bold text');
	});

	test('timestamp is clickable when ontimestampclick is provided', async () => {
		const ontimestampclick = vi.fn();
		const screen = render(MessageItem, {
			props: {
				message: makeMessage(),
				ontimestampclick
			}
		});

		// With ontimestampclick, timestamp renders as a button
		const timestampBtn = screen.getByTitle('Jump to message in channel');
		await expect.element(timestampBtn).toBeInTheDocument();
	});
});
