import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

describe('Folder reorder and drag-and-drop', () => {
  let token: string;
  let channelId1: string;
  let channelId2: string;
  let channelId3: string;
  let folderAId: string;
  let folderBId: string;

  beforeAll(async () => {
    await createTestUser('reorder_user1');
    const login = await loginUser('reorder_user1');
    token = login.sessionToken;

    // Create test channels
    const ch1 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'reorder-ch1' }),
    });
    channelId1 = ((await ch1.json()) as any).id;

    const ch2 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'reorder-ch2' }),
    });
    channelId2 = ((await ch2.json()) as any).id;

    const ch3 = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'reorder-ch3' }),
    });
    channelId3 = ((await ch3.json()) as any).id;

    // Create two folders
    const fA = await authedFetch(token, '/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'Folder A' }),
    });
    folderAId = ((await fA.json()) as any).id;

    const fB = await authedFetch(token, '/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'Folder B' }),
    });
    folderBId = ((await fB.json()) as any).id;

    // Add channels to Folder A
    await authedFetch(token, `/folders/${folderAId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ channelId: channelId1, position: 0 }),
    });
    await authedFetch(token, `/folders/${folderAId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ channelId: channelId2, position: 1 }),
    });
    await authedFetch(token, `/folders/${folderAId}/channels`, {
      method: 'POST',
      body: JSON.stringify({ channelId: channelId3, position: 2 }),
    });
  });

  describe('reorder channels within a folder', () => {
    it('reorders channels via PUT /folders/reorder with items', async () => {
      // Reverse the order of channels in Folder A: ch3, ch2, ch1
      const res = await authedFetch(token, '/folders/reorder', {
        method: 'PUT',
        body: JSON.stringify({
          items: [
            { folderId: folderAId, channelId: channelId3, position: 0 },
            { folderId: folderAId, channelId: channelId2, position: 1 },
            { folderId: folderAId, channelId: channelId1, position: 2 },
          ],
        }),
      });
      expect(res.status).toBe(200);

      // Verify new order
      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];
      const folderA = folders.find((f: any) => f.id === folderAId);
      expect(folderA.channels).toEqual([channelId3, channelId2, channelId1]);
    });
  });

  describe('move channel between folders', () => {
    it('moves a channel from Folder A to Folder B', async () => {
      // Move ch2 from Folder A to Folder B at position 0
      const res = await authedFetch(token, `/folders/${folderBId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ channelId: channelId2 }),
      });
      expect(res.status).toBe(201);

      // Verify Folder A no longer has ch2 and Folder B has it
      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];
      const folderA = folders.find((f: any) => f.id === folderAId);
      const folderB = folders.find((f: any) => f.id === folderBId);

      expect(folderA.channels).not.toContain(channelId2);
      expect(folderB.channels).toContain(channelId2);
    });

    it('moves a channel via reorder endpoint to change folder', async () => {
      // Move ch1 from Folder A to Folder B using the reorder endpoint
      const res = await authedFetch(token, '/folders/reorder', {
        method: 'PUT',
        body: JSON.stringify({
          items: [
            { folderId: folderBId, channelId: channelId1, position: 0 },
            { folderId: folderBId, channelId: channelId2, position: 1 },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];
      const folderA = folders.find((f: any) => f.id === folderAId);
      const folderB = folders.find((f: any) => f.id === folderBId);

      expect(folderA.channels).not.toContain(channelId1);
      expect(folderB.channels).toContain(channelId1);
      expect(folderB.channels).toContain(channelId2);
    });
  });

  describe('move channel to unfiled (remove from folder)', () => {
    it('removes a channel from a folder', async () => {
      // ch3 is still in Folder A
      const res = await authedFetch(token, `/folders/${folderAId}/channels/${channelId3}`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);

      // Verify ch3 is no longer in any folder
      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];
      for (const folder of folders) {
        expect(folder.channels).not.toContain(channelId3);
      }

      // Channel itself still exists
      const channelRes = await authedFetch(token, `/channels/${channelId3}`);
      expect(channelRes.status).toBe(200);
    });
  });

  describe('reorder folders themselves', () => {
    it('swaps folder positions', async () => {
      // Folder A is position 0, Folder B is position 1 -- swap them
      const res = await authedFetch(token, '/folders/reorder', {
        method: 'PUT',
        body: JSON.stringify({
          folders: [
            { id: folderAId, position: 1 },
            { id: folderBId, position: 0 },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];
      // Folders should be returned ordered by position, so Folder B first
      expect(folders[0].id).toBe(folderBId);
      expect(folders[1].id).toBe(folderAId);
    });
  });

  describe('combined folder and item reorder', () => {
    it('reorders folders and items in a single call', async () => {
      const res = await authedFetch(token, '/folders/reorder', {
        method: 'PUT',
        body: JSON.stringify({
          folders: [
            { id: folderAId, position: 0 },
            { id: folderBId, position: 1 },
          ],
          items: [
            { folderId: folderBId, channelId: channelId1, position: 1 },
            { folderId: folderBId, channelId: channelId2, position: 0 },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const foldersRes = await authedFetch(token, '/folders');
      const folders = (await foldersRes.json()) as any[];

      // Folder A should be first again
      expect(folders[0].id).toBe(folderAId);
      expect(folders[1].id).toBe(folderBId);

      // In Folder B, ch2 should be before ch1
      const folderB = folders.find((f: any) => f.id === folderBId);
      expect(folderB.channels[0]).toBe(channelId2);
      expect(folderB.channels[1]).toBe(channelId1);
    });
  });
});
