import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql } from './helpers.js';

describe('DM Hide', () => {
  let token1: string;
  let token2: string;
  let user1Id: string;
  let user2Id: string;
  let dmId: string;

  beforeAll(async () => {
    const u1 = await createTestUser('dmhide_user1');
    const u2 = await createTestUser('dmhide_user2');
    user1Id = u1.id;
    user2Id = u2.id;
    const login1 = await loginUser('dmhide_user1');
    const login2 = await loginUser('dmhide_user2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // Create a DM between the two users
    const res = await authedFetch(token1, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: user2Id }),
    });
    const body = await res.json() as any;
    dmId = body.id;
  });

  describe('PATCH /dms/:id/hide', () => {
    it('hides a DM for the current user', async () => {
      const res = await authedFetch(token1, `/dms/${dmId}/hide`, { method: 'PATCH' });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it('hidden DM does not appear in DM list', async () => {
      // Hide first
      await authedFetch(token1, `/dms/${dmId}/hide`, { method: 'PATCH' });

      const res = await authedFetch(token1, '/dms');
      expect(res.status).toBe(200);
      const dms = await res.json() as any[];
      const found = dms.find((d: any) => d.id === dmId);
      expect(found).toBeUndefined();
    });

    it('hidden DM still appears for the other user', async () => {
      const res = await authedFetch(token2, '/dms');
      expect(res.status).toBe(200);
      const dms = await res.json() as any[];
      const found = dms.find((d: any) => d.id === dmId);
      expect(found).toBeDefined();
    });

    it('returns 404 for non-existent DM', async () => {
      const res = await authedFetch(token1, '/dms/nonexistent/hide', { method: 'PATCH' });
      expect(res.status).toBe(404);
    });

    it('returns 403 for DM user is not a member of', async () => {
      // Create a third user and a DM they're not part of
      await createTestUser('dmhide_user3');
      const login3 = await loginUser('dmhide_user3');
      const res = await authedFetch(login3.sessionToken, `/dms/${dmId}/hide`, { method: 'PATCH' });
      expect(res.status).toBe(403);
    });
  });

  describe('New message clears hidden_at', () => {
    it('DM resurfaces when a new message arrives', async () => {
      // Ensure hidden
      await authedFetch(token1, `/dms/${dmId}/hide`, { method: 'PATCH' });

      // Verify hidden
      let res = await authedFetch(token1, '/dms');
      let dms = await res.json() as any[];
      expect(dms.find((d: any) => d.id === dmId)).toBeUndefined();

      // Other user sends a message
      await authedFetch(token2, `/channels/${dmId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Hey there!' }),
      });

      // Now it should resurface for user1
      res = await authedFetch(token1, '/dms');
      dms = await res.json() as any[];
      const found = dms.find((d: any) => d.id === dmId);
      expect(found).toBeDefined();
    });
  });

  describe('Reopening (createOrGet existing) clears hidden_at', () => {
    it('hidden DM resurfaces when the same user POSTs /dms with the partner id', async () => {
      // Hide for user1
      await authedFetch(token1, `/dms/${dmId}/hide`, { method: 'PATCH' });

      // Verify hidden
      let res = await authedFetch(token1, '/dms');
      let list = await res.json() as any[];
      expect(list.find((d: any) => d.id === dmId)).toBeUndefined();

      // Reopen by POSTing to /dms with the partner id (NewDMModal / processes-nav flow)
      const reopen = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      expect(reopen.status).toBe(200);
      const dm = await reopen.json() as any;
      expect(dm.id).toBe(dmId);

      // Now it should be back in user1's DM list
      res = await authedFetch(token1, '/dms');
      list = await res.json() as any[];
      const found = list.find((d: any) => d.id === dmId);
      expect(found).toBeDefined();
    });

    it('reopening also clears left_at for the requester (legacy/CLI repair)', async () => {
      // Simulate a row where left_at got set somehow (legacy data, CLI
      // misuse, or pre-fix soft-leave endpoint hit on a DM). Without the
      // reopen-clears-left_at fix, this row would silently 403 on every send
      // even though the DM appears in the list.
      // execSql inlines literals against the local test D1 (no param binding).
      execSql(`UPDATE channel_members SET left_at = '2026-01-01T00:00:00.000Z', hidden_at = NULL WHERE channel_id = '${dmId}' AND user_id = '${user1Id}'`);

      // Reopen via createOrGet — should clear BOTH left_at and hidden_at
      const reopen = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      expect(reopen.status).toBe(200);

      // Now sends should succeed (left_at IS NULL passes the membership gate)
      const send = await authedFetch(token1, `/channels/${dmId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'left_at was cleared' }),
      });
      expect(send.status).toBe(201);
    });

    it('reopening does not unhide for the OTHER user', async () => {
      // Hide for both users
      await authedFetch(token1, `/dms/${dmId}/hide`, { method: 'PATCH' });
      await authedFetch(token2, `/dms/${dmId}/hide`, { method: 'PATCH' });

      // Confirm both hidden
      const r1Hidden = await (await authedFetch(token1, '/dms')).json() as any[];
      const r2Hidden = await (await authedFetch(token2, '/dms')).json() as any[];
      expect(r1Hidden.find((d: any) => d.id === dmId)).toBeUndefined();
      expect(r2Hidden.find((d: any) => d.id === dmId)).toBeUndefined();

      // user1 reopens via createOrGet
      await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });

      // user1 sees it
      const r1After = await (await authedFetch(token1, '/dms')).json() as any[];
      expect(r1After.find((d: any) => d.id === dmId)).toBeDefined();

      // user2 should still NOT see it (they hadn't reopened)
      const r2After = await (await authedFetch(token2, '/dms')).json() as any[];
      expect(r2After.find((d: any) => d.id === dmId)).toBeUndefined();
    });
  });

  describe('Soft-leave on a DM is rejected', () => {
    it('DELETE /channels/:id/membership returns 400 for a DM channel', async () => {
      const res = await authedFetch(token1, `/channels/${dmId}/membership`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toMatch(/hide it instead/i);
    });
  });
});
