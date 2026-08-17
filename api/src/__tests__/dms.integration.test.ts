import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql } from './helpers.js';

describe('DMs', () => {
  let token1: string;
  let token2: string;
  let _token3: string;
  let user1Id: string;
  let user2Id: string;
  let user3Id: string;

  beforeAll(async () => {
    const u1 = await createTestUser('dm_user1');
    const u2 = await createTestUser('dm_user2');
    const u3 = await createTestUser('dm_user3');
    user1Id = u1.id;
    user2Id = u2.id;
    user3Id = u3.id;
    const login1 = await loginUser('dm_user1');
    const login2 = await loginUser('dm_user2');
    const login3 = await loginUser('dm_user3');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    _token3 = login3.sessionToken;
  });

  describe('POST /dms - create or get DM', () => {
    it('creates a DM channel between two users', async () => {
      const res = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      expect(res.status).toBe(201);

      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.is_dm).toBe(1);
      expect(body.partner).toBeDefined();
      expect(body.partner.id).toBe(user2Id);
      expect(body.partner.username).toBe('dm_user2');
    });

    it('returns the same DM channel on second call (idempotent)', async () => {
      // First call to get the existing DM
      const res1 = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user2Id }),
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json() as any;

      // Second call from the other user
      const res2 = await authedFetch(token2, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user1Id }),
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json() as any;

      // Both should return the same channel
      expect(body1.id).toBe(body2.id);
    });

    it('cannot create a DM with yourself', async () => {
      const res = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user1Id }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain('Cannot DM yourself');
    });

    it('returns 404 for non-existent target user', async () => {
      const res = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: 'nonexistent-user-id' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toContain('User not found');
    });

    it('returns 400 when userId is missing', async () => {
      const res = await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('recovers from a creation race (UNIQUE collision returns the winner)', async () => {
      // Simulate the loser of a concurrent create: the channels row for this
      // pair already exists (winner committed first) but the existing-DM
      // lookup missed it. The deterministic dm-<ids> name collides on UNIQUE.
      const [id1, id2] = [user2Id, user3Id].sort();
      const name = `dm-${id1}-${id2}`;
      execSql(`INSERT INTO channels (id, name, description, is_private, is_dm, created_by) VALUES ('race-dm-winner', '${name}', NULL, 1, 1, '${user2Id}')`);

      const res = await authedFetch(token2, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user3Id }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe('race-dm-winner');
      expect(body.partner.id).toBe(user3Id);
    });
  });

  describe('GET /dms - list DMs', () => {
    beforeAll(async () => {
      // Ensure a DM exists between user1 and user3
      await authedFetch(token1, '/dms', {
        method: 'POST',
        body: JSON.stringify({ userId: user3Id }),
      });
    });

    it('DM channel appears in DM list for the creator', async () => {
      const res = await authedFetch(token1, '/dms');
      expect(res.status).toBe(200);
      const dms = await res.json() as any[];

      // user1 has DMs with user2 and user3
      expect(dms.length).toBeGreaterThanOrEqual(2);
      const partnerUsernames = dms.map((dm: any) => dm.partner.username);
      expect(partnerUsernames).toContain('dm_user2');
      expect(partnerUsernames).toContain('dm_user3');
    });

    it('DM channel appears in DM list for the other participant', async () => {
      const res = await authedFetch(token2, '/dms');
      expect(res.status).toBe(200);
      const dms = await res.json() as any[];

      const partnerUsernames = dms.map((dm: any) => dm.partner.username);
      expect(partnerUsernames).toContain('dm_user1');
    });

    it('DM list includes partner info with username', async () => {
      const res = await authedFetch(token1, '/dms');
      const dms = await res.json() as any[];
      const dm = dms.find((d: any) => d.partner.username === 'dm_user2');

      expect(dm.partner.id).toBe(user2Id);
      expect(dm.partner.username).toBe('dm_user2');
      expect(dm).toHaveProperty('has_unread');
      expect(dm).toHaveProperty('unread_count');
    });

    it('DMs do not appear in regular channel list', async () => {
      const res = await authedFetch(token1, '/channels');
      const channels = await res.json() as any[];
      const dmChannels = channels.filter((c: any) => c.is_dm === 1);
      expect(dmChannels.length).toBe(0);
    });
  });
});
