import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$lib/state/auth.svelte.js', () => ({ auth: { user: { id: 'me' } } }));
vi.mock('$lib/state/channels.svelte.js', () => ({ channels: { ensureLoaded: vi.fn().mockResolvedValue(undefined) } }));
import { channels } from './channels.svelte.js';
import { presence } from './presence.svelte.js';

class FakeWebSocket {
	static instance: FakeWebSocket;
	onmessage: ((event: { data: string }) => void) | null = null;
	constructor() { FakeWebSocket.instance = this; }
	close() {}
	emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

afterEach(() => {
	presence.disconnect();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

test('discovers memberships created on another device through the always-connected presence socket', () => {
	vi.stubGlobal('WebSocket', FakeWebSocket);
	presence.connect();
	FakeWebSocket.instance.emit({ type: 'member_added', targetUserId: 'me', channelId: 'new-channel' });
	expect(channels.ensureLoaded).toHaveBeenCalledWith('new-channel');
});

test('ignores notifications for other users and preserves normal presence updates', () => {
	vi.stubGlobal('WebSocket', FakeWebSocket);
	presence.connect();
	FakeWebSocket.instance.emit({ type: 'member_added', targetUserId: 'other-user', channelId: 'private-channel' });
	FakeWebSocket.instance.emit({ type: 'presence_snapshot', users: { friend: true } });
	expect(channels.ensureLoaded).not.toHaveBeenCalled();
	expect(presence.isOnline('friend')).toBe(true);
});
