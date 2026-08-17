import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('DM reorder', () => {
  let token1: string;
  let token2: string;
  let _user1Id: string;
  let user2Id: string;
  let user3Id: string;
  let user4Id: string;
  let dmA: string;
  let dmB: string;
  let dmC: string;

  beforeAll(async () => {
    const u1 = await createTestUser('dmreorder_u1');
    const u2 = await createTestUser('dmreorder_u2');
    const u3 = await createTestUser('dmreorder_u3');
    const u4 = await createTestUser('dmreorder_u4');
    _user1Id = u1.id;
    user2Id = u2.id;
    user3Id = u3.id;
    user4Id = u4.id;

    const login1 = await loginUser('dmreorder_u1');
    const login2 = await loginUser('dmreorder_u2');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;

    // u1 opens DMs with u2, u3, u4
    const a = await authedFetch(token1, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: user2Id }),
    });
    dmA = ((await a.json()) as any).id;

    const b = await authedFetch(token1, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: user3Id }),
    });
    dmB = ((await b.json()) as any).id;

    const c = await authedFetch(token1, '/dms', {
      method: 'POST',
      body: JSON.stringify({ userId: user4Id }),
    });
    dmC = ((await c.json()) as any).id;
  });

  it('reorders DMs via PUT /dms/reorder', async () => {
    const res = await authedFetch(token1, '/dms/reorder', {
      method: 'PUT',
      body: JSON.stringify({
        items: [
          { id: dmC, position: 0 },
          { id: dmA, position: 1 },
          { id: dmB, position: 2 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);

    const listRes = await authedFetch(token1, '/dms');
    const list = (await listRes.json()) as any[];
    // Only the three we created (partner IDs should line up)
    const ids = list.map((d) => d.id);
    expect(ids.slice(0, 3)).toEqual([dmC, dmA, dmB]);
    expect(list.find((d) => d.id === dmC).position).toBe(0);
    expect(list.find((d) => d.id === dmA).position).toBe(1);
    expect(list.find((d) => d.id === dmB).position).toBe(2);
  });

  it('per-user position — u2 order is independent of u1 order', async () => {
    // u1 set a specific order above. u2 should still see position NULL on their side.
    const listRes = await authedFetch(token2, '/dms');
    const list = (await listRes.json()) as any[];
    const theirs = list.find((d) => d.id === dmA);
    expect(theirs).toBeDefined();
    expect(theirs.position).toBeNull();
  });

  it('rejects reorder of a DM the user is not a member of', async () => {
    // u2 tries to reorder dmB (which is between u1 and u3)
    const res = await authedFetch(token2, '/dms/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: [{ id: dmB, position: 0 }] }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects empty items array', async () => {
    const res = await authedFetch(token1, '/dms/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects negative positions', async () => {
    const res = await authedFetch(token1, '/dms/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: [{ id: dmA, position: -1 }] }),
    });
    expect(res.status).toBe(400);
  });
});
