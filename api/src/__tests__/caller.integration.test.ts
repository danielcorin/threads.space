import { beforeAll, describe, expect, it } from 'vitest';
import { createCaller, type Caller } from '../../../agent-tools/cli/src/index.js';
import { BASE_URL, authedFetch, createTestUser, json, loginUser } from './helpers.js';

describe('shared caller contract against the live API', () => {
  let caller: Caller;
  let botCaller: Caller;
  let adminSession: string;
  let channelId: string;
  let channelName: string;
  let callerUsername: string;

  beforeAll(async () => {
    const login = await loginUser('__testadmin__');
    adminSession = login.sessionToken;

    callerUsername = `caller_contract_user_${Date.now()}`;
    const callerUser = await createTestUser(callerUsername);

    const tokenResponse = await authedFetch(adminSession, `/users/${callerUser.id}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: `caller-contract-${Date.now()}` }),
    });
    expect(tokenResponse.status).toBe(201);
    const { token } = await json(tokenResponse);
    caller = createCaller({ baseUrl: BASE_URL, token });

    const botUser = await createTestUser(
      `caller_contract_bot_${Date.now()}`,
      'testpass123',
      undefined,
      'bot',
    );
    const botTokenResponse = await authedFetch(adminSession, `/users/${botUser.id}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: `caller-contract-bot-${Date.now()}` }),
    });
    expect(botTokenResponse.status).toBe(201);
    botCaller = createCaller({ baseUrl: BASE_URL, token: (await json(botTokenResponse)).token });

    channelName = `caller-contract-${Date.now()}`;
    const channelResponse = await authedFetch(adminSession, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: channelName }),
    });
    expect(channelResponse.status).toBe(201);
    channelId = (await json(channelResponse)).id;
  });

  it('executes and validates representative read, composition, write, and search actions', async () => {
    await expect(caller.run('whoami', {})).resolves.toMatchObject({ username: callerUsername });

    const conversationsBeforeJoin = await caller.run('list_conversations', {}) as {
      channels: Array<{ id: string }>;
    };
    expect(conversationsBeforeJoin.channels.some((channel) => channel.id === channelId)).toBe(false);

    const browsable = await caller.run('browse_channels', {}) as {
      channels: Array<{ id: string; is_member: boolean }>;
    };
    expect(browsable.channels).toContainEqual(expect.objectContaining({ id: channelId, is_member: false }));

    await expect(caller.run('join_channel', { channel_id: channelId })).resolves.toEqual({ ok: true });

    const conversationsAfterJoin = await caller.run('list_conversations', {}) as {
      channels: Array<{ id: string; is_member: boolean | null }>;
    };
    expect(conversationsAfterJoin.channels).toContainEqual(expect.objectContaining({
      id: channelId,
      is_member: true,
    }));

    const sent = await caller.run('send_message', {
      channel_id: channelId,
      content: 'caller contract integration marker',
      idempotency_key: `caller-${Date.now()}`,
    }) as { id: string; content: string };
    expect(sent.content).toBe('caller contract integration marker');
    expect(sent).not.toHaveProperty('channelId');

    const reply = await caller.run('reply_to_message', {
      message_id: sent.id,
      content: 'reply used to resolve the thread root',
    }) as { id: string; thread_id: string };
    expect(reply.thread_id).toBe(sent.id);

    const threadFromReply = await caller.run('get_thread', {
      message_id: reply.id,
    }) as { messages: Array<{ id: string }> };
    expect(threadFromReply.messages.some((message) => message.id === reply.id)).toBe(true);

    const page = await caller.run('list_messages', { channel_id: channelId }) as {
      messages: Array<{ id: string }>;
    };
    expect(page.messages.some((message) => message.id === sent.id)).toBe(true);

    await expect(caller.run('add_reaction', {
      message_id: sent.id,
      emoji: '✅',
    })).resolves.toEqual({ ok: true });

    await expect(caller.run('edit_message', {
      message_id: sent.id,
      content: 'caller contract integration marker edited',
    })).resolves.toEqual({ ok: true });
    await expect(caller.run('get_message', { message_id: sent.id })).resolves.toMatchObject({
      id: sent.id,
      content: 'caller contract integration marker edited',
    });

    await expect(caller.run('resolve_message', { message_id: sent.id })).resolves.toMatchObject({
      ok: true,
      resolved_by: expect.any(String),
      resolved_at: expect.any(Number),
    });
    await expect(caller.run('unresolve_message', { message_id: sent.id })).resolves.toEqual({ ok: true });

    await expect(caller.run('set_thread_title', {
      message_id: reply.id,
      title: 'Caller API: Thread titles',
    })).resolves.toMatchObject({
      ok: true,
      applied: true,
      thread_id: sent.id,
      thread_title: 'Caller API: Thread titles',
      thread_title_updated_at: expect.any(Number),
    });
    await expect(caller.run('get_message', { message_id: sent.id })).resolves.toMatchObject({
      thread_title: 'Caller API: Thread titles',
      thread_title_updated_at: expect.any(Number),
    });

    await expect(caller.run('pin_message', {
      channel_id: channelId,
      message_id: sent.id,
    })).resolves.toMatchObject({ channel_id: channelId, message_id: sent.id });
    await expect(caller.run('list_pins', { channel_id: channelId })).resolves.toMatchObject({
      pins: [expect.objectContaining({ message_id: sent.id })],
    });
    await expect(caller.run('unpin_message', {
      channel_id: channelId,
      message_id: sent.id,
    })).resolves.toEqual({ ok: true });

    const upload = await caller.run('upload_attachment', {
      filename: 'caller.txt',
      content_type: 'text/plain',
      base64_data: 'aGVsbG8=',
    }) as { id: string; content_type: string; size_bytes: number };
    expect(upload).toMatchObject({ content_type: 'text/plain', size_bytes: 5 });

    await expect(caller.run('send_message', {
      channel_id: channelId,
      content: 'message with caller attachment',
      attachment_ids: [upload.id],
    })).resolves.toMatchObject({
      attachments: [expect.objectContaining({ filename: 'caller.txt' })],
    });

    await expect(caller.run('mark_read', { channel_id: channelId })).resolves.toEqual({ ok: true });

    const search = await caller.run('search_messages', {
      query: 'integration marker edited',
      channel_id: channelId,
    }) as { results: Array<{ id: string; snippet: string | null }> };
    expect(search.results.some((message) => message.id === sent.id)).toBe(true);
    expect(search.results.every((message) => !message.snippet?.includes('\u0002'))).toBe(true);
  });

  it('exposes channel discovery, boards, drafts, process reads, DMs, and ephemeral lifecycle', async () => {
    await expect(caller.run('find_channels', {
      query: channelName,
      limit: 5,
    })).resolves.toHaveProperty('channels');
    await expect(caller.run('get_channel', { channel_id: channelId })).resolves.toMatchObject({ id: channelId });
    const members = await caller.run('list_channel_members', { channel_id: channelId }) as {
      users: Array<{ username: string }>;
    };
    expect(members.users.some((user) => user.username === callerUsername)).toBe(true);
    await expect(caller.run('set_channel_notifications', {
      channel_id: channelId,
      tier: 'mentions',
    })).resolves.toMatchObject({ tier: 'mentions' });

    await expect(caller.run('search_users', { query: '__testadmin__' })).resolves.toMatchObject({
      users: [expect.objectContaining({ username: '__testadmin__' })],
    });
    await expect(caller.run('create_dm_by_username', { username: '__testadmin__' })).resolves.toHaveProperty('id');

    await expect(caller.run('list_processes', {})).resolves.toHaveProperty('processes');

    await expect(caller.run('create_board', { channel_id: channelId })).resolves.toMatchObject({
      channel_id: channelId,
    });
    await expect(caller.run('update_board', {
      channel_id: channelId,
      columns: ['todo', 'doing', 'done'],
    })).resolves.toMatchObject({ columns: '["todo","doing","done"]' });
    const card = await caller.run('create_board_card', {
      channel_id: channelId,
      title: 'Caller card',
      metadata: { source: 'caller-test' },
    }) as { id: string };
    await expect(caller.run('update_board_card', {
      card_id: card.id,
      priority: 'high',
    })).resolves.toMatchObject({ id: card.id, priority: 'high' });
    await expect(caller.run('get_board', { channel_id: channelId })).resolves.toMatchObject({
      cards: [expect.objectContaining({ id: card.id })],
    });
    await expect(caller.run('delete_board_card', { card_id: card.id })).resolves.toEqual({ ok: true });

    const draft = await caller.run('create_saved_draft', {
      channel_id: channelId,
      content: 'caller scheduled draft',
    }) as { id: string };
    await expect(caller.run('list_saved_drafts', { channel_id: channelId })).resolves.toMatchObject({
      drafts: [expect.objectContaining({ id: draft.id })],
    });
    await expect(caller.run('schedule_saved_draft', {
      draft_id: draft.id,
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
    })).resolves.toMatchObject({ id: draft.id });
    await expect(caller.run('delete_saved_draft', { draft_id: draft.id })).resolves.toEqual({ ok: true });

    const ephemeral = await caller.run('create_ephemeral_channel', {}) as { id: string };
    await expect(caller.run('rename_ephemeral_channel', {
      channel_id: ephemeral.id,
      slug: `caller-ephemeral-${Date.now()}`,
    })).resolves.toMatchObject({ ok: true });
    await expect(caller.run('regenerate_ephemeral_name', {
      channel_id: ephemeral.id,
    })).resolves.toMatchObject({ ok: true, auto_named_at: null });
    await expect(caller.run('archive_ephemeral_channel', {
      channel_id: ephemeral.id,
    })).resolves.toMatchObject({ ok: true });
    await expect(caller.run('unarchive_ephemeral_channel', {
      channel_id: ephemeral.id,
    })).resolves.toMatchObject({ ok: true, archived_at: null });
    await expect(caller.run('promote_ephemeral_channel', {
      channel_id: ephemeral.id,
      name: `caller-promoted-${Date.now()}`,
    })).resolves.toMatchObject({ ok: true, id: ephemeral.id });
    await expect(caller.run('delete_channel', {
      channel_id: ephemeral.id,
    })).resolves.toEqual({ ok: true });
  });

  it('executes a complete bot process lifecycle, including kill, retry, cleanup, and bulk kill', async () => {
    await expect(caller.run('join_channel', { channel_id: channelId })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('join_channel', { channel_id: channelId })).resolves.toEqual({ ok: true });

    const sendTrigger = async (label: string): Promise<{ id: string }> => caller.run('send_message', {
      channel_id: channelId,
      content: `caller process ${label}`,
      idempotency_key: `caller-process-${label}-${Date.now()}`,
    }) as Promise<{ id: string }>;

    const completedTrigger = await sendTrigger('completed');
    const completed = await botCaller.run('create_process', {
      channel_id: channelId,
      message_id: completedTrigger.id,
      status: 'running',
    }) as { id: string };
    await expect(botCaller.run('set_message_process_status', {
      message_id: completedTrigger.id,
      process_id: completed.id,
      status: 'processing',
    })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('record_process_activity', {
      process_id: completed.id,
      type: 'tool_call',
    })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('record_process_activity', {
      process_id: completed.id,
      type: 'token_usage',
      input_tokens: 7,
      output_tokens: 3,
    })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('update_process', {
      process_id: completed.id,
      status: 'done',
      input_tokens: 9,
    })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('get_process', { process_id: completed.id })).resolves.toMatchObject({
      id: completed.id,
      status: 'done',
      tool_call_count: 1,
      input_tokens: 9,
      output_tokens: 3,
    });
    await expect(botCaller.run('list_processes', { status: 'done' })).resolves.toMatchObject({
      processes: expect.arrayContaining([expect.objectContaining({ id: completed.id, status: 'done' })]),
    });

    const killedTrigger = await sendTrigger('killed');
    const killed = await botCaller.run('create_process', {
      channel_id: channelId,
      message_id: killedTrigger.id,
      status: 'queued',
    }) as { id: string };
    await expect(botCaller.run('kill_process', { process_id: killed.id })).resolves.toEqual({ ok: true });
    await expect(botCaller.run('get_process', { process_id: killed.id })).resolves.toMatchObject({
      id: killed.id,
      status: 'killed',
    });
    await expect(botCaller.run('retry_message', { message_id: killedTrigger.id })).resolves.toEqual({ ok: true });

    const restartedTrigger = await sendTrigger('restarted');
    const restarted = await botCaller.run('create_process', {
      channel_id: channelId,
      message_id: restartedTrigger.id,
      status: 'running',
    }) as { id: string };
    await expect(botCaller.run('cleanup_processes_by_bot', {})).resolves.toMatchObject({
      cleaned: 1,
      process_ids: [restarted.id],
    });
    await expect(botCaller.run('get_process', { process_id: restarted.id })).resolves.toMatchObject({
      id: restarted.id,
      status: 'restarted',
    });

    const bulkTrigger = await sendTrigger('bulk-killed');
    const bulkKilled = await botCaller.run('create_process', {
      channel_id: channelId,
      message_id: bulkTrigger.id,
      status: 'queued',
    }) as { id: string };
    await expect(botCaller.run('kill_all_processes', {})).resolves.toMatchObject({
      cleaned: 1,
      process_ids: [bulkKilled.id],
    });
    await expect(botCaller.run('get_process', { process_id: bulkKilled.id })).resolves.toMatchObject({
      id: bulkKilled.id,
      status: 'killed',
    });
  });
});
