import { beforeAll, describe, expect, it } from 'vitest';
import { authedFetch, createTestUser, loginUser } from './helpers.js';

describe('Inbox', () => {
  let readerToken: string;
  let senderToken: string;
  let senderId: string;
  let channelId: string;
  let topLevelId: string;
  let threadedResponseId: string;

  beforeAll(async () => {
    await createTestUser('inbox_reader');
    const senderUser = await createTestUser('inbox_sender');
    senderId = senderUser.id;
    const reader = await loginUser('inbox_reader');
    const sender = await loginUser('inbox_sender');
    readerToken = reader.sessionToken;
    senderToken = sender.sessionToken;

    const channelRes = await authedFetch(readerToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'inbox-test-channel' }),
    });
    channelId = (await channelRes.json() as any).id;
    await authedFetch(senderToken, `/channels/${channelId}/join`, { method: 'POST' });
    await authedFetch(readerToken, `/channels/${channelId}/read`, { method: 'POST' });
  });

  it('lists top-level and threaded messages without marking them read', async () => {
    await authedFetch(readerToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'reader self message' }),
    });
    for (const message_type of ['progress', 'thinking', 'tool_output']) {
      await authedFetch(senderToken, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `${message_type} trace`, message_type }),
      });
    }

    const topLevelRes = await authedFetch(senderToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'top-level unread' }),
    });
    topLevelId = (await topLevelRes.json() as any).id;

    const rootRes = await authedFetch(readerToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'reader thread root' }),
    });
    const rootId = (await rootRes.json() as any).id;
    const replyRes = await authedFetch(senderToken, `/messages/${rootId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ content: 'threaded final response', message_type: 'response' }),
    });
    threadedResponseId = (await replyRes.json() as any).id;

    const first = await authedFetch(readerToken, '/inbox');
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.total).toBe(2);
    expect(firstBody.messages.map((message: any) => message.id)).toEqual([
      threadedResponseId,
      topLevelId,
    ]);
    expect(firstBody.messages.find((message: any) => message.id === threadedResponseId)?.thread_id).toBe(rootId);

    const second = await authedFetch(readerToken, '/inbox');
    expect((await second.json() as any).total).toBe(2);

    const channelsRes = await authedFetch(readerToken, '/channels');
    const channel = (await channelsRes.json() as any[]).find((item) => item.id === channelId);
    expect(channel.unread_count).toBe(2);
  });

  it('marks one message read without clearing its neighbors', async () => {
    const readRes = await authedFetch(readerToken, `/messages/${topLevelId}/read`, { method: 'POST' });
    expect(readRes.status).toBe(200);

    const inboxRes = await authedFetch(readerToken, '/inbox');
    const inbox = await inboxRes.json() as any;
    expect(inbox.total).toBe(1);
    expect(inbox.messages.map((message: any) => message.id)).toEqual([threadedResponseId]);

    const channelsRes = await authedFetch(readerToken, '/channels');
    const channel = (await channelsRes.json() as any[]).find((item) => item.id === channelId);
    expect(channel.unread_count).toBe(1);
  });

  it('clears every remaining Inbox item in a channel when the channel is marked read', async () => {
    const readRes = await authedFetch(readerToken, `/channels/${channelId}/read`, { method: 'POST' });
    expect(readRes.status).toBe(200);

    const inboxRes = await authedFetch(readerToken, '/inbox');
    expect((await inboxRes.json() as any).total).toBe(0);

    const channelsRes = await authedFetch(readerToken, '/channels');
    const channel = (await channelsRes.json() as any[]).find((item) => item.id === channelId);
    expect(channel.unread_count).toBe(0);
  });

  it('includes DMs with enough conversation context to return to them', async () => {
    const dmRes = await authedFetch(readerToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: senderId }),
    });
    const dmId = (await dmRes.json() as any).id;

    const messageRes = await authedFetch(senderToken, `/channels/${dmId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'unread DM' }),
    });
    const dmMessageId = (await messageRes.json() as any).id;

    const inboxRes = await authedFetch(readerToken, '/inbox');
    const inbox = await inboxRes.json() as any;
    const dmMessage = inbox.messages.find((message: any) => message.id === dmMessageId);
    expect(dmMessage).toMatchObject({
      channel_id: dmId,
      is_dm: 1,
      dm_partner_id: senderId,
      dm_partner_username: 'inbox_sender',
    });

    const dmsRes = await authedFetch(readerToken, '/dms');
    const dm = (await dmsRes.json() as any[]).find((item) => item.id === dmId);
    expect(dm.unread_count).toBe(1);

    await authedFetch(readerToken, `/channels/${dmId}/read`, { method: 'POST' });
  });

  it('respects conversation notification preferences', async () => {
    const mutedRes = await authedFetch(readerToken, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: senderId }),
    });
    const dmId = (await mutedRes.json() as any).id;
    await authedFetch(readerToken, `/channels/${dmId}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ tier: 'none' }),
    });
    await authedFetch(senderToken, `/channels/${dmId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'muted DM' }),
    });

    const inboxRes = await authedFetch(readerToken, '/inbox');
    expect((await inboxRes.json() as any).total).toBe(0);

    const dmsRes = await authedFetch(readerToken, '/dms');
    const dm = (await dmsRes.json() as any[]).find((item) => item.id === dmId);
    expect(dm.unread_count).toBe(0);

    await authedFetch(readerToken, `/channels/${dmId}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ tier: 'all' }),
    });
    await authedFetch(readerToken, `/channels/${dmId}/read`, { method: 'POST' });
  });

  it('requires channel membership to acknowledge a message', async () => {
    await createTestUser('inbox_outsider');
    const outsider = await loginUser('inbox_outsider');
    const res = await authedFetch(outsider.sessionToken, `/messages/${threadedResponseId}/read`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
