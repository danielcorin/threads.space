import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, BASE_URL } from './helpers.js';

describe('File Uploads', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('upload_user');
    const login = await loginUser('upload_user');
    token = login.sessionToken;

    const chanRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'upload-test-channel' }),
    });
    const chan = await chanRes.json() as any;
    channelId = chan.id;
  });

  describe('POST /uploads', () => {
    it('uploads a file and returns attachment metadata', async () => {
      const fileContent = 'hello world';
      const formData = new FormData();
      formData.append('file', new Blob([fileContent], { type: 'text/plain' }), 'test.txt');

      const res = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.filename).toBe('test.txt');
      expect(body.contentType).toBe('text/plain');
      expect(body.sizeBytes).toBe(fileContent.length);
      expect(body.url).toContain('/uploads/');
    });

    it('rejects upload without file', async () => {
      const formData = new FormData();
      const res = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated upload', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['data'], { type: 'text/plain' }), 'test.txt');

      const res = await fetch(`${BASE_URL}/uploads`, {
        method: 'POST',
        body: formData,
      });
      expect(res.status).toBe(401);
    });

    it('rejects files exceeding 25 MB size limit', async () => {
      // Create a blob just over 25 MB (25 * 1024 * 1024 + 1 bytes)
      const oversize = new Uint8Array(25 * 1024 * 1024 + 1);
      const formData = new FormData();
      formData.append('file', new Blob([oversize], { type: 'application/octet-stream' }), 'large.bin');

      const res = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      expect(res.status).toBe(413);
      const body = await res.json() as any;
      expect(body.error).toContain('too large');
    });
  });

  describe('GET /uploads/:key', () => {
    it('serves an uploaded file', async () => {
      const fileContent = 'serve me';
      const formData = new FormData();
      formData.append('file', new Blob([fileContent], { type: 'text/plain' }), 'serve.txt');

      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      // Fetch the file back (auth required)
      const res = await authedFetch(token, uploaded.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain');
      const text = await res.text();
      expect(text).toBe(fileContent);
    });

    it('rejects unauthenticated file access', async () => {
      const fileContent = 'secret file';
      const formData = new FormData();
      formData.append('file', new Blob([fileContent], { type: 'text/plain' }), 'secret.txt');

      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      // Fetch without auth should fail
      const res = await fetch(`${BASE_URL}${uploaded.url}`);
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent file', async () => {
      const res = await authedFetch(token, '/uploads/nonexistent-key');
      expect(res.status).toBe(404);
    });

    it('hides another user\'s unattached upload', async () => {
      await createTestUser('upload_user2');
      const login2 = await loginUser('upload_user2');
      const token2 = login2.sessionToken;

      const formData = new FormData();
      formData.append('file', new Blob(['draft only'], { type: 'text/plain' }), 'draft.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      const res = await authedFetch(token2, uploaded.url);
      expect(res.status).toBe(404);
    });

    it('scopes attached uploads to channel members', async () => {
      await createTestUser('upload_user3');
      const login3 = await loginUser('upload_user3');
      const token3 = login3.sessionToken;

      const formData = new FormData();
      formData.append('file', new Blob(['channel scoped'], { type: 'text/plain' }), 'scoped.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'scoped attachment', attachmentIds: [uploaded.id] }),
      });

      // Non-member is denied
      const denied = await authedFetch(token3, uploaded.url);
      expect(denied.status).toBe(403);

      // After joining, access works
      await authedFetch(token3, `/channels/${channelId}/join`, { method: 'POST' });
      const allowed = await authedFetch(token3, uploaded.url);
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe('channel scoped');
    });
  });

  describe('Messages with attachments', () => {
    it('sends a message with attachment IDs', async () => {
      // Upload a file
      const formData = new FormData();
      formData.append('file', new Blob(['attached'], { type: 'text/plain' }), 'doc.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      // Send message with attachment
      const res = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: 'Check this file',
          attachmentIds: [uploaded.id],
        }),
      });
      expect(res.status).toBe(201);
      const msg = await res.json() as any;
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].id).toBe(uploaded.id);
      expect(msg.attachments[0].filename).toBe('doc.txt');
      expect(msg.attachments[0].url).toContain('/uploads/');
    });

    it('includes attachments when listing messages', async () => {
      // Upload a file
      const formData = new FormData();
      formData.append('file', new Blob(['list-test'], { type: 'text/plain' }), 'list.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      // Send message with attachment
      await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: 'With attachment',
          attachmentIds: [uploaded.id],
        }),
      });

      // List messages
      const listRes = await authedFetch(token, `/channels/${channelId}/messages`);
      const body = await listRes.json() as any;
      const msg = body.messages.find((m: any) => m.content === 'With attachment');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].filename).toBe('list.txt');
    });

    it('cannot attach another user\'s upload', async () => {
      await createTestUser('upload_thief');
      const loginT = await loginUser('upload_thief');
      const tokenT = loginT.sessionToken;
      await authedFetch(tokenT, `/channels/${channelId}/join`, { method: 'POST' });

      const formData = new FormData();
      formData.append('file', new Blob(['not yours'], { type: 'text/plain' }), 'mine.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      const res = await authedFetch(tokenT, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'stealing', attachmentIds: [uploaded.id] }),
      });
      expect(res.status).toBe(201);
      const msg = await res.json() as any;
      expect(msg.attachments).toHaveLength(0);
    });

    it('a retry cannot re-home an attachment from the first copy', async () => {
      const formData = new FormData();
      formData.append('file', new Blob(['attach once'], { type: 'text/plain' }), 'once.txt');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      const res1 = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'first copy', attachmentIds: [uploaded.id] }),
      });
      const first = await res1.json() as any;
      expect(first.attachments).toHaveLength(1);

      // A duplicate send (no idempotency key) must not steal the attachment
      const res2 = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'second copy', attachmentIds: [uploaded.id] }),
      });
      const second = await res2.json() as any;
      expect(second.attachments).toHaveLength(0);

      // The attachment still belongs to the first message
      const getRes = await authedFetch(token, `/messages/${first.id}`);
      const fetched = await getRes.json() as any;
      expect(fetched.attachments).toHaveLength(1);
      expect(fetched.attachments[0].id).toBe(uploaded.id);
    });

    it('sends a message with only attachment and no text content', async () => {
      // Upload a file
      const formData = new FormData();
      formData.append('file', new Blob(['no-text'], { type: 'image/png' }), 'photo.png');
      const uploadRes = await authedFetch(token, '/uploads', { method: 'POST', body: formData });
      const uploaded = await uploadRes.json() as any;

      // Send message with attachment but empty content
      const res = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: '',
          attachmentIds: [uploaded.id],
        }),
      });
      expect(res.status).toBe(201);
      const msg = await res.json() as any;
      expect(msg.attachments).toHaveLength(1);
      expect(msg.content).toBe('');
    });
  });
});
