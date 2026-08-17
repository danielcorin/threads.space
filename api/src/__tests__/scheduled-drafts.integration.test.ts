import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql, querySql, triggerScheduledDelivery } from './helpers.js';

describe('Scheduled Drafts', () => {
  let token1: string;
  let token2: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('sched_draft_user1');
    await createTestUser('sched_draft_user2');
    const login1 = await loginUser('sched_draft_user1');
    const login2 = await loginUser('sched_draft_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create channel and join user2
    const chanRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'sched-draft-test' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;
    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  describe('PATCH /saved-drafts/:id/schedule', () => {
    it('schedules a draft and sets scheduled_at', async () => {
      // Create a draft first
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Schedule me' }),
      });
      const draft = await createRes.json() as any;

      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureTime }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.scheduled_at).toBe(futureTime);
    });

    it('unschedules a draft by setting scheduled_at to null', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Unschedule me' }),
      });
      const draft = await createRes.json() as any;

      // Schedule it first
      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureTime }),
      });

      // Now unschedule
      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.scheduled_at).toBeNull();
    });

    it('rejects scheduling in the past', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Past draft' }),
      });
      const draft = await createRes.json() as any;

      const pastTime = new Date(Date.now() - 3600_000).toISOString();
      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: pastTime }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects scheduling another user\'s draft', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'User1 only' }),
      });
      const draft = await createRes.json() as any;

      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      const res = await authedFetch(token2, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureTime }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /channels/:id/saved-drafts includes scheduled_at', () => {
    it('returns scheduled_at in draft list', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Listed scheduled draft' }),
      });
      const draft = await createRes.json() as any;

      const futureTime = new Date(Date.now() + 7200_000).toISOString();
      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureTime }),
      });

      const listRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const list = await listRes.json() as any;
      const found = list.find((d: any) => d.id === draft.id);
      expect(found).toBeDefined();
      expect(found.scheduled_at).toBe(futureTime);
    });
  });

  // Delivery runs via the scheduled() cron handler, triggered in tests with
  // triggerScheduledDelivery() (wrangler --test-scheduled). Correctness is
  // asserted on the effects (message posted / draft removed), not a return count.
  describe('scheduled delivery (cron simulation)', () => {
    it('delivers a scheduled message that is due and removes the draft', async () => {
      // Create and schedule a draft with a past time (simulate it being due)
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Deliver this scheduled message' }),
      });
      const draft = await createRes.json() as any;

      // Backdate scheduled_at to the past (bypassing API validation)
      execSql(`UPDATE saved_drafts SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '${draft.id}'`);

      await triggerScheduledDelivery();

      // Draft should be gone
      const listRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const list = await listRes.json() as any;
      expect(list.find((d: any) => d.id === draft.id)).toBeUndefined();

      // Message should exist in the channel
      const msgsRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const msgs = await msgsRes.json() as any;
      const delivered = msgs.messages.find((m: any) => m.content === 'Deliver this scheduled message');
      expect(delivered).toBeDefined();
    });

    it('does not double-post when delivery runs twice', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Deliver exactly once' }),
      });
      const draft = await createRes.json() as any;
      execSql(`UPDATE saved_drafts SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '${draft.id}'`);

      await triggerScheduledDelivery();
      await triggerScheduledDelivery();

      const msgsRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const msgs = await msgsRes.json() as any;
      const copies = msgs.messages.filter((m: any) => m.content === 'Deliver exactly once');
      expect(copies.length).toBe(1);
    });

    it('a draft whose author lost membership is dropped and does not block other drafts', async () => {
      // Bad draft: author leaves the channel after scheduling, so delivery 403s
      await createTestUser('sched_draft_user3');
      const login3 = await loginUser('sched_draft_user3');
      const token3 = login3.sessionToken;
      await authedFetch(token3, `/channels/${channelId}/join`, { method: 'POST' });
      const badRes = await authedFetch(token3, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Bad draft - author left channel' }),
      });
      const badDraft = await badRes.json() as any;
      const goodRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Good draft survives bad neighbor' }),
      });
      const goodDraft = await goodRes.json() as any;

      for (const id of [badDraft.id, goodDraft.id]) {
        execSql(`UPDATE saved_drafts SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '${id}'`);
      }
      execSql(`UPDATE channel_members SET left_at = '2020-01-01T00:00:00.000Z' WHERE channel_id = '${channelId}' AND user_id = '${login3.user.id}'`);

      await triggerScheduledDelivery();

      // Good draft was delivered despite the bad one
      const msgsRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const msgs = await msgsRes.json() as any;
      expect(msgs.messages.find((m: any) => m.content === 'Good draft survives bad neighbor')).toBeDefined();
      // Bad draft was not delivered as a message
      expect(msgs.messages.find((m: any) => m.content === 'Bad draft - author left channel')).toBeUndefined();

      // Both drafts were claimed — the bad one is dropped, not left to poison every future run
      const listRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const list = await listRes.json() as any;
      expect(list.find((d: any) => d.id === goodDraft.id)).toBeUndefined();
      const rows = querySql(`SELECT id FROM saved_drafts WHERE id = '${badDraft.id}'`);
      expect(rows.length).toBe(0);
    });

    it('delivered messages get mention records (routed through the normal send path)', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Scheduled ping @sched_draft_user2' }),
      });
      const draft = await createRes.json() as any;
      execSql(`UPDATE saved_drafts SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = '${draft.id}'`);

      await triggerScheduledDelivery();

      const mentionsRes = await authedFetch(token2, '/mentions');
      const mentions = await mentionsRes.json() as any;
      expect(mentions.messages.find((m: any) => m.content === 'Scheduled ping @sched_draft_user2')).toBeDefined();
    });

    it('does not deliver future-scheduled drafts', async () => {
      const createRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Future draft - do not deliver' }),
      });
      const draft = await createRes.json() as any;

      const futureTime = new Date(Date.now() + 86400_000).toISOString();
      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureTime }),
      });

      await triggerScheduledDelivery();

      // Draft should still exist
      const listRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const list = await listRes.json() as any;
      const found = list.find((d: any) => d.id === draft.id);
      expect(found).toBeDefined();
      expect(found.content).toBe('Future draft - do not deliver');
    });
  });
});
