import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch, BASE_URL } from './helpers.js';

/** Send a message as a given user. */
async function sendMsg(token: string, channelId: string, content: string, messageType = 'response') {
  const res = await authedFetch(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, message_type: messageType }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

/** Add a reaction to a message. */
async function addReaction(token: string, messageId: string, emoji: string) {
  const res = await authedFetch(token, `/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

/** Open a WS connection, collect messages into an array, and return both. */
function connectWs(channelId: string, sessionToken: string): {
  ws: WebSocket;
  messages: any[];
  open: Promise<void>;
} {
  const wsBase = BASE_URL.replace(/^http/, 'ws');
  const messages: any[] = [];
  const ws = new WebSocket(`${wsBase}/ws/${channelId}`, {
    headers: { Cookie: `session=${sessionToken}` },
  });
  const open = new Promise<void>((r) => ws.on('open', r));
  ws.on('message', (data: WebSocket.Data) => {
    try { messages.push(JSON.parse(data.toString())); } catch {}
  });
  return { ws, messages, open };
}

describe('Bot-to-bot broadcast filter', () => {
  let humanToken: string;
  let botAToken: string;
  let botBToken: string;
  let botCToken: string;
  let _humanUserId: string;
  let _botAUserId: string;
  let _botBUserId: string;
  let _botCUserId: string;

  beforeAll(async () => {
    // Human user
    await createTestUser('b2b_human', 'testpass123', 'B2B Human');
    const humanLogin = await loginUser('b2b_human');
    humanToken = humanLogin.sessionToken;
    _humanUserId = humanLogin.user.id;

    // Bot users
    await createTestUser('b2b_botA', 'testpass123', 'Bot A', 'bot');
    const botALogin = await loginUser('b2b_botA');
    botAToken = botALogin.sessionToken;
    _botAUserId = botALogin.user.id;

    await createTestUser('b2b_botB', 'testpass123', 'Bot B', 'bot');
    const botBLogin = await loginUser('b2b_botB');
    botBToken = botBLogin.sessionToken;
    _botBUserId = botBLogin.user.id;

    await createTestUser('b2b_botC', 'testpass123', 'Bot C', 'bot');
    const botCLogin = await loginUser('b2b_botC');
    botCToken = botCLogin.sessionToken;
    _botCUserId = botCLogin.user.id;
  });

  it('bot message: other bots do NOT receive, human and sender do', async () => {
    // Create channel with all users
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-msg-filter' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botCToken, `/channels/${cid}/join`, { method: 'POST' });

    // Connect WebSockets
    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    const botC = connectWs(cid, botCToken);
    await Promise.all([human.open, botA.open, botB.open, botC.open]);

    // Bot A sends a message (no mentions)
    const msg = await sendMsg(botAToken, cid, 'hello from bot A');
    await new Promise((r) => setTimeout(r, 500));

    // Human should receive
    expect(human.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    // Bot A (sender) should receive
    expect(botA.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    // Bot B and C should NOT receive
    expect(botB.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(false);
    expect(botC.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(false);

    human.ws.close(); botA.ws.close(); botB.ws.close(); botC.ws.close();
  });

  it('bot message mentioning another bot: mentioned bot receives, others do not', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-mention-filter' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botCToken, `/channels/${cid}/join`, { method: 'POST' });

    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    const botC = connectWs(cid, botCToken);
    await Promise.all([human.open, botA.open, botB.open, botC.open]);

    // Bot A mentions Bot B
    const msg = await sendMsg(botAToken, cid, '@b2b_botB help me');
    await new Promise((r) => setTimeout(r, 500));

    // Human receives
    expect(human.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    // Bot A (sender) receives
    expect(botA.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    // Bot B (mentioned) receives
    expect(botB.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    // Bot C (not mentioned) does NOT receive
    expect(botC.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(false);

    human.ws.close(); botA.ws.close(); botB.ws.close(); botC.ws.close();
  });

  it('human message: all bots receive (existing behavior unchanged)', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-human-msg' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });

    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    await Promise.all([human.open, botA.open, botB.open]);

    const msg = await sendMsg(humanToken, cid, 'hello from human', 'human');
    await new Promise((r) => setTimeout(r, 500));

    expect(human.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    expect(botA.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);
    expect(botB.messages.some((m) => m.type === 'message' && m.id === msg.id)).toBe(true);

    human.ws.close(); botA.ws.close(); botB.ws.close();
  });

  it('bot reacts to bot-authored message: no bots receive reaction_added', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-reaction-bot-bot' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });

    // Bot B posts a message (so it's bot-authored)
    const botMsg = await sendMsg(botBToken, cid, 'bot B says hi');

    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    await Promise.all([human.open, botA.open, botB.open]);

    // Bot A reacts to bot B's message
    await addReaction(botAToken, botMsg.id, '👍');
    await new Promise((r) => setTimeout(r, 500));

    // Human should receive reaction_added
    expect(human.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(true);
    // Bot A (reactor) should NOT receive (filtered as bot on bot-authored msg)
    // Note: Bot A's own connection is still a bot connection — the filter applies uniformly.
    // The sender exclusion (`exclude` param) is about the WS that sent via WS, not REST.
    // Since we used REST to add the reaction, no WS is excluded by the `exclude` param.
    expect(botA.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(false);
    // Bot B should NOT receive
    expect(botB.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(false);

    human.ws.close(); botA.ws.close(); botB.ws.close();
  });

  it('bot reacts to human-authored message: all bots receive normally', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-reaction-bot-human' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });

    // Human posts a message
    const humanMsg = await sendMsg(humanToken, cid, 'human says hi', 'human');

    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    await Promise.all([human.open, botA.open, botB.open]);

    // Bot A reacts to human's message
    await addReaction(botAToken, humanMsg.id, '👍');
    await new Promise((r) => setTimeout(r, 500));

    // All should receive
    expect(human.messages.some((m) => m.type === 'reaction_added' && m.messageId === humanMsg.id)).toBe(true);
    expect(botA.messages.some((m) => m.type === 'reaction_added' && m.messageId === humanMsg.id)).toBe(true);
    expect(botB.messages.some((m) => m.type === 'reaction_added' && m.messageId === humanMsg.id)).toBe(true);

    human.ws.close(); botA.ws.close(); botB.ws.close();
  });

  it('human reacts to bot-authored message: all bots receive normally', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'b2b-reaction-human-bot' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botAToken, `/channels/${cid}/join`, { method: 'POST' });
    await authedFetch(botBToken, `/channels/${cid}/join`, { method: 'POST' });

    // Bot A posts a message
    const botMsg = await sendMsg(botAToken, cid, 'bot A says hi');

    const human = connectWs(cid, humanToken);
    const botA = connectWs(cid, botAToken);
    const botB = connectWs(cid, botBToken);
    await Promise.all([human.open, botA.open, botB.open]);

    // Human reacts to bot A's message
    await addReaction(humanToken, botMsg.id, '❤️');
    await new Promise((r) => setTimeout(r, 500));

    // All should receive
    expect(human.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(true);
    expect(botA.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(true);
    expect(botB.messages.some((m) => m.type === 'reaction_added' && m.messageId === botMsg.id)).toBe(true);

    human.ws.close(); botA.ws.close(); botB.ws.close();
  });
});
