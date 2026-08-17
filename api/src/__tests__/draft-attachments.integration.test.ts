import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch } from './helpers.js';

/** Upload a small text file and return its attachment metadata. */
async function uploadFile(token: string, name: string, content: string = 'test') {
  const formData = new FormData();
  formData.append('file', new Blob([content], { type: 'text/plain' }), name);
  const res = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
  expect(res.status).toBe(201);
  return res.json() as any as Promise<{ id: string; filename: string; contentType: string; sizeBytes: number; url: string }>;
}

describe('Draft Attachments', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('dftatt_user');
    const login = await loginUser('dftatt_user');
    token = login.sessionToken;

    const chanRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'dftatt-chan' }),
    });
    channelId = (await chanRes.json() as any).id;
  });

  it('saves a draft with attachments and retrieves them', async () => {
    const file1 = await uploadFile(token, 'a.txt', 'aaa');
    const file2 = await uploadFile(token, 'b.txt', 'bbb');

    const putRes = await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'wip', attachment_ids: [file1.id, file2.id] }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await authedFetch(token, `/channels/${channelId}/draft`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as any;
    expect(body.content).toBe('wip');
    expect(body.attachments).toHaveLength(2);
    expect(body.attachments.map((a: any) => a.filename).sort()).toEqual(['a.txt', 'b.txt']);
    // Each attachment should have full metadata
    for (const att of body.attachments) {
      expect(att.id).toBeDefined();
      expect(att.contentType).toBe('text/plain');
      expect(att.sizeBytes).toBeGreaterThan(0);
      expect(att.url).toContain('/uploads/');
    }
  });

  it('returns empty attachments when no draft exists', async () => {
    // Use a different channel to avoid interference
    const chanRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'dftatt-empty' }),
    });
    const cid = (await chanRes.json() as any).id;

    const getRes = await authedFetch(token, `/channels/${cid}/draft`);
    const body = await getRes.json() as any;
    expect(body.content).toBe('');
    expect(body.attachments).toEqual([]);
  });

  it('clears attachments when saving empty draft', async () => {
    const file = await uploadFile(token, 'clear.txt');

    // Save draft with attachment
    await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'temp', attachment_ids: [file.id] }),
    });

    // Clear draft
    const clearRes = await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: '' }),
    });
    expect(clearRes.status).toBe(200);

    const getRes = await authedFetch(token, `/channels/${channelId}/draft`);
    const body = await getRes.json() as any;
    expect(body.content).toBe('');
    expect(body.attachments).toEqual([]);
  });

  it('replaces attachment list on update', async () => {
    const file1 = await uploadFile(token, 'first.txt');
    const file2 = await uploadFile(token, 'second.txt');

    // Save with file1
    await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'v1', attachment_ids: [file1.id] }),
    });

    // Update with file2 only
    await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'v2', attachment_ids: [file2.id] }),
    });

    const getRes = await authedFetch(token, `/channels/${channelId}/draft`);
    const body = await getRes.json() as any;
    expect(body.content).toBe('v2');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe('second.txt');
  });

  it('saves draft with only attachments and no text', async () => {
    const file = await uploadFile(token, 'notext.txt');

    const putRes = await authedFetch(token, `/channels/${channelId}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ content: '', attachment_ids: [file.id] }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await authedFetch(token, `/channels/${channelId}/draft`);
    const body = await getRes.json() as any;
    expect(body.content).toBe('');
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe('notext.txt');
  });

  describe('GET /drafts includes attachment-only drafts', () => {
    it('lists channel with attachment-only draft', async () => {
      // Create a fresh channel for this test
      const chanRes = await authedFetch(token, '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: 'dftatt-list' }),
      });
      const cid = (await chanRes.json() as any).id;

      const file = await uploadFile(token, 'list.txt');

      // Save attachment-only draft (no text)
      await authedFetch(token, `/channels/${cid}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content: '', attachment_ids: [file.id] }),
      });

      const listRes = await authedFetch(token, '/drafts');
      const body = await listRes.json() as any;
      expect(body.channel_ids).toContain(cid);
    });
  });
});
