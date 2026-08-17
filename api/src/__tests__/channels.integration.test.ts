import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql, makeAdmin } from './helpers.js';

describe('Channels', () => {
  let token1: string;
  let token2: string;
  let user1Id: string;

  beforeAll(async () => {
    await createTestUser('chan_user1');
    await createTestUser('chan_user2');
    const login1 = await loginUser('chan_user1');
    const login2 = await loginUser('chan_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    user1Id = login1.user.id;
  });

  describe('POST /channels', () => {
    it('creates a channel and returns 201', async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-test-general', description: 'General chat' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.name).toBe('chan-test-general');
      expect(body.description).toBe('General chat');
    });

    it('returns 409 for duplicate channel name', async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-test-general' }),
      });

      expect(res.status).toBe(409);
    });

    it('returns error for missing name', async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /channels', () => {
    it('lists channels the user is a member of', async () => {
      const res = await authedFetch(token1, '/channels');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(Array.isArray(body)).toBe(true);
      const names = body.map((c: any) => c.name);
      expect(names).toContain('chan-test-general');
    });

    it('includes has_unread field', async () => {
      const res = await authedFetch(token1, '/channels');
      const body = await res.json() as any;
      expect(body[0]).toHaveProperty('has_unread');
    });
  });

  describe('GET /channels/:id', () => {
    it('returns channel by id', async () => {
      // First get the channel id
      const listRes = await authedFetch(token1, '/channels');
      const channels = await listRes.json() as any;
      const channel = channels.find((c: any) => c.name === 'chan-test-general');

      const res = await authedFetch(token1, `/channels/${channel.id}`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.name).toBe('chan-test-general');
      expect(body.id).toBe(channel.id);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await authedFetch(token1, '/channels/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /channels/:id', () => {
    it('updates channel name and description', async () => {
      // Create a channel to update
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-to-update' }),
      });
      const { id } = await createRes.json() as any;

      const res = await authedFetch(token1, `/channels/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'chan-updated', description: 'Updated desc' }),
      });

      expect(res.status).toBe(200);

      // Verify update
      const getRes = await authedFetch(token1, `/channels/${id}`);
      const channel = await getRes.json() as any;
      expect(channel.name).toBe('chan-updated');
      expect(channel.description).toBe('Updated desc');
    });
  });

  describe('PATCH /channels/:id - auto_respond_bot_id', () => {
    let channelId: string;
    let botUserId: string;

    beforeAll(async () => {
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-auto-respond-toggle' }),
      });
      const { id } = await createRes.json() as any;
      channelId = id;

      // Create a bot and add as member
      const botBody = await createTestUser('arb_toggle_bot', 'testpass123', undefined, 'bot');
      botUserId = botBody.id;

      await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: botUserId }),
      });
    });

    it('sets auto_respond_bot_id to a valid bot member', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: botUserId }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.auto_respond_bot_id).toBe(botUserId);
    });

    it('clears auto_respond_bot_id with null', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: null }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.auto_respond_bot_id).toBeNull();
    });

    it('rejects auto_respond_bot_id for a non-bot member', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: user1Id }),
      });
      expect(res.status).toBe(400);
    });

    it('auto_respond_bot_id appears in channel list', async () => {
      await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: botUserId }),
      });

      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.name === 'chan-auto-respond-toggle');
      expect(ch).toHaveProperty('auto_respond_bot_id');
      expect(ch.auto_respond_bot_id).toBe(botUserId);
    });

    it('nulls auto_respond_bot_id when that bot is removed from channel', async () => {
      // Re-add bot (was removed in prior test runs or freshly added)
      await authedFetch(token1, `/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: botUserId }),
      });

      // Set bot as auto-responder
      await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ auto_respond_bot_id: botUserId }),
      });

      // Make user1 an admin so they can remove other members
      execSql(`UPDATE users SET is_admin = 1 WHERE id = '${user1Id}'`);

      // Remove bot from channel
      const removeRes = await authedFetch(token1, `/channels/${channelId}/members/${botUserId}`, {
        method: 'DELETE',
      });
      expect(removeRes.status).toBe(200);

      // Verify auto_respond_bot_id was nulled
      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.auto_respond_bot_id).toBeNull();

      // Restore non-admin
      execSql(`UPDATE users SET is_admin = 0 WHERE id = '${user1Id}'`);
    });
  });

  describe('PATCH /channels/:id - board_enabled', () => {
    it('toggles board_enabled on and off', async () => {
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-board-toggle' }),
      });
      const { id } = await createRes.json() as any;

      // Default should be 0
      const getRes0 = await authedFetch(token1, `/channels/${id}`);
      const channel0 = await getRes0.json() as any;
      expect(channel0.board_enabled).toBe(0);

      // Enable board
      const res = await authedFetch(token1, `/channels/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ board_enabled: 1 }),
      });
      expect(res.status).toBe(200);

      const getRes1 = await authedFetch(token1, `/channels/${id}`);
      const channel1 = await getRes1.json() as any;
      expect(channel1.board_enabled).toBe(1);

      // Disable board
      const res2 = await authedFetch(token1, `/channels/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ board_enabled: 0 }),
      });
      expect(res2.status).toBe(200);

      const getRes2 = await authedFetch(token1, `/channels/${id}`);
      const channel2 = await getRes2.json() as any;
      expect(channel2.board_enabled).toBe(0);
    });
  });

  describe('PATCH /channels/:id - processing_mode', () => {
    let channelId: string;

    beforeAll(async () => {
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-processing-mode' }),
      });
      const body = await createRes.json() as any;
      channelId = body.id;
    });

    it('updates processing_mode to serial', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ processing_mode: 'serial' }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.processing_mode).toBe('serial');
    });

    it('updates processing_mode to immediate', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ processing_mode: 'immediate' }),
      });
      expect(res.status).toBe(200);

      const getRes = await authedFetch(token1, `/channels/${channelId}`);
      const channel = await getRes.json() as any;
      expect(channel.processing_mode).toBe('immediate');
    });

    it('processing_mode appears in channel list', async () => {
      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.name === 'chan-processing-mode');
      expect(ch).toHaveProperty('processing_mode');
      expect(ch.processing_mode).toBe('immediate');
    });

    it('rejects invalid processing_mode', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}`, {
        method: 'PATCH',
        body: JSON.stringify({ processing_mode: 'invalid' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('unread_count', () => {
    let unreadChannelId: string;
    let unreadToken: string;
    let unreadToken2: string;

    beforeAll(async () => {
      await createTestUser('chan_unread1');
      await createTestUser('chan_unread2');
      const login1 = await loginUser('chan_unread1');
      const login2 = await loginUser('chan_unread2');
      unreadToken = login1.sessionToken;
      unreadToken2 = login2.sessionToken;

      const chanRes = await authedFetch(unreadToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-unread-test' }),
      });
      unreadChannelId = (await chanRes.json() as any).id;

      // user2 joins
      await authedFetch(unreadToken2, `/channels/${unreadChannelId}/join`, { method: 'POST' });
    });

    it('unread_count is a number', async () => {
      const res = await authedFetch(unreadToken, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.id === unreadChannelId);
      expect(typeof ch.unread_count).toBe('number');
    });

    it('unread_count increments correctly when messages are sent', async () => {
      // Mark read first so baseline is 0
      await authedFetch(unreadToken, `/channels/${unreadChannelId}/read`, { method: 'POST' });

      // user2 sends 3 messages
      for (let i = 0; i < 3; i++) {
        await authedFetch(unreadToken2, `/channels/${unreadChannelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: `unread msg ${i}` }),
        });
      }

      const res = await authedFetch(unreadToken, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.id === unreadChannelId);
      expect(ch.unread_count).toBe(3);
      expect(ch.has_unread).toBe(1);
    });

    it('unread_count resets to 0 after marking read', async () => {
      await authedFetch(unreadToken, `/channels/${unreadChannelId}/read`, { method: 'POST' });

      const res = await authedFetch(unreadToken, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.id === unreadChannelId);
      expect(ch.unread_count).toBe(0);
      expect(ch.has_unread).toBe(0);
    });

    it('thread replies increment unread_count and set has_unread', async () => {
      // user2 sends a parent message
      const parentRes = await authedFetch(unreadToken2, `/channels/${unreadChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'thread parent for unread test' }),
      });
      const parentMsg = await parentRes.json() as any;

      // Mark read so we have a clean baseline
      await authedFetch(unreadToken, `/channels/${unreadChannelId}/read`, { method: 'POST' });

      // Thread replies are first-class Inbox messages and contribute to unread.
      await authedFetch(unreadToken2, `/messages/${parentMsg.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'thread reply should not count' }),
      });

      const res = await authedFetch(unreadToken, '/channels');
      const channels = await res.json() as any;
      const ch = channels.find((c: any) => c.id === unreadChannelId);
      expect(ch.unread_count).toBe(1);
      expect(ch.has_unread).toBe(1);
    });

    it('agent progress, thinking, and tool output do NOT increment unread_count', async () => {
      await authedFetch(unreadToken, `/channels/${unreadChannelId}/read`, { method: 'POST' });

      for (const messageType of ['progress', 'thinking', 'tool_output']) {
        await authedFetch(unreadToken2, `/channels/${unreadChannelId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            content: `${messageType} should not count`,
            message_type: messageType,
          }),
        });
      }

      const res = await authedFetch(unreadToken, '/channels');
      const listedChannels = await res.json() as any[];
      const ch = listedChannels.find((channel: any) => channel.id === unreadChannelId);
      expect(ch.unread_count).toBe(0);
      expect(ch.has_unread).toBe(0);
    });
  });

  describe('Join / Leave / Members', () => {
    let channelId: string;

    beforeAll(async () => {
      const res = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-joinleave' }),
      });
      const body = await res.json() as any;
      channelId = body.id;
    });

    it('second user joins channel', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/join`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });

    it('lists members after join', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/members`);
      expect(res.status).toBe(200);

      const members = await res.json() as any;
      expect(Array.isArray(members)).toBe(true);
      const usernames = members.map((m: any) => m.username);
      expect(usernames).toContain('chan_user1');
      expect(usernames).toContain('chan_user2');
    });

    it('user leaves channel', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/leave`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      // Verify membership list
      const membersRes = await authedFetch(token1, `/channels/${channelId}/members`);
      const members = await membersRes.json() as any;
      const usernames = members.map((m: any) => m.username);
      expect(usernames).not.toContain('chan_user2');
    });

    it('joining twice is idempotent', async () => {
      const res = await authedFetch(token2, `/channels/${channelId}/join`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      // Join again
      const res2 = await authedFetch(token2, `/channels/${channelId}/join`, {
        method: 'POST',
      });
      expect(res2.status).toBe(200);
    });
  });

  describe('DELETE /channels/:id', () => {
    it('creator can delete their channel', async () => {
      // Create a channel to delete
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-delete-test' }),
      });
      expect(createRes.status).toBe(201);
      const { id } = await createRes.json() as any;

      // Delete it
      const deleteRes = await authedFetch(token1, `/channels/${id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(200);

      // Verify it no longer appears in GET /channels
      const listRes = await authedFetch(token1, '/channels');
      const channels = await listRes.json() as any;
      const names = channels.map((c: any) => c.name);
      expect(names).not.toContain('chan-delete-test');
    });

    it('non-creator cannot delete another user\'s channel', async () => {
      // user1 creates a channel
      const createRes = await authedFetch(token1, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'chan-delete-forbidden' }),
      });
      expect(createRes.status).toBe(201);
      const { id } = await createRes.json() as any;

      // user2 tries to delete it
      const deleteRes = await authedFetch(token2, `/channels/${id}`, {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(403);
    });

    it('returns 404 for non-existent channel', async () => {
      const deleteRes = await authedFetch(token1, '/channels/nonexistent-id-12345', {
        method: 'DELETE',
      });
      expect(deleteRes.status).toBe(404);
    });
  });
});

describe('Private Channels', () => {
  let danToken: string;
  let _danUserId: string;
  let regularToken: string;
  let regularUserId: string;
  let regular2Token: string;
  let regular2UserId: string;

  beforeAll(async () => {
    await createTestUser('dan');
    // Only admins can create private channels.
    await makeAdmin('dan');
    await createTestUser('priv_regular');
    await createTestUser('priv_regular2');
    const danLogin = await loginUser('dan');
    const regularLogin = await loginUser('priv_regular');
    const regular2Login = await loginUser('priv_regular2');
    danToken = danLogin.sessionToken;
    _danUserId = danLogin.user.id;
    regularToken = regularLogin.sessionToken;
    regularUserId = regularLogin.user.id;
    regular2Token = regular2Login.sessionToken;
    regular2UserId = regular2Login.user.id;
  });

  describe('Private channel creation', () => {
    it('dan can create a private channel', async () => {
      const res = await authedFetch(danToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'priv-secret-room', description: 'Secret', isPrivate: true }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.isPrivate).toBe(true);
    });

    it('regular user cannot create a private channel', async () => {
      const res = await authedFetch(regularToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'priv-attempt', isPrivate: true }),
      });
      expect(res.status).toBe(403);
    });

    it('regular user can still create a public channel', async () => {
      const res = await authedFetch(regularToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'priv-public-ok' }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe('Private channels hidden from non-members', () => {
    it('private channel does not appear in non-member channel list', async () => {
      const res = await authedFetch(regularToken, '/channels');
      const channels = await res.json() as any;
      const names = channels.map((c: any) => c.name);
      expect(names).not.toContain('priv-secret-room');
    });

    it('private channel appears in member channel list', async () => {
      const res = await authedFetch(danToken, '/channels');
      const channels = await res.json() as any;
      const names = channels.map((c: any) => c.name);
      expect(names).toContain('priv-secret-room');
    });

    it('non-member cannot fetch private channel by ID', async () => {
      // Get the private channel ID from dan's channel list
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      const privateChannel = channels.find((c: any) => c.name === 'priv-secret-room');

      // Non-member gets 404 (not 403, to avoid revealing existence)
      const res = await authedFetch(regularToken, `/channels/${privateChannel.id}`);
      expect(res.status).toBe(404);
    });

    it('member can fetch private channel by ID', async () => {
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      const privateChannel = channels.find((c: any) => c.name === 'priv-secret-room');

      const res = await authedFetch(danToken, `/channels/${privateChannel.id}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe('priv-secret-room');
    });
  });

  describe('Cannot self-join private channels', () => {
    let privateChannelId: string;

    beforeAll(async () => {
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      privateChannelId = channels.find((c: any) => c.name === 'priv-secret-room').id;
    });

    it('regular user cannot join a private channel', async () => {
      const res = await authedFetch(regularToken, `/channels/${privateChannelId}/join`, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Member management for private channels', () => {
    let privateChannelId: string;

    beforeAll(async () => {
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      privateChannelId = channels.find((c: any) => c.name === 'priv-secret-room').id;
    });

    it('member can add another user to the private channel', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: regularUserId }),
      });
      expect(res.status).toBe(201);

      // Verify they're now a member
      const membersRes = await authedFetch(danToken, `/channels/${privateChannelId}/members`);
      const members = await membersRes.json() as any;
      const usernames = members.map((m: any) => m.username);
      expect(usernames).toContain('priv_regular');
    });

    it('non-member cannot add members', async () => {
      const res = await authedFetch(regular2Token, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: regular2UserId }),
      });
      expect(res.status).toBe(403);
    });

    it('non-admin member can only remove themselves', async () => {
      // First add regular2 so we can test removal
      await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: regular2UserId }),
      });

      // A non-admin member (priv_regular) cannot remove another member (not self)
      const forbiddenRes = await authedFetch(regularToken, `/channels/${privateChannelId}/members/${regular2UserId}`, {
        method: 'DELETE',
      });
      expect(forbiddenRes.status).toBe(403);

      // Regular2 can remove themselves
      const res = await authedFetch(regular2Token, `/channels/${privateChannelId}/members/${regular2UserId}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify removal
      const membersRes = await authedFetch(danToken, `/channels/${privateChannelId}/members`);
      const members = await membersRes.json() as any;
      const usernames = members.map((m: any) => m.username);
      expect(usernames).not.toContain('priv_regular2');
    });

    it('non-member cannot see private channel members', async () => {
      const res = await authedFetch(regular2Token, `/channels/${privateChannelId}/members`);
      expect(res.status).toBe(403);
    });
  });

  describe('Left member cannot rejoin private channel', () => {
    let privateChannelId: string;

    beforeAll(async () => {
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      privateChannelId = channels.find((c: any) => c.name === 'priv-secret-room').id;
    });

    it('member leaves private channel and cannot rejoin via /join', async () => {
      // regular user is a member (added in previous test), leave
      const leaveRes = await authedFetch(regularToken, `/channels/${privateChannelId}/leave`, {
        method: 'POST',
      });
      expect(leaveRes.status).toBe(200);

      // Try to rejoin
      const joinRes = await authedFetch(regularToken, `/channels/${privateChannelId}/join`, {
        method: 'POST',
      });
      expect(joinRes.status).toBe(403);
    });
  });

  describe('GET /channels/browse', () => {
    it('returns public channels with is_member flag', async () => {
      const res = await authedFetch(danToken, '/channels/browse');
      expect(res.status).toBe(200);
      const channels = await res.json() as any;
      expect(Array.isArray(channels)).toBe(true);

      // Should include public channels
      const publicChannel = channels.find((c: any) => c.name === 'priv-public-ok');
      expect(publicChannel).toBeDefined();
      expect(publicChannel).toHaveProperty('is_member');
      expect(publicChannel).toHaveProperty('member_count');
    });

    it('does not include private channels', async () => {
      const res = await authedFetch(regularToken, '/channels/browse');
      const channels = await res.json() as any;
      const names = channels.map((c: any) => c.name);
      expect(names).not.toContain('priv-secret-room');
    });

    it('shows is_member=1 for channels user belongs to', async () => {
      const res = await authedFetch(regularToken, '/channels/browse');
      const channels = await res.json() as any;
      const publicChannel = channels.find((c: any) => c.name === 'priv-public-ok');
      expect(publicChannel.is_member).toBe(1);
    });

    it('shows is_member=0 for channels user does not belong to', async () => {
      const res = await authedFetch(danToken, '/channels/browse');
      const channels = await res.json() as any;
      const publicChannel = channels.find((c: any) => c.name === 'priv-public-ok');
      // dan did not create or join priv-public-ok
      expect(publicChannel.is_member).toBe(0);
    });
  });

  describe('Add member by username', () => {
    let privateChannelId: string;

    beforeAll(async () => {
      // Create a fresh private channel for username tests
      const createRes = await authedFetch(danToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'priv-username-test', isPrivate: true }),
      });
      const body = await createRes.json() as any;
      privateChannelId = body.id;
    });

    it('adds a member by username instead of userId', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username: 'priv_regular' }),
      });
      expect(res.status).toBe(201);

      // Verify they're a member
      const membersRes = await authedFetch(danToken, `/channels/${privateChannelId}/members`);
      const members = await membersRes.json() as any;
      const usernames = members.map((m: any) => m.username);
      expect(usernames).toContain('priv_regular');
    });

    it('adding by username is idempotent for existing member', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username: 'priv_regular' }),
      });
      // Already a member, should not error
      expect(res.status).toBe(200);
    });

    it('can add a second member by username', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username: 'priv_regular2' }),
      });
      expect(res.status).toBe(201);

      const membersRes = await authedFetch(danToken, `/channels/${privateChannelId}/members`);
      const members = await membersRes.json() as any;
      const usernames = members.map((m: any) => m.username);
      expect(usernames).toContain('priv_regular2');
    });
  });

  describe('Add/remove member with non-existent user', () => {
    let privateChannelId: string;

    beforeAll(async () => {
      const listRes = await authedFetch(danToken, '/channels');
      const channels = await listRes.json() as any;
      privateChannelId = channels.find((c: any) => c.name === 'priv-username-test').id;
    });

    it('returns 404 when adding a non-existent userId', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: 'nonexistent-user-id-12345' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toContain('User not found');
    });

    it('returns 404 when adding a non-existent username', async () => {
      const res = await authedFetch(danToken, `/channels/${privateChannelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username: 'absolutely_no_such_user' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toContain('User not found');
    });
  });
});

describe('Channel Deletion', () => {
  let creatorToken: string;
  let nonCreatorToken: string;
  let adminToken: string;

  beforeAll(async () => {
    await createTestUser('del_creator');
    await createTestUser('del_regular');
    const adminUser = await createTestUser('del_admin');
    const creatorLogin = await loginUser('del_creator');
    const regularLogin = await loginUser('del_regular');
    const adminLogin = await loginUser('del_admin');
    creatorToken = creatorLogin.sessionToken;
    nonCreatorToken = regularLogin.sessionToken;
    adminToken = adminLogin.sessionToken;

    // Make del_admin an admin via direct DB access
    execSql(`UPDATE users SET is_admin = 1 WHERE id = '${adminUser.id}'`);
  });

  it('creator can delete their own channel', async () => {
    const createRes = await authedFetch(creatorToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'del-test-creator' }),
    });
    expect(createRes.status).toBe(201);
    const body = await createRes.json() as any;

    const deleteRes = await authedFetch(creatorToken, `/channels/${body.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
  });

  it('non-creator non-admin cannot delete a channel', async () => {
    const createRes = await authedFetch(creatorToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'del-test-forbidden' }),
    });
    const body = await createRes.json() as any;

    const deleteRes = await authedFetch(nonCreatorToken, `/channels/${body.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(403);
  });

  it('admin can delete any channel', async () => {
    const createRes = await authedFetch(creatorToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'del-test-admin' }),
    });
    const body = await createRes.json() as any;

    const deleteRes = await authedFetch(adminToken, `/channels/${body.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
  });

  it('returns 404 for nonexistent channel', async () => {
    const deleteRes = await authedFetch(creatorToken, '/channels/nonexistent-id', {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(404);
  });
});

describe('PATCH /channels/:id - auto_respond_bot_id', () => {
  let ownerToken: string;
  let botUserId: string;
  let humanUserId: string;
  let channelId: string;

  beforeAll(async () => {
    // Create owner
    await createTestUser('arb_owner');
    const ownerLogin = await loginUser('arb_owner');
    ownerToken = ownerLogin.sessionToken;

    // Create a bot user
    const botBody = await createTestUser('arb_testbot', 'testpass123', undefined, 'bot');
    botUserId = botBody.id;

    // Create a human user and get their ID
    await createTestUser('arb_human');
    const humanLogin = await loginUser('arb_human');
    humanUserId = humanLogin.user.id;

    // Create channel
    const chanRes = await authedFetch(ownerToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'chan-arb-test' }),
    });
    const chanBody = await chanRes.json() as any;
    channelId = chanBody.id;

    // Add bot and human as members
    await authedFetch(ownerToken, `/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: botUserId }),
    });
    await authedFetch(ownerToken, `/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: humanUserId }),
    });
  });

  it('sets auto_respond_bot_id to a valid bot member', async () => {
    const res = await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: botUserId }),
    });
    expect(res.status).toBe(200);

    const getRes = await authedFetch(ownerToken, `/channels/${channelId}`);
    const channel = await getRes.json() as any;
    expect(channel.auto_respond_bot_id).toBe(botUserId);
  });

  it('rejects auto_respond_bot_id for a non-member', async () => {
    // Create a bot that is NOT a member of the channel
    const outsideBot = await createTestUser('arb_outsidebot', 'testpass123', undefined, 'bot');

    const res = await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: outsideBot.id }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects auto_respond_bot_id for a non-bot member', async () => {
    const res = await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: humanUserId }),
    });
    expect(res.status).toBe(400);
  });

  it('clears auto_respond_bot_id with null', async () => {
    // Set it first
    await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: botUserId }),
    });

    // Clear it
    const res = await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: null }),
    });
    expect(res.status).toBe(200);

    const getRes = await authedFetch(ownerToken, `/channels/${channelId}`);
    const channel = await getRes.json() as any;
    expect(channel.auto_respond_bot_id).toBeNull();
  });

  it('auto_respond_bot_id appears in channel list', async () => {
    // Set it
    await authedFetch(ownerToken, `/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ auto_respond_bot_id: botUserId }),
    });

    const res = await authedFetch(ownerToken, '/channels');
    const channels = await res.json() as any;
    const ch = channels.find((c: any) => c.name === 'chan-arb-test');
    expect(ch).toHaveProperty('auto_respond_bot_id');
    expect(ch.auto_respond_bot_id).toBe(botUserId);
  });
});
