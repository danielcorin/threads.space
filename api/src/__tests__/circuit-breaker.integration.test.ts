import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { createTestUser, loginUser, authedFetch, execSql, querySql, BASE_URL } from './helpers.js';

/** Read circuit-breaker columns for a channel. */
async function getChannelBreakerState(channelId: string) {
  const rows = querySql(`SELECT consecutive_non_human_count, non_human_window_started_at, bot_loop_tripped_at FROM channels WHERE id = '${channelId}'`);
  return rows[0] as {
    consecutive_non_human_count: number;
    non_human_window_started_at: number | null;
    bot_loop_tripped_at: number | null;
  };
}

/** Send a message as a given user with the specified message_type. */
async function sendMsg(token: string, channelId: string, messageType: string, content?: string) {
  const res = await authedFetch(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: content ?? `msg-${Date.now()}`, message_type: messageType }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

describe('Bot loop circuit breaker', () => {
  let humanToken: string;
  let botToken: string;
  let channelId: string;

  beforeAll(async () => {
    // Create a human user and a bot user
    await createTestUser('cb_human', 'testpass123', 'CB Human');
    const humanLogin = await loginUser('cb_human');
    humanToken = humanLogin.sessionToken;

    // Create bot user (role=bot)
    await createTestUser('cb_bot', 'testpass123', 'CB Bot', 'bot');
    const botLogin = await loginUser('cb_bot');
    botToken = botLogin.sessionToken;

    // Create a channel and have both users join
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'circuit-breaker-test' }),
    });
    const chan = (await chanRes.json()) as any;
    channelId = chan.id;

    await authedFetch(botToken, `/channels/${channelId}/join`, { method: 'POST' });
  });

  it('does NOT trip after 9 non-human messages within 60s', async () => {
    // Fresh channel for this test
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-9msgs' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    for (let i = 0; i < 9; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.consecutive_non_human_count).toBe(9);
    expect(state.bot_loop_tripped_at).toBeNull();
  });

  it('trips after 10 non-human messages within 60s', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-10msgs' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.consecutive_non_human_count).toBe(10);
    expect(state.bot_loop_tripped_at).not.toBeNull();
  });

  it('does NOT trip when 10 non-human messages span >60s (window resets)', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-window-reset' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    // Send 5 messages
    for (let i = 0; i < 5; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    // Artificially backdate the window start so the next message falls outside the 60s window
    execSql(`UPDATE channels SET non_human_window_started_at = ${Date.now() - 120_000} WHERE id = '${chan.id}'`);

    // Send 5 more messages — should start a new window from count=1
    for (let i = 5; i < 10; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    // Window reset means count restarted at 1 and went up to 5
    expect(state.consecutive_non_human_count).toBe(5);
    expect(state.bot_loop_tripped_at).toBeNull();
  });

  it('does NOT trip when human message resets counter mid-stream (9 + human + 9)', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-human-reset' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    // 9 non-human
    for (let i = 0; i < 9; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-a-${i}`);
    }

    // Human message resets
    await sendMsg(humanToken, chan.id, 'human', 'human intervenes');

    // 9 more non-human
    for (let i = 0; i < 9; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-b-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.consecutive_non_human_count).toBe(9);
    expect(state.bot_loop_tripped_at).toBeNull();
  });

  it('clears tripped state when a human message arrives', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-human-clears' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    // Trip the breaker
    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const tripped = await getChannelBreakerState(chan.id);
    expect(tripped.bot_loop_tripped_at).not.toBeNull();

    // Human message clears it
    await sendMsg(humanToken, chan.id, 'human', 'human resets');

    const cleared = await getChannelBreakerState(chan.id);
    expect(cleared.bot_loop_tripped_at).toBeNull();
    expect(cleared.consecutive_non_human_count).toBe(0);
    expect(cleared.non_human_window_started_at).toBeNull();
  });

  it('streaming chatter (thinking/tool_output/progress) does not trip the breaker', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-streaming-neutral' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    const types = ['thinking', 'tool_output', 'progress'];
    for (let i = 0; i < 15; i++) {
      await sendMsg(botToken, chan.id, types[i % types.length], `stream-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.bot_loop_tripped_at).toBeNull();
    expect(state.consecutive_non_human_count).toBe(0);
  });

  it('threaded bot responses do not trip the breaker', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-thread-neutral' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    const parent = await sendMsg(humanToken, chan.id, 'human', 'thread parent');
    for (let i = 0; i < 12; i++) {
      const res = await authedFetch(botToken, `/messages/${parent.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: `threaded-${i}`, message_type: 'response' }),
      });
      expect(res.status).toBe(201);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.bot_loop_tripped_at).toBeNull();
  });

  it('auto-resets a tripped breaker after the reset window', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-auto-reset' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, chan.id, 'response', `trip-${i}`);
    }
    expect((await getChannelBreakerState(chan.id)).bot_loop_tripped_at).not.toBeNull();

    // Backdate the trip and the counting window past the reset horizon
    const past = Date.now() - 10 * 60_000;
    execSql(`UPDATE channels SET bot_loop_tripped_at = ${past}, non_human_window_started_at = ${past} WHERE id = '${chan.id}'`);

    // Next bot response starts a fresh window instead of staying gated forever
    await sendMsg(botToken, chan.id, 'response', 'post-reset');
    const state = await getChannelBreakerState(chan.id);
    expect(state.bot_loop_tripped_at).toBeNull();
    expect(state.consecutive_non_human_count).toBe(1);
  });

  it('broadcasts a bot_loop_tripped event when the breaker trips', async () => {
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-trip-event' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botToken, `/channels/${cid}/join`, { method: 'POST' });

    const wsBase = BASE_URL.replace(/^http/, 'ws');
    const humanMessages: any[] = [];
    const humanWs = new WebSocket(`${wsBase}/ws/${cid}`, {
      headers: { Cookie: `session=${humanToken}` },
    });
    humanWs.on('message', (data: WebSocket.Data) => {
      try { humanMessages.push(JSON.parse(data.toString())); } catch {}
    });
    await new Promise<void>((r) => humanWs.on('open', r));

    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, cid, 'response', `trip-${i}`);
    }
    await new Promise((r) => setTimeout(r, 500));

    const tripEvents = humanMessages.filter((m) => m.type === 'bot_loop_tripped');
    expect(tripEvents.length).toBe(1);
    expect(tripEvents[0].channelId).toBe(cid);
    expect(typeof tripEvents[0].trippedAt).toBe('number');

    humanWs.close();
  });

  it('gates bot delivery when tripped (broadcast includes botLoopTripped flag)', async () => {
    // This test verifies the server-side behavior by checking the response
    // still returns 201 (message is created), but the channel state is tripped.
    // Full WebSocket fan-out filtering is tested by the ChatRoom DO behavior —
    // here we verify the circuit breaker state is correctly set which is what
    // gates the broadcast in handleSendMessage.
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-gate-bot' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    // Trip the breaker
    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const state = await getChannelBreakerState(chan.id);
    expect(state.bot_loop_tripped_at).not.toBeNull();

    // Send one more bot message while tripped — should still succeed (201)
    // but the broadcast will have excluded bot role connections
    const res = await authedFetch(botToken, `/channels/${chan.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'msg while tripped', message_type: 'response' }),
    });
    expect(res.status).toBe(201);

    // Breaker remains tripped
    const stillTripped = await getChannelBreakerState(chan.id);
    expect(stillTripped.bot_loop_tripped_at).not.toBeNull();
  });

  it('excludes bot WS connections from fan-out when tripped', async () => {
    // Create a fresh channel
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-ws-fanout' }),
    });
    const chan = (await chanRes.json()) as any;
    const cid = chan.id;
    await authedFetch(botToken, `/channels/${cid}/join`, { method: 'POST' });

    const wsBase = BASE_URL.replace(/^http/, 'ws');

    // Open human + bot WebSocket connections
    const humanMessages: any[] = [];
    const botMessages: any[] = [];

    const humanWs = new WebSocket(`${wsBase}/ws/${cid}`, {
      headers: { Cookie: `session=${humanToken}` },
    });
    const botWs = new WebSocket(`${wsBase}/ws/${cid}`, {
      headers: { Cookie: `session=${botToken}` },
    });

    const humanOpen = new Promise<void>((r) => humanWs.on('open', r));
    const botOpen = new Promise<void>((r) => botWs.on('open', r));

    humanWs.on('message', (data: WebSocket.Data) => {
      try { humanMessages.push(JSON.parse(data.toString())); } catch {}
    });
    botWs.on('message', (data: WebSocket.Data) => {
      try { botMessages.push(JSON.parse(data.toString())); } catch {}
    });

    await Promise.all([humanOpen, botOpen]);

    // Trip the breaker: send 10 bot messages
    for (let i = 0; i < 10; i++) {
      await sendMsg(botToken, cid, 'response', `trip-msg-${i}`);
    }

    // Send one more bot message while tripped — the "gated" message
    const gatedRes = await sendMsg(botToken, cid, 'response', 'gated-msg');
    const gatedId = gatedRes.id;

    // Wait for fan-out to settle
    await new Promise((r) => setTimeout(r, 500));

    // Human WS should have received the gated message
    const humanGot = humanMessages.some(
      (m) => m.type === 'message' && m.id === gatedId,
    );
    expect(humanGot).toBe(true);

    // Bot WS should NOT have received the gated message
    const botGot = botMessages.some(
      (m) => m.type === 'message' && m.id === gatedId,
    );
    expect(botGot).toBe(false);

    humanWs.close();
    botWs.close();
  });

  it('delivers to all subscribers when not tripped', async () => {
    // Verify normal operation: messages go through, breaker stays clear
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'cb-test-normal' }),
    });
    const chan = (await chanRes.json()) as any;
    await authedFetch(botToken, `/channels/${chan.id}/join`, { method: 'POST' });

    // Send a human message
    await sendMsg(humanToken, chan.id, 'human', 'hello');

    const state = await getChannelBreakerState(chan.id);
    expect(state.bot_loop_tripped_at).toBeNull();
    expect(state.consecutive_non_human_count).toBe(0);

    // Send a few bot messages — under threshold
    for (let i = 0; i < 3; i++) {
      await sendMsg(botToken, chan.id, 'response', `bot-msg-${i}`);
    }

    const state2 = await getChannelBreakerState(chan.id);
    expect(state2.bot_loop_tripped_at).toBeNull();
    expect(state2.consecutive_non_human_count).toBe(3);
  });
});
