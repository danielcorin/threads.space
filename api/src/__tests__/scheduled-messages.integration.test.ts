import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql, querySql, triggerScheduledDelivery } from './helpers.js';

describe('Scheduled Messages', () => {
  let token1: string;
  let token2: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('sched_msg_user1');
    await createTestUser('sched_msg_user2');
    const login1 = await loginUser('sched_msg_user1');
    const login2 = await loginUser('sched_msg_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    const chRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'sched-msg-test-chan' }),
    });
    channelId = (await chRes.json() as any).id;

    await authedFetch(token2, `/channels/${channelId}/join`, { method: 'POST' });
  });

  async function createDraft(token: string, content: string): Promise<any> {
    const res = await authedFetch(token, `/channels/${channelId}/saved-drafts`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    return res.json();
  }

  describe('PATCH /saved-drafts/:id/schedule', () => {
    it('schedules a draft with a future datetime', async () => {
      const draft = await createDraft(token1, 'schedule me');
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureDate }),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.scheduled_at).toBe(futureDate);
      expect(body.id).toBe(draft.id);
      expect(body.content).toBe('schedule me');
    });

    it('unschedules a draft by setting scheduled_at to null', async () => {
      const draft = await createDraft(token1, 'unschedule me');
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureDate }),
      });

      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: null }),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.scheduled_at).toBeNull();
    });

    it('rejects a past datetime', async () => {
      const draft = await createDraft(token1, 'past draft');
      const pastDate = new Date(Date.now() - 3600000).toISOString();

      const res = await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: pastDate }),
      });
      expect(res.status).toBe(400);

      const body = await res.json() as any;
      expect(body.error).toContain('future');
    });

    it('rejects scheduling someone else\'s draft', async () => {
      const draft = await createDraft(token1, 'not yours');
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      const res = await authedFetch(token2, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureDate }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent draft', async () => {
      const res = await authedFetch(token1, `/saved-drafts/nonexistent123/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: new Date(Date.now() + 3600000).toISOString() }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('listing includes scheduled_at', () => {
    it('list returns scheduled_at field', async () => {
      const draft = await createDraft(token1, 'listed draft');
      const futureDate = new Date(Date.now() + 7200000).toISOString();

      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureDate }),
      });

      const res = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const drafts = await res.json() as any[];
      const found = drafts.find((d: any) => d.id === draft.id);
      expect(found).toBeDefined();
      expect(found.scheduled_at).toBe(futureDate);
    });
  });

  describe('cron delivery', () => {
    it('delivers due scheduled messages via cron trigger', async () => {
      const draft = await createDraft(token1, 'deliver this message');

      // Schedule it in the future first (API requires future date)
      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: new Date(Date.now() + 60000).toISOString() }),
      });

      // Use admin SQL to backdate the scheduled_at so cron picks it up
      const pastDate = new Date(Date.now() - 60000).toISOString();
      execSql(`UPDATE saved_drafts SET scheduled_at = '${pastDate}' WHERE id = '${draft.id}'`);

      // Verify the update took effect
      const rows = querySql(`SELECT id, scheduled_at FROM saved_drafts WHERE id = '${draft.id}'`);
      expect(rows[0]?.scheduled_at).toBe(pastDate);

      // Trigger the cron
      await triggerScheduledDelivery();

      // Small delay to allow cron handler to complete
      await new Promise(r => setTimeout(r, 500));

      // Verify message was created in the channel
      const messagesRes = await authedFetch(token1, `/channels/${channelId}/messages`);
      const messagesBody = await messagesRes.json() as any;
      const delivered = messagesBody.messages.find((m: any) => m.content === 'deliver this message');
      expect(delivered).toBeDefined();
      expect(delivered.userId || delivered.user_id).toBeTruthy();

      // Verify draft was deleted
      const draftsRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const draftsBody = await draftsRes.json() as any[];
      const found = draftsBody.find((d: any) => d.id === draft.id);
      expect(found).toBeUndefined();
    });

    it('cron skips future scheduled drafts', async () => {
      const draft = await createDraft(token1, 'future draft stays');
      const futureDate = new Date(Date.now() + 3600000).toISOString();

      await authedFetch(token1, `/saved-drafts/${draft.id}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduled_at: futureDate }),
      });

      // Trigger cron
      await triggerScheduledDelivery();

      // Draft should still exist
      const draftsRes = await authedFetch(token1, `/channels/${channelId}/saved-drafts`);
      const draftsBody = await draftsRes.json() as any[];
      const found = draftsBody.find((d: any) => d.id === draft.id);
      expect(found).toBeDefined();
      expect(found.scheduled_at).toBe(futureDate);
    });
  });
});
