import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { authedFetch, createTestUser, loginUser, makeAdmin } from './helpers.js';

const WS_BASE = 'ws://localhost:8799';

function connectChannel(channelId: string, sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/${channelId}`, {
      headers: { Cookie: `session=${sessionToken}` },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 5000);
    function handler(data: WebSocket.Data) {
      try {
        const message = JSON.parse(data.toString());
        if (predicate(message)) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(message);
        }
      } catch {
        // Ignore non-JSON frames.
      }
    }
    ws.on('message', handler);
  });
}

async function createBot(username: string): Promise<{ id: string; token: string }> {
  const created = await createTestUser(username, 'testpass123', undefined, 'bot');
  const login = await loginUser(username);
  return { id: created.id || login.user.id, token: login.sessionToken };
}

describe('Agent processes', () => {
  let humanToken: string;
  let memberToken: string;
  let outsiderToken: string;
  let adminToken: string;
  let botToken: string;
  let otherBotToken: string;
  let humanId: string;
  let botId: string;
  let otherBotId: string;
  let channelId: string;
  let messageId: string;

  // Spawn a fresh process via the bot for the shared channel/message, returning its id.
  async function spawnProcess(status?: string): Promise<string> {
    const res = await authedFetch(botToken, '/processes', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, message_id: messageId, ...(status ? { status } : {}) }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    return body.id;
  }

  beforeAll(async () => {
    await createTestUser('proc_human');
    const humanLogin = await loginUser('proc_human');
    humanToken = humanLogin.sessionToken;
    humanId = humanLogin.user.id;

    await createTestUser('proc_member');
    memberToken = (await loginUser('proc_member')).sessionToken;

    await createTestUser('proc_outsider');
    outsiderToken = (await loginUser('proc_outsider')).sessionToken;

    await createTestUser('proc_admin');
    await makeAdmin('proc_admin');
    adminToken = (await loginUser('proc_admin')).sessionToken;

    const bot = await createBot('proc_bot');
    botToken = bot.token;
    botId = bot.id;
    const otherBot = await createBot('proc_other_bot');
    otherBotToken = otherBot.token;
    otherBotId = otherBot.id;

    // A channel the bot, the human owner, and one extra member belong to; the outsider does not.
    const chanRes = await authedFetch(humanToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'proc-test-channel' }),
    });
    channelId = ((await chanRes.json()) as any).id;
    await authedFetch(memberToken, `/channels/${channelId}/join`, { method: 'POST' });
    await authedFetch(botToken, `/channels/${channelId}/join`, { method: 'POST' });
    await authedFetch(otherBotToken, `/channels/${channelId}/join`, { method: 'POST' });

    const msgRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'kick off a run' }),
    });
    messageId = ((await msgRes.json()) as any).id;
  });

  describe('POST /processes (create)', () => {
    it('lets a bot member create a process, defaulting to running', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeTruthy();
      expect(body.status).toBe('running');

      const message = await (await authedFetch(botToken, `/messages/${messageId}`)).json() as any;
      expect(message.processId).toBe(body.id);
      expect(message.processStatus).toBe('processing');
    });

    it('honors an explicit starting status', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, status: 'queued' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.status).toBe('queued');

      const message = await (await authedFetch(botToken, `/messages/${messageId}`)).json() as any;
      expect(message.processId).toBe(body.id);
      expect(message.processStatus).toBe('queued');
    });

    it('rejects an invalid starting status', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, status: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a message from a different channel', async () => {
      const otherChannelRes = await authedFetch(humanToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'proc-other-channel' }),
      });
      const otherChannelId = ((await otherChannelRes.json()) as any).id;
      const otherMessageRes = await authedFetch(humanToken, `/channels/${otherChannelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'wrong channel trigger' }),
      });
      const otherMessageId = ((await otherMessageRes.json()) as any).id;

      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: otherMessageId }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-bot human with 403', async () => {
      const res = await authedFetch(humanToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId }),
      });
      expect(res.status).toBe(403);
    });

    it('requires channel_id', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ message_id: messageId }),
      });
      expect(res.status).toBe(400);
    });

    it('requires message_id', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a bot that is not a member of the channel with 403', async () => {
      const lone = await createBot('proc_bot_outsider');
      const res = await authedFetch(lone.token, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects a bot that assigns another bot as the process owner', async () => {
      const res = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: messageId, bot_id: otherBotId }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /processes (list + visibility)', () => {
    let listProcId: string;

    beforeAll(async () => {
      listProcId = await spawnProcess();
    });

    it('shows a channel member their channel runs', async () => {
      const res = await authedFetch(memberToken, '/processes');
      expect(res.status).toBe(200);
      const { processes } = (await res.json()) as any;
      expect(processes.some((p: any) => p.id === listProcId)).toBe(true);
    });

    it('hides runs from a non-member', async () => {
      const res = await authedFetch(outsiderToken, '/processes');
      expect(res.status).toBe(200);
      const { processes } = (await res.json()) as any;
      expect(processes.some((p: any) => p.id === listProcId)).toBe(false);
    });

    it('hides runs from a user who left the channel', async () => {
      await createTestUser('proc_former_member');
      const formerMemberToken = (await loginUser('proc_former_member')).sessionToken;
      await authedFetch(formerMemberToken, `/channels/${channelId}/join`, { method: 'POST' });

      const visibleRes = await authedFetch(formerMemberToken, '/processes');
      expect(visibleRes.status).toBe(200);
      const visibleBody = (await visibleRes.json()) as any;
      expect(visibleBody.processes.some((p: any) => p.id === listProcId)).toBe(true);

      const leaveRes = await authedFetch(formerMemberToken, `/channels/${channelId}/membership`, { method: 'DELETE' });
      expect(leaveRes.status).toBe(200);

      const hiddenRes = await authedFetch(formerMemberToken, '/processes');
      expect(hiddenRes.status).toBe(200);
      const hiddenBody = (await hiddenRes.json()) as any;
      expect(hiddenBody.processes.some((p: any) => p.id === listProcId)).toBe(false);
    });

    it('shows runs to an admin who is not a channel member', async () => {
      const res = await authedFetch(adminToken, '/processes');
      expect(res.status).toBe(200);
      const { processes } = (await res.json()) as any;
      expect(processes.some((p: any) => p.id === listProcId)).toBe(true);
    });

    it('returns DM process partner details relative to the viewer', async () => {
      const dmRes = await authedFetch(botToken, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: humanId }),
      });
      expect([200, 201]).toContain(dmRes.status);
      const dm = (await dmRes.json()) as any;

      const msgRes = await authedFetch(botToken, `/channels/${dm.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'bot DM process trigger' }),
      });
      expect(msgRes.status).toBe(201);
      const dmMessage = (await msgRes.json()) as any;

      const procRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: dm.id, message_id: dmMessage.id }),
      });
      expect(procRes.status).toBe(201);
      const procId = ((await procRes.json()) as any).id;

      const listRes = await authedFetch(humanToken, '/processes');
      expect(listRes.status).toBe(200);
      const { processes } = (await listRes.json()) as any;
      const proc = processes.find((p: any) => p.id === procId);
      expect(proc).toBeDefined();
      expect(proc.is_dm).toBe(1);
      expect(proc.dm_partner_id).toBe(botId);
      expect(proc.dm_partner_id).not.toBe(humanId);
    });

    it('surfaces resolved state for the linked top-level thread', async () => {
      const msgRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'resolved process trigger' }),
      });
      expect(msgRes.status).toBe(201);
      const msg = (await msgRes.json()) as any;

      const procRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: msg.id, status: 'done' }),
      });
      expect(procRes.status).toBe(201);
      const procId = ((await procRes.json()) as any).id;

      const resolveRes = await authedFetch(memberToken, `/messages/${msg.id}/resolve`, { method: 'POST' });
      expect(resolveRes.status).toBe(200);

      const listRes = await authedFetch(memberToken, '/processes');
      expect(listRes.status).toBe(200);
      const { processes } = (await listRes.json()) as any;
      const proc = processes.find((p: any) => p.id === procId);
      expect(proc).toBeDefined();
      expect(proc.status).toBe('done');
      expect(proc.resolved_at).toBeTruthy();
      expect(proc.resolved_by).toBeDefined();
    });

    it('surfaces resolved state even when the process did not finish done', async () => {
      const msgRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'resolved errored process trigger' }),
      });
      expect(msgRes.status).toBe(201);
      const msg = (await msgRes.json()) as any;

      const procRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: msg.id, status: 'error' }),
      });
      expect(procRes.status).toBe(201);
      const procId = ((await procRes.json()) as any).id;

      const resolveRes = await authedFetch(memberToken, `/messages/${msg.id}/resolve`, { method: 'POST' });
      expect(resolveRes.status).toBe(200);

      const listRes = await authedFetch(memberToken, '/processes');
      expect(listRes.status).toBe(200);
      const { processes } = (await listRes.json()) as any;
      const proc = processes.find((p: any) => p.id === procId);
      expect(proc).toBeDefined();
      expect(proc.status).toBe('error');
      expect(proc.resolved_at).toBeTruthy();
      expect(proc.resolved_by).toBeDefined();
    });

    it('surfaces resolved state from a top-level response linked to the process trigger', async () => {
      const triggerRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'trigger with resolved response' }),
      });
      expect(triggerRes.status).toBe(201);
      const trigger = (await triggerRes.json()) as any;

      const procRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: trigger.id, status: 'done' }),
      });
      expect(procRes.status).toBe(201);
      const procId = ((await procRes.json()) as any).id;

      const responseRes = await authedFetch(botToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: 'resolved final response',
          message_type: 'response',
          metadata: { trigger_id: trigger.id },
        }),
      });
      expect(responseRes.status).toBe(201);
      const response = (await responseRes.json()) as any;

      const resolveRes = await authedFetch(memberToken, `/messages/${response.id}/resolve`, { method: 'POST' });
      expect(resolveRes.status).toBe(200);

      const listRes = await authedFetch(memberToken, '/processes');
      expect(listRes.status).toBe(200);
      const { processes } = (await listRes.json()) as any;
      const proc = processes.find((p: any) => p.id === procId);
      expect(proc).toBeDefined();
      expect(proc.status).toBe('done');
      expect(proc.resolved_at).toBeTruthy();
      expect(proc.resolved_by).toBeDefined();
    });

    it('surfaces thread-root resolved state for processes attached to replies', async () => {
      const rootRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'resolved thread root' }),
      });
      expect(rootRes.status).toBe(201);
      const root = (await rootRes.json()) as any;

      const replyRes = await authedFetch(humanToken, `/messages/${root.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'continue in the thread' }),
      });
      expect(replyRes.status).toBe(201);
      const reply = (await replyRes.json()) as any;

      const procRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: reply.id, status: 'done' }),
      });
      expect(procRes.status).toBe(201);
      const procId = ((await procRes.json()) as any).id;

      const resolveRes = await authedFetch(memberToken, `/messages/${root.id}/resolve`, { method: 'POST' });
      expect(resolveRes.status).toBe(200);

      const listRes = await authedFetch(memberToken, '/processes');
      expect(listRes.status).toBe(200);
      const { processes } = (await listRes.json()) as any;
      const proc = processes.find((p: any) => p.id === procId);
      expect(proc).toBeDefined();
      expect(proc.thread_id).toBe(root.id);
      expect(proc.resolved_at).toBeTruthy();
      expect(proc.resolved_by).toBeDefined();
    });

    it('filters by status', async () => {
      const queuedId = await spawnProcess('queued');
      const res = await authedFetch(memberToken, '/processes?status=queued');
      expect(res.status).toBe(200);
      const { processes } = (await res.json()) as any;
      expect(processes.every((p: any) => p.status === 'queued')).toBe(true);
      expect(processes.some((p: any) => p.id === queuedId)).toBe(true);
    });

    it('normalizes started_at to ISO 8601', async () => {
      const res = await authedFetch(memberToken, '/processes');
      const { processes } = (await res.json()) as any;
      const proc = processes.find((p: any) => p.id === listProcId);
      expect(proc.started_at).toMatch(/T.*Z$/);
    });
  });

  describe('GET /processes/:id (detail)', () => {
    let procId: string;

    beforeAll(async () => {
      procId = await spawnProcess();
    });

    it('returns detail to a member', async () => {
      const res = await authedFetch(memberToken, `/processes/${procId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(procId);
      expect(body.channel_id).toBe(channelId);
    });

    it('404s for an unknown id', async () => {
      const res = await authedFetch(memberToken, '/processes/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('403s for a non-member', async () => {
      const res = await authedFetch(outsiderToken, `/processes/${procId}`);
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /processes/:id (update)', () => {
    it('lets the bot advance status and stamps ended_at on terminal', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).ok).toBe(true);

      const detail = await (await authedFetch(memberToken, `/processes/${procId}`)).json() as any;
      expect(detail.status).toBe('done');
      expect(detail.ended_at).toMatch(/T.*Z$/);
    });

    it('rejects an invalid status with 400', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an empty update with 400', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-bot human with 403', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(humanToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      expect(res.status).toBe(403);
    });

    it('404s for an unknown id', async () => {
      const res = await authedFetch(botToken, '/processes/nope', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /processes/:id/activity', () => {
    it('increments tool_call and reply counters', async () => {
      const procId = await spawnProcess();
      await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'tool_call' }),
      });
      await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'tool_call' }),
      });
      await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'reply' }),
      });

      const detail = await (await authedFetch(memberToken, `/processes/${procId}`)).json() as any;
      expect(detail.tool_call_count).toBe(2);
      expect(detail.reply_count).toBe(1);
    });

    it('accumulates token usage', async () => {
      const procId = await spawnProcess();
      await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'token_usage', input_tokens: 100, output_tokens: 20 }),
      });
      await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'token_usage', input_tokens: 50, output_tokens: 5 }),
      });

      const detail = await (await authedFetch(memberToken, `/processes/${procId}`)).json() as any;
      expect(detail.input_tokens).toBe(150);
      expect(detail.output_tokens).toBe(25);
    });

    it('rejects an unknown activity type with 400', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'nonsense' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-bot human with 403', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(humanToken, `/processes/${procId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ type: 'tool_call' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /processes/:id (cooperative kill)', () => {
    it('lets a channel member kill a running run', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(memberToken, `/processes/${procId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      const detail = await (await authedFetch(memberToken, `/processes/${procId}`)).json() as any;
      expect(detail.status).toBe('killed');
      expect(detail.ended_at).toMatch(/T.*Z$/);
    });

    it('refuses to kill an already-terminal run with 400', async () => {
      const procId = await spawnProcess();
      await authedFetch(botToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      const res = await authedFetch(memberToken, `/processes/${procId}`, { method: 'DELETE' });
      expect(res.status).toBe(400);
    });

    it('403s for a non-member', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(outsiderToken, `/processes/${procId}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    it('404s for an unknown id', async () => {
      const res = await authedFetch(memberToken, '/processes/ghost', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /processes/cleanup-by-bot', () => {
    it('rejects a non-bot human with 403', async () => {
      const res = await authedFetch(humanToken, '/processes/cleanup-by-bot', { method: 'POST' });
      expect(res.status).toBe(403);
    });

    it('restarts only the caller’s active runs and broadcasts their terminal state', async () => {
      const ownMessageRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'cleanup own process' }),
      });
      const ownMessage = (await ownMessageRes.json()) as any;
      const ownProcessRes = await authedFetch(botToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: ownMessage.id }),
      });
      const ownProcess = (await ownProcessRes.json()) as any;

      const otherMessageRes = await authedFetch(humanToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'cleanup other process' }),
      });
      const otherMessage = (await otherMessageRes.json()) as any;
      const otherProcessRes = await authedFetch(otherBotToken, '/processes', {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, message_id: otherMessage.id }),
      });
      const otherProcess = (await otherProcessRes.json()) as any;

      const foreignUpdate = await authedFetch(botToken, `/processes/${otherProcess.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      expect(foreignUpdate.status).toBe(403);

      const ws = await connectChannel(channelId, memberToken);
      try {
        const updatedEvent = waitForMessage(
          ws,
          (event) => event.type === 'process_updated' && event.process?.id === ownProcess.id,
        );
        const statusEvent = waitForMessage(
          ws,
          (event) => event.type === 'process_status' && event.processId === ownProcess.id,
        );

        const cleanupRes = await authedFetch(botToken, '/processes/cleanup-by-bot', { method: 'POST' });
        expect(cleanupRes.status).toBe(200);
        const cleanup = (await cleanupRes.json()) as any;
        expect(cleanup.process_ids).toContain(ownProcess.id);
        expect(cleanup.process_ids).not.toContain(otherProcess.id);
        expect(cleanup.cleaned).toBe(cleanup.process_ids.length);

        const [updated, status] = await Promise.all([updatedEvent, statusEvent]);
        expect(updated.process.status).toBe('restarted');
        expect(status.status).toBe('restarted');
        expect(status.messageId).toBe(ownMessage.id);

        const ownDetail = await (await authedFetch(memberToken, `/processes/${ownProcess.id}`)).json() as any;
        const otherDetail = await (await authedFetch(memberToken, `/processes/${otherProcess.id}`)).json() as any;
        expect(ownDetail.status).toBe('restarted');
        expect(ownDetail.ended_at).toMatch(/T.*Z$/);
        expect(otherDetail.status).toBe('running');

        const ownMessageDetail = await (await authedFetch(memberToken, `/messages/${ownMessage.id}`)).json() as any;
        const otherMessageDetail = await (await authedFetch(memberToken, `/messages/${otherMessage.id}`)).json() as any;
        expect(ownMessageDetail.processStatus).toBe('restarted');
        expect(otherMessageDetail.processStatus).toBe('processing');

        const lateFinish = await authedFetch(botToken, `/processes/${ownProcess.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'done' }),
        });
        expect(lateFinish.status).toBe(409);

        const lateActivity = await authedFetch(botToken, `/processes/${ownProcess.id}/activity`, {
          method: 'POST',
          body: JSON.stringify({ type: 'reply' }),
        });
        expect(lateActivity.status).toBe(409);

        const secondCleanup = await authedFetch(botToken, '/processes/cleanup-by-bot', { method: 'POST' });
        expect(secondCleanup.status).toBe(200);
        expect(await secondCleanup.json()).toEqual({ cleaned: 0, process_ids: [] });
      } finally {
        ws.terminate();
        await authedFetch(otherBotToken, `/processes/${otherProcess.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'done' }),
        });
      }
    });
  });

  describe('POST /processes/kill-all', () => {
    it('kills the running runs in the caller’s channels and reports the count', async () => {
      const a = await spawnProcess();
      const b = await spawnProcess();

      const res = await authedFetch(memberToken, '/processes/kill-all', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.cleaned).toBeGreaterThanOrEqual(2);
      expect(body.process_ids).toEqual(expect.arrayContaining([a, b]));

      for (const id of [a, b]) {
        const detail = await (await authedFetch(memberToken, `/processes/${id}`)).json() as any;
        expect(detail.status).toBe('killed');
      }
    });

    it('does not kill runs in channels the caller left', async () => {
      await createTestUser('proc_former_killer');
      const formerMemberToken = (await loginUser('proc_former_killer')).sessionToken;
      await authedFetch(formerMemberToken, `/channels/${channelId}/join`, { method: 'POST' });
      const procId = await spawnProcess();

      const leaveRes = await authedFetch(formerMemberToken, `/channels/${channelId}/membership`, { method: 'DELETE' });
      expect(leaveRes.status).toBe(200);

      const res = await authedFetch(formerMemberToken, '/processes/kill-all', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.process_ids).not.toContain(procId);

      const detail = await (await authedFetch(adminToken, `/processes/${procId}`)).json() as any;
      expect(detail.status).toBe('running');

      await authedFetch(botToken, `/processes/${procId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
    });
  });

  // The threads-agent-bridge calls POST /messages/:id/process to mark a message
  // processing/done around each Claude run. This used to 404 on this fork.
  describe('POST /messages/:id/process', () => {
    it('attaches process status + token usage and returns 200', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/messages/${messageId}/process`, {
        method: 'POST',
        body: JSON.stringify({ processId: procId, status: 'processing', input_tokens: 12, output_tokens: 34 }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as any).toEqual({ ok: true });

      const msg = await (await authedFetch(botToken, `/messages/${messageId}`)).json() as any;
      expect(msg.processId).toBe(procId);
      expect(msg.processStatus).toBe('processing');
    });

    it('rejects an invalid status with 400', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/messages/${messageId}/process`, {
        method: 'POST',
        body: JSON.stringify({ processId: procId, status: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts running to match the shared ProcessStatus contract', async () => {
      const procId = await spawnProcess();
      const res = await authedFetch(botToken, `/messages/${messageId}/process`, {
        method: 'POST',
        body: JSON.stringify({ processId: procId, status: 'running' }),
      });
      expect(res.status).toBe(200);

      const message = await (await authedFetch(botToken, `/messages/${messageId}`)).json() as any;
      expect(message.processStatus).toBe('processing');
    });

    it('404s for an unknown message', async () => {
      const res = await authedFetch(botToken, '/messages/ghost/process', {
        method: 'POST',
        body: JSON.stringify({ processId: 'p1', status: 'done' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /messages/:id/retry', () => {
    it('re-queues a message whose run errored', async () => {
      const procId = await spawnProcess();
      await authedFetch(botToken, `/messages/${messageId}/process`, {
        method: 'POST',
        body: JSON.stringify({ processId: procId, status: 'error', error_text: 'boom' }),
      });

      const res = await authedFetch(memberToken, `/messages/${messageId}/retry`, { method: 'POST' });
      expect(res.status).toBe(200);

      const msg = await (await authedFetch(memberToken, `/messages/${messageId}`)).json() as any;
      expect(msg.processStatus).toBe('queued');
    });

    it('refuses to retry a message that is not in a terminal failure state', async () => {
      const procId = await spawnProcess();
      await authedFetch(botToken, `/messages/${messageId}/process`, {
        method: 'POST',
        body: JSON.stringify({ processId: procId, status: 'processing' }),
      });
      const res = await authedFetch(memberToken, `/messages/${messageId}/retry`, { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('403s for a non-member', async () => {
      const res = await authedFetch(outsiderToken, `/messages/${messageId}/retry`, { method: 'POST' });
      expect(res.status).toBe(403);
    });
  });
});
