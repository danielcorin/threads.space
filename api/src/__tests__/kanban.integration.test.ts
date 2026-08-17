import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, BASE_URL } from './helpers.js';

describe('Kanban Board', () => {
  let token1: string;
  let token2: string;
  let nonMemberToken: string;
  let user1Id: string;
  let user2Id: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('kanban_user1');
    await createTestUser('kanban_user2');
    await createTestUser('kanban_outsider');
    const login1 = await loginUser('kanban_user1');
    const login2 = await loginUser('kanban_user2');
    const loginOutsider = await loginUser('kanban_outsider');
    token1 = login1.sessionToken;
    token2 = login2.sessionToken;
    nonMemberToken = loginOutsider.sessionToken;
    user1Id = login1.user.id;
    user2Id = login2.user.id;

    // Create a channel and add user2 as member
    const chRes = await authedFetch(token1, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'kanban-test-channel' }),
    });
    const ch = await chRes.json() as any;
    channelId = ch.id;

    await authedFetch(token1, `/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: user2Id }),
    });
  });

  describe('Board CRUD', () => {
    it('returns 401 for unauthenticated request', async () => {
      const res = await fetch(`${BASE_URL}/channels/${channelId}/board`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-member GET', async () => {
      const res = await authedFetch(nonMemberToken, `/channels/${channelId}/board`);
      expect(res.status).toBe(403);
    });

    it('returns 404 when board does not exist (GET)', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`);
      expect(res.status).toBe(404);
    });

    it('creates a board for the channel', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`, {
        method: 'POST',
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.channel_id).toBe(channelId);
      expect(body.columns).toBe('["todo","in-progress","review","done"]');
      expect(body.created_by).toBe(user1Id);
    });

    it('returns 409 when board already exists', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`, {
        method: 'POST',
      });
      expect(res.status).toBe(409);
    });

    it('gets the board with empty cards', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.board.channel_id).toBe(channelId);
      expect(body.cards).toEqual([]);
    });

    it('returns 403 for non-member POST', async () => {
      const res = await authedFetch(nonMemberToken, `/channels/${channelId}/board`, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
    });

    it('updates board columns', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`, {
        method: 'PUT',
        body: JSON.stringify({ columns: ['backlog', 'todo', 'in-progress', 'done'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.columns).toBe('["backlog","todo","in-progress","done"]');
    });
  });

  describe('Card CRUD', () => {
    let cardId: string;
    let card2Id: string;

    it('creates a card', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board/cards`, {
        method: 'POST',
        body: JSON.stringify({
          title: 'First task',
          description: 'Do the thing',
          priority: 'high',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.title).toBe('First task');
      expect(body.description).toBe('Do the thing');
      expect(body.column_key).toBe('todo');
      expect(body.priority).toBe('high');
      expect(body.position).toBe(1000);
      expect(body.created_by).toBe(user1Id);
      cardId = body.id;
    });

    it('creates a second card with higher position', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board/cards`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Second task' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.position).toBe(2000);
      card2Id = body.id;
    });

    it('returns 403 for non-member creating card', async () => {
      const res = await authedFetch(nonMemberToken, `/channels/${channelId}/board/cards`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Nope' }),
      });
      expect(res.status).toBe(403);
    });

    it('requires title when creating card', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board/cards`, {
        method: 'POST',
        body: JSON.stringify({ description: 'no title' }),
      });
      expect(res.status).toBe(400);
    });

    it('gets board with cards', async () => {
      const res = await authedFetch(token1, `/channels/${channelId}/board`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.cards.length).toBe(2);
    });

    it('updates a card title', async () => {
      const res = await authedFetch(token1, `/boards/cards/${cardId}`, {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated task' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.title).toBe('Updated task');
    });

    it('moves a card to a different column and logs activity', async () => {
      const res = await authedFetch(token1, `/boards/cards/${cardId}`, {
        method: 'PUT',
        body: JSON.stringify({ column_key: 'in-progress' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.column_key).toBe('in-progress');

      // Check activity was logged
      const actRes = await authedFetch(token1, `/boards/cards/${cardId}/activity`);
      expect(actRes.status).toBe(200);
      const activity = await actRes.json() as any;
      const moveEntry = activity.find((a: any) => a.action === 'moved');
      expect(moveEntry).toBeDefined();
      expect(moveEntry.from_value).toBe('todo');
      expect(moveEntry.to_value).toBe('in-progress');
    });

    it('assigns a card and logs activity', async () => {
      const res = await authedFetch(token2, `/boards/cards/${cardId}`, {
        method: 'PUT',
        body: JSON.stringify({ assignee: user2Id }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.assignee).toBe(user2Id);

      const actRes = await authedFetch(token1, `/boards/cards/${cardId}/activity`);
      const activity = await actRes.json() as any;
      const assignEntry = activity.find((a: any) => a.action === 'assigned');
      expect(assignEntry).toBeDefined();
      expect(assignEntry.to_value).toBe(user2Id);
    });

    it('updates card position', async () => {
      const res = await authedFetch(token1, `/boards/cards/${cardId}`, {
        method: 'PUT',
        body: JSON.stringify({ position: 1500 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.position).toBe(1500);
    });

    it('returns 404 for non-existent card', async () => {
      const res = await authedFetch(token1, '/boards/cards/nonexistent', {
        method: 'PUT',
        body: JSON.stringify({ title: 'nope' }),
      });
      expect(res.status).toBe(404);
    });

    it('deletes a card', async () => {
      const res = await authedFetch(token1, `/boards/cards/${card2Id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify it's gone
      const boardRes = await authedFetch(token1, `/channels/${channelId}/board`);
      const board = await boardRes.json() as any;
      expect(board.cards.length).toBe(1);
    });

    it('returns 404 deleting non-existent card', async () => {
      const res = await authedFetch(token1, '/boards/cards/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Activity', () => {
    it('has created activity entry for card', async () => {
      // Create a fresh card to test creation activity
      const cardRes = await authedFetch(token1, `/channels/${channelId}/board/cards`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Activity test card' }),
      });
      const card = await cardRes.json() as any;

      const res = await authedFetch(token1, `/boards/cards/${card.id}/activity`);
      expect(res.status).toBe(200);
      const activity = await res.json() as any;
      expect(activity.length).toBeGreaterThanOrEqual(1);
      const created = activity.find((a: any) => a.action === 'created');
      expect(created).toBeDefined();
      expect(created.user_id).toBe(user1Id);
    });
  });
});
