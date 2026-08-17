#!/usr/bin/env node
// Simulate an agent against a deployed Threads instance so you can exercise the
// agent-steps tool-call UI WITHOUT the real Go bridge or a live agent. It posts
// the exact data the bridge does — a process, a `processing` mark, a stream of
// `progress` / `tool_output` / `thinking` step messages (each with
// metadata.trigger_id), per-tool process activity, then a `response` and a
// `done` mark — so groupSteps.ts collapses the rows into one AgentSteps block.
//
// Two modes:
//
//   one-shot (default): creates a channel, posts a canned trigger, runs once.
//     SIM_BASE_URL=https://threads.example.com node examples/sim-agent/sim-agent-run.mjs --delay 1500
//
//   listen (--listen): stays alive, connects to the /events WebSocket as the
//     bot, and runs a simulated turn in response to every human message you post
//     in any channel the bot is a member of (add it to a channel, or use the
//     sandbox channel it prints on startup). While listening it also holds a
//     /ws/presence socket so the bot shows as available (green dot) in the UI.
//     SIM_BASE_URL=https://threads.example.com node examples/sim-agent/sim-agent-run.mjs --listen
//     ./examples/sim-agent/run.sh          # shorthand for the listen command above
//     Post a message containing the keyword "error" to simulate a failed run
//     with process_error_text on the triggering message.
//
//     Threads: a human message posted inside a thread is answered in that same
//     thread (the step stream lands in the thread pane's AgentSteps block). Pass
//     --thread to also root a thread at top-level triggers, so every reply is
//     threaded — the quickest way to exercise the thread tool-call UI.
//     ./examples/sim-agent/run.sh --thread
//
// Auth comes from SMOKE_USERNAME / SMOKE_PASSWORD. Refuses to run against
// environment=production.

import simulation from './simulation.json' with { type: 'json' };

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const BOT_USERNAME = flag('bot', 'sim-bot');
const DELAY_MS = Number(flag('delay', '1100'));
const LISTEN = has('listen');
const CHANNEL = flag('channel', null); // listen mode: existing channel id to join
const THREAD = has('thread'); // listen mode: also root a thread at top-level triggers so the reply stream lands in the thread pane

const ERROR_KEYWORD = /\berror\b/i;

const BASE = (process.env.SIM_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const API = (process.env.SIM_API_BASE_URL ?? `${BASE}/api`).replace(/\/$/, '');
const ADMIN_USER = process.env.SMOKE_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SMOKE_PASSWORD ?? process.env.INSTANCE_SECRET;
if (!ADMIN_PASS) {
  console.error('No admin password. Set SMOKE_PASSWORD (or INSTANCE_SECRET for a fresh instance).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// auth = { cookie } (session) or { bearer } (api token)
async function call(method, url, { auth = {}, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.cookie) headers.Cookie = `session=${auth.cookie}`;
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return json;
}

// The simulated tool-call stream. Tool steps use the bridge's content shape (a
// fenced block whose first line becomes the chip label); thinking steps carry a
// short rationale so the chip is expandable.
const STEPS = simulation.steps.map((step) => ({ t: step.type, c: step.content }));
const RESPONSE_TEXT = simulation.responseText;
const ERROR_TEXT = simulation.errorText;

// --- bootstrap: login + provision bot -------------------------------------
async function bootstrap() {
  const health = await call('GET', `${BASE}/health`);
  console.log(`→ ${BASE} (${health.environment}, commit ${health.commit})`);
  if (health.environment === 'production') { console.error('Refusing to run against production.'); process.exit(1); }

  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!loginRes.ok) throw new Error(`login as ${ADMIN_USER} failed: ${loginRes.status} ${await loginRes.text()}`);
  const adminCookie = (loginRes.headers.get('set-cookie') ?? '').match(/session=([^;]+)/)?.[1];
  if (!adminCookie) throw new Error('login ok but no session cookie returned');
  const admin = { cookie: adminCookie };
  console.log(`✓ logged in as ${ADMIN_USER}`);

  let agent = admin, agentName = ADMIN_USER, botId = null;
  try {
    try {
      const created = await call('POST', `${API}/users`, {
        auth: admin,
        body: { username: BOT_USERNAME, password: `sim-${BOT_USERNAME}-pw`, displayName: BOT_USERNAME, role: 'bot' },
      });
      botId = created.id;
      console.log(`✓ created bot @${BOT_USERNAME}`);
    } catch (e) {
      if (!/-> 409/.test(String(e))) throw e;
      const bots = await call('GET', `${API}/users/bots`, { auth: admin });
      const list = Array.isArray(bots) ? bots : bots.bots ?? bots.users ?? [];
      botId = list.find((b) => b.username === BOT_USERNAME)?.id;
      if (!botId) throw new Error(`bot @${BOT_USERNAME} exists but was not found in /users/bots`, { cause: e });
      console.log(`✓ reusing existing bot @${BOT_USERNAME}`);
    }
    const tok = await call('POST', `${API}/users/${botId}/api-tokens`, { auth: admin, body: { name: 'sim-agent-run' } });
    agent = { bearer: tok.token };
    agentName = BOT_USERNAME;
  } catch (e) {
    if (LISTEN) throw new Error(`bot provisioning failed and --listen needs a distinct bot identity: ${String(e).split('\n')[0]}`, { cause: e });
    console.warn(`! bot provisioning failed (${String(e).split('\n')[0]}) — posting as ${ADMIN_USER}`);
  }
  return { admin, agent, agentName, botId };
}

// --- one simulated agent turn against a trigger message --------------------
async function startRunProcess({ agent, channelId, triggerId }) {
  const proc = await call('POST', `${API}/processes`, {
    auth: agent, body: { channel_id: channelId, message_id: triggerId, status: 'running' },
  });
  const processId = proc.id;
  await call('POST', `${API}/messages/${triggerId}/process`, { auth: agent, body: { processId, status: 'processing' } });
  return processId;
}

async function simulateRun({ agent, channelId, triggerId, threadId = null }) {
  // When threadId is set, every step/response is posted as a reply in that thread
  // (thread_id column) so the client renders them in the thread pane's AgentSteps
  // block; omitted entirely for top-level runs so the body stays identical.
  const threadField = threadId ? { threadId } : {};

  const processId = await startRunProcess({ agent, channelId, triggerId });

  for (const step of STEPS) {
    await call('POST', `${API}/channels/${channelId}/messages`, {
      auth: agent, body: { content: step.c, message_type: step.t, ...threadField, metadata: { trigger_id: triggerId } },
    });
    await call('POST', `${API}/processes/${processId}/activity`, { auth: agent, body: { type: 'tool_call' } });
    await sleep(DELAY_MS);
  }

  await call('POST', `${API}/channels/${channelId}/messages`, {
    auth: agent, body: { content: RESPONSE_TEXT, message_type: 'response', ...threadField, metadata: { trigger_id: triggerId } },
  });
  await call('POST', `${API}/processes/${processId}/activity`, { auth: agent, body: { type: 'reply' } });
  await call('POST', `${API}/processes/${processId}/activity`, { auth: agent, body: { type: 'token_usage', input_tokens: 4200, output_tokens: 1300 } });
  await call('PATCH', `${API}/processes/${processId}`, { auth: agent, body: { status: 'done' } });
  return processId;
}

async function simulateErroredRun({ agent, channelId, triggerId }) {
  const processId = await startRunProcess({ agent, channelId, triggerId });
  await sleep(Math.min(DELAY_MS, 500));
  await call('PATCH', `${API}/processes/${processId}`, { auth: agent, body: { status: 'error' } });
  await call('POST', `${API}/messages/${triggerId}/process`, {
    auth: agent,
    body: { processId, status: 'error', error_text: ERROR_TEXT },
  });
  return processId;
}

// --- one-shot mode ----------------------------------------------------------
async function oneShot(ctx) {
  const chanName = `agent-ui-test-${Date.now().toString(36)}`;
  const channel = await call('POST', `${API}/channels`, { auth: ctx.admin, body: { name: chanName } });
  console.log(`✓ channel #${chanName} (${channel.id})`);
  if (ctx.agent.bearer) await call('POST', `${API}/channels/${channel.id}/join`, { auth: ctx.agent });

  const trigger = await call('POST', `${API}/channels/${channel.id}/messages`, {
    auth: ctx.admin, body: { content: 'Investigate the UI issues and report back.' },
  });
  console.log(`✓ trigger ${trigger.id} — streaming ${STEPS.length} steps…`);
  await simulateRun({ agent: ctx.agent, channelId: channel.id, triggerId: trigger.id });
  console.log(`✓ done. Open ${BASE} → #${chanName} for the "${ctx.agentName} ran ${STEPS.length} tools" panel.`);
}

// --- presence: hold a /ws/presence socket so the bot shows "available" ------
// Online (the green dot) = holding this socket. The server pings; we must reply
// {type:"pong"} or it drops us after a couple misses. Mirrors the Go bridge's
// MaintainPresence. Reconnects on close so the bot stays green for the session.
function maintainPresence(bearer) {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws/presence`;
  const connect = () => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${bearer}` } });
    ws.addEventListener('open', () => console.log('· presence online (bot shows available)'));
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* close handler reconnects */ } }
    });
    ws.addEventListener('close', (e) => { console.log(`· presence closed (${e.code}) — reconnecting in 2s`); setTimeout(connect, 2000); });
    ws.addEventListener('error', () => { /* close handler reconnects */ });
  };
  connect();
}

// --- listen mode: respond to every human message ---------------------------
async function listen(ctx) {
  // Where to chat: join the given channel, else spin up a fresh sandbox the bot
  // is a member of. The bot also responds in ANY other channel you add it to.
  let sandbox;
  if (CHANNEL) {
    await call('POST', `${API}/channels/${CHANNEL}/join`, { auth: ctx.agent }).catch(() => {});
    sandbox = { id: CHANNEL, name: CHANNEL };
  } else {
    const name = `bot-sandbox-${Date.now().toString(36)}`;
    const ch = await call('POST', `${API}/channels`, { auth: ctx.admin, body: { name } });
    await call('POST', `${API}/channels/${ch.id}/join`, { auth: ctx.agent });
    sandbox = { id: ch.id, name };
  }

  const me = await call('GET', `${API}/users/me`, { auth: ctx.agent });
  const agentUserId = me.id;
  const seen = new Set();

  console.log(`\n● Listening as @${ctx.agentName}. Open ${BASE} → #${sandbox.name} (${sandbox.id}) and post a message.`);
  console.log(`  (It also responds in any other channel you add @${BOT_USERNAME} to.)`);
  console.log(`  Include the keyword "error" to simulate a failed process with error details. Ctrl-C to stop.\n`);

  // Hold a presence socket so the bot shows as available (green) while listening.
  maintainPresence(ctx.agent.bearer);

  const wsUrl = `${BASE.replace(/^http/, 'ws')}/events`;
  const connect = () => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ctx.agent.bearer}` } });
    ws.addEventListener('open', () => console.log('· connected to /events'));
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type !== 'message') return;
      const senderId = m.userId ?? m.user_id;
      const type = m.messageType ?? m.message_type ?? 'human';
      if (type !== 'human' || senderId === agentUserId || seen.has(m.id)) return; // ignore self / non-human / dupes
      seen.add(m.id);
      // Where to post the reply stream. A human message posted inside a thread is
      // answered in that same thread. A top-level message stays top-level unless
      // --thread was passed, which roots a new thread at the trigger so the steps
      // render in the thread pane's AgentSteps block.
      const threadId = m.threadId ?? m.thread_id ?? (THREAD ? m.id : null);
      const where = threadId ? `thread ${threadId}` : `#${m.channelId}`;
      const content = m.content || '';
      const shouldError = ERROR_KEYWORD.test(content);
      const run = shouldError
        ? simulateErroredRun({ agent: ctx.agent, channelId: m.channelId, triggerId: m.id })
        : simulateRun({ agent: ctx.agent, channelId: m.channelId, triggerId: m.id, threadId });
      const mode = shouldError ? 'simulating error' : `running ${STEPS.length} steps`;
      console.log(`▶ ${m.username || senderId} in ${where}: "${content.slice(0, 60)}" — ${mode}`);
      run
        .then(() => console.log(`✓ ${shouldError ? 'marked error for' : 'responded to'} ${m.id}`))
        .catch((e) => console.error(`✗ run for ${m.id} failed: ${e.message}`));
    });
    ws.addEventListener('close', (e) => { console.log(`· /events closed (${e.code}) — reconnecting in 2s`); setTimeout(connect, 2000); });
    ws.addEventListener('error', () => { /* close handler reconnects */ });
  };
  connect();
}

async function main() {
  const ctx = await bootstrap();
  if (LISTEN) await listen(ctx);
  else await oneShot(ctx);
}

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
