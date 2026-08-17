import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Folders', () => {
  let token: string;
  let channelId1: string;
  let channelId2: string;
  let _channelId3: string;

  beforeAll(async () => {
    await createTestUser('folder_user1');
    const login = await loginUser('folder_user1');
    token = login.sessionToken;

    // Create test channels
    const ch1 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'folder-test-ch1' }),
    });
    channelId1 = ((await ch1.json()) as any).id;

    const ch2 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'folder-test-ch2' }),
    });
    channelId2 = ((await ch2.json()) as any).id;

    const ch3 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'folder-test-ch3' }),
    });
    _channelId3 = ((await ch3.json()) as any).id;
  });

  describe('POST /folders', () => {
    it('creates a folder and returns 201', async () => {
      const res = await authedFetch(token, '/folders', {
        method: 'POST',
        body: JSON.stringify({ name: 'Work' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Work');
      expect(body.position).toBe(0);
      expect(body.collapsed).toBe(0);
      expect(body.channels).toEqual([]);
    });

    it('creates a second folder with position 1', async () => {
      const res = await authedFetch(token, '/folders', {
        method: 'POST',
        body: JSON.stringify({ name: 'Personal' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.position).toBe(1);
    });

    it('returns error for missing name', async () => {
      const res = await authedFetch(token, '/folders', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /folders', () => {
    it('lists folders ordered by position', async () => {
      const res = await authedFetch(token, '/folders');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body.length).toBe(2);
      expect(body[0].name).toBe('Work');
      expect(body[1].name).toBe('Personal');
    });
  });

  describe('POST /folders/:id/channels', () => {
    it('adds a channel to a folder', async () => {
      const listRes = await authedFetch(token, '/folders');
      const folders = (await listRes.json()) as any[];
      const workFolder = folders.find((f: any) => f.name === 'Work');

      const res = await authedFetch(token, `/folders/${workFolder.id}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: channelId1 }),
      });
      expect(res.status).toBe(201);

      // Add second channel
      await authedFetch(token, `/folders/${workFolder.id}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: channelId2 }),
      });

      // Verify folder now has channels
      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      const work = updated.find((f: any) => f.name === 'Work');
      expect(work.channels).toContain(channelId1);
      expect(work.channels).toContain(channelId2);
    });

    it('moves channel between folders', async () => {
      const listRes = await authedFetch(token, '/folders');
      const folders = (await listRes.json()) as any[];
      const personalFolder = folders.find((f: any) => f.name === 'Personal');

      // Move channelId1 from Work to Personal
      const res = await authedFetch(token, `/folders/${personalFolder.id}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: channelId1 }),
      });
      expect(res.status).toBe(201);

      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      const work = updated.find((f: any) => f.name === 'Work');
      const personal = updated.find((f: any) => f.name === 'Personal');

      expect(work.channels).not.toContain(channelId1);
      expect(personal.channels).toContain(channelId1);
    });

    it('returns 404 for non-existent folder', async () => {
      const res = await authedFetch(token, '/folders/nonexistent/channels', {
        method: 'POST',
        body: JSON.stringify({ channelId: channelId1 }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /folders/:id', () => {
    it('renames a folder', async () => {
      const listRes = await authedFetch(token, '/folders');
      const folders = (await listRes.json()) as any[];
      const workFolder = folders.find((f: any) => f.name === 'Work');

      const res = await authedFetch(token, `/folders/${workFolder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Work Projects' }),
      });
      expect(res.status).toBe(200);

      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      expect(updated.find((f: any) => f.id === workFolder.id)?.name).toBe('Work Projects');
    });

    it('toggles collapsed state', async () => {
      const listRes = await authedFetch(token, '/folders');
      const folders = (await listRes.json()) as any[];
      const folder = folders[0];

      const res = await authedFetch(token, `/folders/${folder.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ collapsed: 1 }),
      });
      expect(res.status).toBe(200);

      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      expect(updated.find((f: any) => f.id === folder.id)?.collapsed).toBe(1);
    });

    it('returns 404 for non-existent folder', async () => {
      const res = await authedFetch(token, '/folders/nonexistent', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Nope' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /folders/:id/channels/:channelId', () => {
    it('removes a channel from a folder', async () => {
      const listRes = await authedFetch(token, '/folders');
      const folders = (await listRes.json()) as any[];
      const personal = folders.find((f: any) => f.name === 'Personal');

      const res = await authedFetch(token, `/folders/${personal.id}/channels/${channelId1}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      const updatedPersonal = updated.find((f: any) => f.name === 'Personal');
      expect(updatedPersonal.channels).not.toContain(channelId1);
    });
  });

  describe('PUT /folders/reorder', () => {
    it('reorders folders and items', async () => {
      const listRes = await authedFetch(token, '/folders');
      const foldersList = (await listRes.json()) as any[];

      // Swap folder positions
      const reorderData = {
        folders: foldersList.map((f: any, i: number) => ({
          id: f.id,
          position: foldersList.length - 1 - i,
        })),
      };

      const res = await authedFetch(token, '/folders/reorder', {
        method: 'PUT',
        body: JSON.stringify(reorderData),
      });
      expect(res.status).toBe(200);

      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      expect(updated[0].name).toBe('Personal');
    });
  });

  describe('DELETE /folders/:id', () => {
    it('deletes a folder without deleting channels', async () => {
      const listRes = await authedFetch(token, '/folders');
      const foldersList = (await listRes.json()) as any[];
      const workFolder = foldersList.find((f: any) => f.name === 'Work Projects');

      const res = await authedFetch(token, `/folders/${workFolder.id}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Folder should be gone
      const updatedRes = await authedFetch(token, '/folders');
      const updated = (await updatedRes.json()) as any[];
      expect(updated.find((f: any) => f.id === workFolder.id)).toBeUndefined();

      // Channels should still exist
      const channelsRes = await authedFetch(token, '/channels');
      expect(channelsRes.status).toBe(200);
      const channelsList = (await channelsRes.json()) as any[];
      expect(channelsList.some((c: any) => c.id === channelId2)).toBe(true);
    });

    it('returns 404 for non-existent folder', async () => {
      const res = await authedFetch(token, '/folders/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('per-user isolation', () => {
    it('folders are not visible to other users', async () => {
      await createTestUser('folder_user2');
      const login2 = await loginUser('folder_user2');

      const res = await authedFetch(login2.sessionToken, '/folders');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body.length).toBe(0);
    });
  });

  // Regression: channel_folder_items.channel_id is a foreign key, and the
  // handler never checked the channel before inserting — so an unresolvable id
  // failed with a D1 FOREIGN KEY error and surfaced as a 500.
  describe('POST /folders/:id/channels validation', () => {
    let folderId: string;

    beforeAll(async () => {
      const res = await authedFetch(token, '/folders', {
        method: 'POST',
        body: JSON.stringify({ name: 'folder-validation' }),
      });
      folderId = ((await res.json()) as any).id;
    });

    it('returns 404 for a channel that does not exist', async () => {
      const res = await authedFetch(token, `/folders/${folderId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: 'no-such-channel-id' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for a channel the caller is not a member of', async () => {
      await createTestUser('folder_outsider');
      const outsider = await loginUser('folder_outsider');
      const theirChannel = await authedFetch(outsider.sessionToken, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'folder-outsider-channel' }),
      });
      const theirChannelId = ((await theirChannel.json()) as any).id;

      // Same 404 as a missing channel: a distinct status would confirm the
      // channel exists to someone who cannot see it.
      const res = await authedFetch(token, `/folders/${folderId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: theirChannelId }),
      });
      expect(res.status).toBe(404);
    });
  });
});
