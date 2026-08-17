import { describe, it, expect, beforeAll } from 'vitest';
import { authedFetch, createTestUser, loginUser, makeAdmin } from './helpers.js';

async function createBot(username: string): Promise<{ id: string; token: string }> {
  const created = await createTestUser(username, 'testpass123', undefined, 'bot');
  const login = await loginUser(username);
  return { id: created.id || login.user.id, token: login.sessionToken };
}

describe('Bot DM permissions', () => {
  let humanId: string;
  let humanToken: string;
  let _allowedHumanId: string;
  let allowedHumanToken: string;
  let adminToken: string;
  let botId: string;
  let botToken: string;

  beforeAll(async () => {
    const human = await createTestUser('dmperm_human');
    humanId = human.id;
    humanToken = (await loginUser('dmperm_human')).sessionToken;

    const allowedHuman = await createTestUser('dmperm_allowed');
    _allowedHumanId = allowedHuman.id;
    allowedHumanToken = (await loginUser('dmperm_allowed')).sessionToken;

    // Admins can DM any bot regardless of the bot's capability allow-lists.
    await createTestUser('dmperm_admin');
    await makeAdmin('dmperm_admin');
    adminToken = (await loginUser('dmperm_admin')).sessionToken;

    const bot = await createBot('dmperm_bot');
    botId = bot.id;
    botToken = bot.token;

    const caps = await authedFetch(botToken, '/bots/self/capabilities', {
      method: 'POST',
      body: JSON.stringify({ dm_allowed_usernames: ['dmperm_allowed'] }),
    });
    expect(caps.status).toBe(200);
  });

  it('blocks non-allowed humans from creating a DM with a bot', async () => {
    const res = await authedFetch(humanToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: botId }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toBe('DMing this bot is not enabled for this user');
  });

  it('allows a bot to create a DM with a human and send first', async () => {
    const dmRes = await authedFetch(botToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: humanId }),
    });
    expect(dmRes.status).toBe(201);
    const dm = await dmRes.json() as any;

    const msgRes = await authedFetch(botToken, `/channels/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello from bot', message_type: 'response' }),
    });
    expect(msgRes.status).toBe(201);
  });

  it('blocks non-allowed humans from sending in an existing bot DM and annotates list responses', async () => {
    const listRes = await authedFetch(humanToken, '/dms');
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as any[];
    const dm = list.find((d) => d.partner.id === botId);
    expect(dm).toBeDefined();
    expect(dm.can_send_messages).toBe(false);
    expect(dm.disabled_reason).toBe('DMing this bot is not enabled for this user');

    const msgRes = await authedFetch(humanToken, `/channels/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'should be blocked' }),
    });
    expect(msgRes.status).toBe(403);
  });

  it('allows admins to DM any bot without an explicit allow-list entry', async () => {
    const dmRes = await authedFetch(adminToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: botId }),
    });
    expect(dmRes.status).toBe(201);
    const dm = await dmRes.json() as any;
    expect(dm.can_send_messages).toBe(true);

    const msgRes = await authedFetch(adminToken, `/channels/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'admin message to bot' }),
    });
    expect(msgRes.status).toBe(201);
  });

  it('allows users explicitly allowed by bot capabilities', async () => {
    const dmRes = await authedFetch(allowedHumanToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: botId }),
    });
    expect(dmRes.status).toBe(201);
    const dm = await dmRes.json() as any;
    expect(dm.can_send_messages).toBe(true);

    const msgRes = await authedFetch(allowedHumanToken, `/channels/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'allowed human message' }),
    });
    expect(msgRes.status).toBe(201);
  });
});
