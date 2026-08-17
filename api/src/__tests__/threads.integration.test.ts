import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Threads', () => {
  let token1: string;
  let channelId: string;
  let parentMessageId: string;

  beforeAll(async () => {
    await createTestUser('thread_user1');
    const login = await loginUser('thread_user1');
    token1 = login.sessionToken;

    // Create channel
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'thread-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;

    // Create parent message
    const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'Thread parent message' }),
    });
    const msg = await msgRes.json() as any;
    parentMessageId = msg.id;
  });

  describe('POST /messages/:id/replies', () => {
    it('creates a reply to a message', async () => {
      const res = await authedFetch(token1, `/messages/${parentMessageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'First reply' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.content).toBe('First reply');
      expect(body.threadId).toBe(parentMessageId);
    });

    it('returns 404 for reply to nonexistent message', async () => {
      const res = await authedFetch(token1, '/messages/nonexistent/replies', {
        method: 'POST',
        body: JSON.stringify({ content: 'Reply to nothing' }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /messages/:id/replies', () => {
    beforeAll(async () => {
      // Add a second reply
      await authedFetch(token1, `/messages/${parentMessageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Second reply' }),
      });
    });

    it('returns replies in order', async () => {
      const res = await authedFetch(token1, `/messages/${parentMessageId}/replies`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.messages).toBeDefined();
      expect(body.messages.length).toBeGreaterThanOrEqual(2);

      // Replies should be in ascending order (ASC by id)
      for (let i = 1; i < body.messages.length; i++) {
        expect(body.messages[i].id > body.messages[i - 1].id).toBe(true);
      }
    });
  });

  describe('Thread reply pagination', () => {
    let paginationParentId: string;
    const paginationReplyIds: string[] = [];

    beforeAll(async () => {
      // Create a parent message for pagination tests
      const msgRes = await authedFetch(token1, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Pagination parent' }),
      });
      const msg = await msgRes.json() as any;
      paginationParentId = msg.id;

      // Create 5 replies
      for (let i = 0; i < 5; i++) {
        const replyRes = await authedFetch(token1, `/messages/${paginationParentId}/replies`, {
          method: 'POST',
          body: JSON.stringify({ content: `Pagination reply ${i}` }),
        });
        const reply = await replyRes.json() as any;
        paginationReplyIds.push(reply.id);
      }
    });

    it('GET /messages/:id/replies respects limit parameter', async () => {
      const res = await authedFetch(token1, `/messages/${paginationParentId}/replies?limit=2`);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.messages.length).toBe(2);
      expect(body.cursor).toBeDefined();
      expect(body.cursor).not.toBeNull();
    });

    it('cursor-based pagination works for replies', async () => {
      // Get first page
      const res1 = await authedFetch(token1, `/messages/${paginationParentId}/replies?limit=2`);
      const page1 = await res1.json() as any;
      expect(page1.messages.length).toBe(2);

      // Get second page using cursor
      const res2 = await authedFetch(
        token1,
        `/messages/${paginationParentId}/replies?limit=2&cursor=${page1.cursor}`,
      );
      const page2 = await res2.json() as any;
      expect(page2.messages.length).toBe(2);

      // Pages should not overlap
      const page1Ids = page1.messages.map((m: any) => m.id);
      const page2Ids = page2.messages.map((m: any) => m.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }

      // Page2 cursor should point to more data (1 remaining)
      const res3 = await authedFetch(
        token1,
        `/messages/${paginationParentId}/replies?limit=2&cursor=${page2.cursor}`,
      );
      const page3 = await res3.json() as any;
      expect(page3.messages.length).toBe(1);
      // No more data, cursor should be null
      expect(page3.cursor).toBeNull();
    });

    it('latest pagination returns newest replies first and pages older with before cursor', async () => {
      const latestRes = await authedFetch(token1, `/messages/${paginationParentId}/replies?latest=true&limit=2`);
      expect(latestRes.status).toBe(200);
      const latestPage = await latestRes.json() as any;

      expect(latestPage.messages.map((m: any) => m.content)).toEqual([
        'Pagination reply 3',
        'Pagination reply 4',
      ]);
      expect(latestPage.cursor).not.toBeNull();

      const olderRes = await authedFetch(
        token1,
        `/messages/${paginationParentId}/replies?before=${latestPage.cursor}&limit=2`,
      );
      expect(olderRes.status).toBe(200);
      const olderPage = await olderRes.json() as any;

      expect(olderPage.messages.map((m: any) => m.content)).toEqual([
        'Pagination reply 1',
        'Pagination reply 2',
      ]);

      const latestIds = latestPage.messages.map((m: any) => m.id);
      for (const id of olderPage.messages.map((m: any) => m.id)) {
        expect(latestIds).not.toContain(id);
      }
    });

    it('around pagination returns a window containing the anchored reply', async () => {
      const anchorId = paginationReplyIds[2];
      const res = await authedFetch(token1, `/messages/${paginationParentId}/replies?around=${anchorId}&limit=3`);
      expect(res.status).toBe(200);
      const page = await res.json() as any;

      expect(page.messages.map((m: any) => m.content)).toEqual([
        'Pagination reply 1',
        'Pagination reply 2',
        'Pagination reply 3',
      ]);
      expect(page.messages.map((m: any) => m.id)).toContain(anchorId);
      expect(page.cursor).not.toBeNull();
      expect(page.hasNewer).toBe(true);
      expect(page.afterCursor).toBe(page.messages[page.messages.length - 1].id);

      const newerRes = await authedFetch(
        token1,
        `/messages/${paginationParentId}/replies?after=${page.afterCursor}&limit=2`,
      );
      expect(newerRes.status).toBe(200);
      const newerPage = await newerRes.json() as any;
      expect(newerPage.messages.map((m: any) => m.content)).toEqual(['Pagination reply 4']);
      expect(newerPage.hasNewer).toBe(false);
    });
  });

  describe('Thread replies vs main channel messages', () => {
    it('thread replies do not appear in main channel message list', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/messages`);
      const body = await res.json() as any;

      // Only the parent message should be in the list, not the replies
      const replyInMain = body.messages.find(
        (m: any) => m.content === 'First reply' || m.content === 'Second reply',
      );
      expect(replyInMain).toBeUndefined();

      // Parent should be there
      const parent = body.messages.find((m: any) => m.content === 'Thread parent message');
      expect(parent).toBeDefined();
    });
  });
});
