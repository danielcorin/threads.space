import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { handleCreateChannel, handleCreateEphemeralChannel, handleJoinChannel } from '../routes/channels.js';
import type { Env, User } from '../types.js';

const serviceEnv = env as unknown as Env;
const actor = { id: 'channel-sync-user', username: 'channel-sync-user', display_name: 'Channel Sync', role: 'human', is_admin: 1, ephemeral_bot_id: null } as User;

beforeAll(async () => {
  await serviceEnv.DB.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, ?, '!')").bind(actor.id, actor.username).run();
});

function notificationEnv() {
  const sendToUsers = vi.fn().mockResolvedValue(undefined);
  return {
    sendToUsers,
    env: { ...serviceEnv, PRESENCE_ROOM: { idFromName: (name: string) => name, get: () => ({ sendToUsers }) } } as unknown as Env,
  };
}

it('notifies only the creator after public and private channel memberships are persisted', async () => {
  for (const isPrivate of [false, true]) {
    const { env, sendToUsers } = notificationEnv();
    const ctx = createExecutionContext();
    const response = await handleCreateChannel(new Request('https://test/channels', { method: 'POST', body: JSON.stringify({ name: `sync-${isPrivate}`, isPrivate }) }), env, actor, ctx);
    expect(response.status).toBe(201);
    const channel = await response.json() as { id: string };
    await waitOnExecutionContext(ctx);
    expect(await serviceEnv.DB.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').bind(channel.id).first()).toEqual({ user_id: actor.id });
    expect(sendToUsers).toHaveBeenCalledWith([actor.id], expect.objectContaining({ type: 'member_added', targetUserId: actor.id, channelId: channel.id }));
  }
});

it('notifies the human creator of an ephemeral channel even without a default bot', async () => {
  const { env, sendToUsers } = notificationEnv();
  const ctx = createExecutionContext();
  const response = await handleCreateEphemeralChannel(new Request('https://test/channels/ephemeral', { method: 'POST' }), env, actor, ctx);
  const channel = await response.json() as { id: string };
  expect(response.status).toBe(201);
  await waitOnExecutionContext(ctx);
  expect(sendToUsers).toHaveBeenCalledWith([actor.id], expect.objectContaining({ type: 'member_added', channelId: channel.id }));
});

it('notifies on joining and rejoining, but not on an unchanged existing membership', async () => {
  const channelId = 'join-sync-channel';
  await serviceEnv.DB.prepare('INSERT INTO channels (id, name, created_by) VALUES (?, ?, ?)').bind(channelId, channelId, actor.id).run();
  const { env, sendToUsers } = notificationEnv();
  for (const rejoin of [false, true]) {
    if (rejoin) await serviceEnv.DB.prepare("UPDATE channel_members SET left_at = '2026-10-01' WHERE channel_id = ? AND user_id = ?").bind(channelId, actor.id).run();
    const ctx = createExecutionContext();
    expect((await handleJoinChannel(env, actor, channelId, ctx)).status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(sendToUsers).toHaveBeenLastCalledWith([actor.id], expect.objectContaining({ type: 'member_added', channelId }));
  }
  expect(sendToUsers).toHaveBeenCalledTimes(2);
  const ctx = createExecutionContext();
  await handleJoinChannel(env, actor, channelId, ctx);
  await waitOnExecutionContext(ctx);
  expect(sendToUsers).toHaveBeenCalledTimes(2);
});
