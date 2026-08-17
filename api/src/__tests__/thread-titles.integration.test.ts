import { beforeAll, describe, expect, it } from 'vitest';
import { authedFetch, createTestUser, loginUser } from './helpers.js';

describe('Thread titles', () => {
  let ownerToken: string;
  let memberToken: string;
  let outsiderToken: string;
  let channelId: string;
  let threadId: string;
  let replyId: string;

  beforeAll(async () => {
    await createTestUser('thread_title_owner');
    await createTestUser('thread_title_member');
    await createTestUser('thread_title_outsider');
    ownerToken = (await loginUser('thread_title_owner')).sessionToken;
    memberToken = (await loginUser('thread_title_member')).sessionToken;
    outsiderToken = (await loginUser('thread_title_outsider')).sessionToken;

    const channelResponse = await authedFetch(ownerToken, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'thread-title-test' }),
    });
    channelId = ((await channelResponse.json()) as any).id;
    await authedFetch(memberToken, `/channels/${channelId}/join`, { method: 'POST' });

    const rootResponse = await authedFetch(ownerToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Root message content that remains unchanged' }),
    });
    threadId = ((await rootResponse.json()) as any).id;

    const replyResponse = await authedFetch(ownerToken, `/messages/${threadId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ content: 'A reply in the titled thread' }),
    });
    replyId = ((await replyResponse.json()) as any).id;
  });

  it('lets any current member set a prose title through a reply id', async () => {
    const response = await authedFetch(memberToken, `/messages/${replyId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: '  API Design: Names, not slugs!  ' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toMatchObject({
      ok: true,
      applied: true,
      thread_id: threadId,
      thread_title: 'API Design: Names, not slugs!',
    });
    expect(typeof body.thread_title_updated_at).toBe('number');
  });

  it('returns the title on root-message read models with camelCase aliases', async () => {
    const response = await authedFetch(ownerToken, `/messages/${threadId}`);
    expect(response.status).toBe(200);
    const message = (await response.json()) as any;

    expect(message.content).toBe('Root message content that remains unchanged');
    expect(message.thread_title).toBe('API Design: Names, not slugs!');
    expect(message.threadTitle).toBe('API Design: Names, not slugs!');
    expect(message.thread_title_updated_at).toEqual(expect.any(Number));
    expect(message.threadTitleUpdatedAt).toBe(message.thread_title_updated_at);
  });

  it('renames an existing title without slugifying it', async () => {
    const response = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Release v2 — What changed?' }),
    });

    expect(response.status).toBe(200);
    const renamed = (await response.json()) as any;
    expect(renamed).toMatchObject({
      applied: true,
      thread_title: 'Release v2 — What changed?',
    });

    const repeatedResponse = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Release v2 — What changed?' }),
    });
    expect(repeatedResponse.status).toBe(200);
    expect((await repeatedResponse.json()) as any).toMatchObject({
      applied: false,
      thread_title: 'Release v2 — What changed?',
      thread_title_updated_at: renamed.thread_title_updated_at,
    });
  });

  it('preserves an existing title for a guarded automatic update', async () => {
    const response = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Generated replacement', if_unset: true }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as any).toMatchObject({
      applied: false,
      thread_title: 'Release v2 — What changed?',
    });
  });

  it('applies a guarded title to an untitled root', async () => {
    const rootResponse = await authedFetch(ownerToken, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Another root awaiting an automatic title' }),
    });
    const untitledThreadId = ((await rootResponse.json()) as any).id;

    const response = await authedFetch(ownerToken, `/messages/${untitledThreadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Generated first title', if_unset: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as any).toMatchObject({
      applied: true,
      thread_id: untitledThreadId,
      thread_title: 'Generated first title',
    });
  });

  it('rejects empty and oversized titles', async () => {
    const empty = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: '   ' }),
    });
    expect(empty.status).toBe(400);

    const oversized = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'x'.repeat(121) }),
    });
    expect(oversized.status).toBe(400);

    const unicode = await authedFetch(ownerToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: '😀'.repeat(120) }),
    });
    expect(unicode.status).toBe(200);
    expect((await unicode.json()) as any).toMatchObject({
      applied: true,
      thread_title: '😀'.repeat(120),
    });
  });

  it('rejects a non-member and an unknown thread', async () => {
    const forbidden = await authedFetch(outsiderToken, `/messages/${threadId}/thread-title`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'No access' }),
    });
    expect(forbidden.status).toBe(403);

    const missing = await authedFetch(ownerToken, '/messages/not-a-thread/thread-title', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Missing' }),
    });
    expect(missing.status).toBe(404);
  });
});
