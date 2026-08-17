import { render } from 'vitest-browser-svelte';
import { describe, expect, test, vi } from 'vitest';
import type { Channel } from '$lib/state/channels.svelte.js';
import ChannelHeader from './ChannelHeader.svelte';

const baseProps = {
	onopensettings: vi.fn(),
	onopenMembers: vi.fn(),
	onopensearch: vi.fn(),
	ontoggleBoard: vi.fn(),
	showBoardPanel: false,
	ontogglePins: vi.fn(),
	showPinsPanel: false,
	ontoggleSavedDrafts: vi.fn(),
	showSavedDraftsPanel: false,
	onopenSidebar: vi.fn()
};

const channel: Channel = {
	id: 'channel-1',
	name: 'general',
	description: null,
	is_private: 0,
	processing_mode: 'auto',
	board_enabled: 0,
	auto_respond_bot_id: null,
	notifications: 'all',
	created_by: 'user-1',
	created_at: Date.now() / 1000,
	has_unread: 0,
	unread_count: 0,
	last_read_message_id: null
};

describe('ChannelHeader conversation mode toggle', () => {
	test('switches a channel from timeline to task view', async () => {
		const ontoggleConversationMode = vi.fn();
		const screen = render(ChannelHeader, {
			props: { ...baseProps, channel, conversationMode: 'timeline', ontoggleConversationMode }
		});

		const toggle = screen.getByLabelText('Show task view');
		await expect.element(toggle).toBeInTheDocument();
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
		await toggle.click();
		expect(ontoggleConversationMode).toHaveBeenCalledTimes(1);
	});

	test('offers the same view toggle in DMs', async () => {
		const screen = render(ChannelHeader, {
			props: {
				...baseProps,
				channel: undefined,
				dmPartnerName: 'Sim bot',
				conversationMode: 'tasks',
				ontoggleConversationMode: vi.fn()
			}
		});

		const toggle = screen.getByLabelText('Show conversation view');
		await expect.element(toggle).toBeInTheDocument();
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
	});
});
