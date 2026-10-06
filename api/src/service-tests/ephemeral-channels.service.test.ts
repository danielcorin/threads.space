import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { handleCreateEphemeralChannel } from '../routes/channels.js';
import type { Env, User } from '../types.js';

it('returns the created channel while slow bot notification continues in the background', async () => {
  const serviceEnv = env as unknown as Env;
  await serviceEnv.DB.batch([
    serviceEnv.DB.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('ephemeral-human', 'ephemeral-human', '!', 'human')"),
    serviceEnv.DB.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('ephemeral-bot', 'ephemeral-bot', '!', 'bot')"),
  ]);
  const actor = { id: 'ephemeral-human', role: 'human', ephemeral_bot_id: 'ephemeral-bot' } as User;
  let release!: () => void;
  const slowBroadcast = new Promise<void>((resolve) => { release = resolve; });
  const broadcastMessage = vi.fn(() => slowBroadcast);
  const sendToUsers = vi.fn().mockResolvedValue(undefined);
  const slowEnv = {
    ...serviceEnv,
    CHAT_ROOM: { idFromName: (name: string) => name, get: () => ({ broadcastMessage }) },
    PRESENCE_ROOM: { idFromName: (name: string) => name, get: () => ({ sendToUsers }) },
  } as unknown as Env;
  const ctx = createExecutionContext();
  try {
    const response = await handleCreateEphemeralChannel(new Request('https://test/channels/ephemeral', { method: 'POST' }), slowEnv, actor, ctx);
    expect(response.status).toBe(201);
    const channel = await response.json() as { id: string; auto_respond_bot_id: string };
    expect(channel.auto_respond_bot_id).toBe(actor.ephemeral_bot_id);
    const members = await serviceEnv.DB.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? ORDER BY user_id').bind(channel.id).all<{ user_id: string }>();
    expect(members.results.map((member) => member.user_id)).toEqual(['ephemeral-bot', 'ephemeral-human']);
    expect(broadcastMessage).toHaveBeenCalledOnce();
    expect(sendToUsers).not.toHaveBeenCalled();
  } finally {
    release();
    await waitOnExecutionContext(ctx);
  }
  expect(sendToUsers).toHaveBeenCalledOnce();
});
