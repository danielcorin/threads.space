import { render } from 'vitest-browser-svelte';
import { expect, test, vi, describe } from 'vitest';
import { userEvent } from 'vitest/browser';
import MessageComposer from './MessageComposer.svelte';

describe('MessageComposer', () => {
	test('renders textarea with default placeholder', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		await expect
			.element(screen.getByPlaceholder('Type a message...'))
			.toBeInTheDocument();
	});

	test('renders textarea with custom placeholder', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, {
			props: { onsend, placeholder: 'Say something...' }
		});

		await expect
			.element(screen.getByPlaceholder('Say something...'))
			.toBeInTheDocument();
	});

	test('send button is disabled when textarea is empty', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		const sendButton = screen.getByTitle('Send message');
		await expect.element(sendButton).toBeDisabled();
	});

	test('send button enables when text is entered', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Hello');

		const sendButton = screen.getByTitle('Send message');
		await expect.element(sendButton).not.toBeDisabled();
	});

	test('clicking send button calls onsend with content', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Hello world');

		const sendButton = screen.getByTitle('Send message');
		await sendButton.click();

		expect(onsend).toHaveBeenCalledWith('Hello world', undefined, undefined, expect.any(String));
	});

	test('textarea clears after sending', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Hello');

		const sendButton = screen.getByTitle('Send message');
		await sendButton.click();

		await expect.element(textarea).toHaveValue('');
	});

	test('textarea clears while the send request is still pending', async () => {
		let resolveSend!: () => void;
		const pendingSend = new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		const onsend = vi.fn(() => pendingSend);
		const saveDraft = vi.fn();
		const screen = render(MessageComposer, {
			props: { onsend, channelId: 'ch-1', saveDraft }
		});

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Clear immediately');
		saveDraft.mockClear();
		await screen.getByTitle('Send message').click();

		await expect.element(textarea).toHaveValue('');
		await expect.element(textarea).not.toBeDisabled();
		expect(saveDraft).toHaveBeenCalledWith('ch-1', '', []);

		resolveSend();
		await expect.element(textarea).not.toBeDisabled();
	});

	test('a later send failure does not repopulate or lock the composer', async () => {
		let rejectSend!: (error: Error) => void;
		const pendingSend = new Promise<void>((_resolve, reject) => {
			rejectSend = reject;
		});
		const onsend = vi.fn(() => pendingSend);
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Restore on failure');
		await screen.getByTitle('Send message').click();
		await expect.element(textarea).toHaveValue('');

		rejectSend(new Error('network down'));

		await expect.element(textarea).toHaveValue('');
		await expect.element(textarea).not.toBeDisabled();
		expect(screen.baseElement.querySelector('[role="alert"]')).toBeNull();
	});

	test('an immediately rejected send remains optimistically cleared', async () => {
		const onsend = vi.fn().mockRejectedValue(new Error('network down'));
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Do not lose me');

		const sendButton = screen.getByTitle('Send message');
		await sendButton.click();

		await expect.element(textarea).toHaveValue('');
		await expect.element(textarea).not.toBeDisabled();
		expect(screen.baseElement.querySelector('[role="alert"]')).toBeNull();
	});

	test('allows another send while the previous request is pending', async () => {
		let resolveFirst!: () => void;
		const firstSend = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const onsend = vi.fn().mockReturnValueOnce(firstSend).mockResolvedValueOnce(undefined);
		const screen = render(MessageComposer, { props: { onsend } });

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'First');
		await screen.getByTitle('Send message').click();
		await userEvent.type(textarea, 'Second');
		await screen.getByTitle('Send message').click();

		expect(onsend).toHaveBeenNthCalledWith(1, 'First', undefined, undefined, expect.any(String));
		expect(onsend).toHaveBeenNthCalledWith(2, 'Second', undefined, undefined, expect.any(String));
		expect(onsend.mock.calls[1][3]).not.toBe(onsend.mock.calls[0][3]);
		await expect.element(textarea).toHaveValue('');
		resolveFirst();
	});

	test('does not call onsend when textarea is empty', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		// Verify the send button is disabled — no click attempt since
		// Playwright will wait for it to become enabled and time out.
		const sendButton = screen.getByTitle('Send message');
		await expect.element(sendButton).toBeDisabled();
		expect(onsend).not.toHaveBeenCalled();
	});

	test('shows edit mode UI when editingMessage is provided', async () => {
		const onsend = vi.fn();
		const oneditsubmit = vi.fn();
		const oneditcancel = vi.fn();
		const screen = render(MessageComposer, {
			props: {
				onsend,
				editingMessage: { id: 'msg-1', content: 'Original text' },
				oneditsubmit,
				oneditcancel
			}
		});

		await expect.element(screen.getByText('Editing message')).toBeInTheDocument();
		await expect.element(screen.getByText('Cancel')).toBeInTheDocument();
		await expect
			.element(screen.getByPlaceholder('Editing message... (Escape to cancel)'))
			.toBeInTheDocument();
	});

	test('edit mode populates textarea with existing content', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, {
			props: {
				onsend,
				editingMessage: { id: 'msg-1', content: 'Original text' },
				oneditsubmit: vi.fn(),
				oneditcancel: vi.fn()
			}
		});

		const textarea = screen.getByPlaceholder('Editing message... (Escape to cancel)');
		await expect.element(textarea).toHaveValue('Original text');
	});

	test('save edit button has correct title in edit mode', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, {
			props: {
				onsend,
				editingMessage: { id: 'msg-1', content: 'Original text' },
				oneditsubmit: vi.fn(),
				oneditcancel: vi.fn()
			}
		});

		await expect.element(screen.getByTitle('Save edit')).toBeInTheDocument();
	});

	test('cancel button in edit mode calls oneditcancel', async () => {
		const onsend = vi.fn();
		const oneditcancel = vi.fn();
		const screen = render(MessageComposer, {
			props: {
				onsend,
				editingMessage: { id: 'msg-1', content: 'Original text' },
				oneditsubmit: vi.fn(),
				oneditcancel
			}
		});

		await screen.getByText('Cancel').click();
		expect(oneditcancel).toHaveBeenCalled();
	});

	test('attach file button is present', async () => {
		const onsend = vi.fn();
		const screen = render(MessageComposer, { props: { onsend } });

		await expect.element(screen.getByTitle('Attach file')).toBeInTheDocument();
	});

	test('typing calls ontypingstart', async () => {
		const onsend = vi.fn();
		const ontypingstart = vi.fn();
		const screen = render(MessageComposer, {
			props: { onsend, ontypingstart }
		});

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Hi');

		expect(ontypingstart).toHaveBeenCalled();
	});

	test('saves draft to empty on send', async () => {
		const onsend = vi.fn();
		const saveDraft = vi.fn();
		const screen = render(MessageComposer, {
			props: { onsend, channelId: 'ch-1', saveDraft }
		});

		const textarea = screen.getByPlaceholder('Type a message...');
		await userEvent.type(textarea, 'Hello');

		const sendButton = screen.getByTitle('Send message');
		await sendButton.click();

		// saveDraft should be called with empty content on send
		expect(saveDraft).toHaveBeenCalledWith('ch-1', '', []);
	});
});
