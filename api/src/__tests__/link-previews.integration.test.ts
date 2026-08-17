import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, loginUser, authedFetch, execSql, BASE_URL } from './helpers.js';
import { extractUrls, parseOgTags, validateFetchUrl } from '../routes/link-previews.js';

describe('Link Previews', () => {
  let token: string;
  let channelId: string;

  beforeAll(async () => {
    await createTestUser('lp_user');
    const login = await loginUser('lp_user');
    token = login.sessionToken;

    const chanRes = await authedFetch(token, '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'link-preview-test-channel' }),
    });
    const chan = (await chanRes.json() as any) as any;
    channelId = chan.id;
  });

  describe('extractUrls', () => {
    it('extracts HTTP/HTTPS URLs from message content', () => {
      expect(extractUrls('Check out https://example.com')).toEqual(['https://example.com']);
      expect(extractUrls('Visit http://foo.bar/page')).toEqual(['http://foo.bar/page']);
    });

    it('extracts multiple URLs', () => {
      const urls = extractUrls('See https://a.com and https://b.com for details');
      expect(urls).toEqual(['https://a.com', 'https://b.com']);
    });

    it('ignores non-HTTP URLs', () => {
      expect(extractUrls('Contact ftp://files.example.com or mailto:a@b.com')).toEqual([]);
    });

    it('ignores URLs in code blocks', () => {
      expect(extractUrls('```\nhttps://example.com\n```')).toEqual([]);
      expect(extractUrls('Use `https://example.com` for info')).toEqual([]);
    });

    it('deduplicates URLs', () => {
      const urls = extractUrls('https://example.com and https://example.com again');
      expect(urls).toEqual(['https://example.com']);
    });

    it('strips trailing punctuation', () => {
      expect(extractUrls('See https://example.com.')).toEqual(['https://example.com']);
      expect(extractUrls('Is it https://example.com?')).toEqual(['https://example.com']);
    });

    it('returns empty array for no URLs', () => {
      expect(extractUrls('Just a normal message')).toEqual([]);
    });
  });

  describe('parseOgTags', () => {
    it('accepts https:// image URLs', () => {
      const html = '<meta property="og:title" content="Test"><meta property="og:image" content="https://example.com/img.png">';
      expect(parseOgTags(html).imageUrl).toBe('https://example.com/img.png');
    });

    it('accepts http:// image URLs', () => {
      const html = '<meta property="og:title" content="Test"><meta property="og:image" content="http://example.com/img.png">';
      expect(parseOgTags(html).imageUrl).toBe('http://example.com/img.png');
    });

    it('rejects javascript: image URLs', () => {
      const html = '<meta property="og:title" content="Test"><meta property="og:image" content="javascript:alert(1)">';
      expect(parseOgTags(html).imageUrl).toBeNull();
    });

    it('rejects data: image URLs', () => {
      const html = '<meta property="og:title" content="Test"><meta property="og:image" content="data:text/html,<script>alert(1)</script>">';
      expect(parseOgTags(html).imageUrl).toBeNull();
    });

    it('rejects invalid/malformed image URLs', () => {
      const html = '<meta property="og:title" content="Test"><meta property="og:image" content="not-a-url">';
      expect(parseOgTags(html).imageUrl).toBeNull();
    });
  });

  describe('validateFetchUrl (SSRF guard)', () => {
    it('allows ordinary public URLs', () => {
      expect(validateFetchUrl('https://example.com/page')).toBeNull();
      expect(validateFetchUrl('http://example.com')).toBeNull();
      expect(validateFetchUrl('https://93.184.216.34/')).toBeNull();
    });

    it('rejects non-http(s) schemes and malformed URLs', () => {
      expect(validateFetchUrl('ftp://example.com')).not.toBeNull();
      expect(validateFetchUrl('file:///etc/passwd')).not.toBeNull();
      expect(validateFetchUrl('not a url')).not.toBeNull();
    });

    it('rejects localhost and loopback in all spellings', () => {
      expect(validateFetchUrl('http://localhost/')).not.toBeNull();
      expect(validateFetchUrl('http://LOCALHOST:8080/')).not.toBeNull();
      expect(validateFetchUrl('http://foo.localhost/')).not.toBeNull();
      expect(validateFetchUrl('http://127.0.0.1/')).not.toBeNull();
      expect(validateFetchUrl('http://127.0.0.2/')).not.toBeNull();
    });

    it('rejects decimal/hex/octal/partial encoded IPv4 literals', () => {
      expect(validateFetchUrl('http://2130706433/')).not.toBeNull();        // 127.0.0.1 decimal
      expect(validateFetchUrl('http://0x7f000001/')).not.toBeNull();        // hex
      expect(validateFetchUrl('http://0x7f.0.0.1/')).not.toBeNull();        // mixed hex
      expect(validateFetchUrl('http://0177.0.0.1/')).not.toBeNull();        // octal
      expect(validateFetchUrl('http://127.1/')).not.toBeNull();             // partial dotted
      expect(validateFetchUrl('http://3232235521/')).not.toBeNull();        // 192.168.0.1 decimal
    });

    it('rejects private, link-local, CGNAT, and metadata ranges', () => {
      expect(validateFetchUrl('http://10.0.0.1/')).not.toBeNull();
      expect(validateFetchUrl('http://172.16.0.1/')).not.toBeNull();
      expect(validateFetchUrl('http://192.168.1.1/')).not.toBeNull();
      expect(validateFetchUrl('http://169.254.169.254/latest/meta-data/')).not.toBeNull();
      expect(validateFetchUrl('http://100.64.0.1/')).not.toBeNull();
      expect(validateFetchUrl('http://0.0.0.0/')).not.toBeNull();
    });

    it('rejects all IPv6 literals', () => {
      expect(validateFetchUrl('http://[::1]/')).not.toBeNull();
      expect(validateFetchUrl('http://[fd00::1]/')).not.toBeNull();
      expect(validateFetchUrl('http://[fe80::1]/')).not.toBeNull();
      expect(validateFetchUrl('http://[::ffff:127.0.0.1]/')).not.toBeNull();
      expect(validateFetchUrl('http://[2606:4700::6810:84e5]/')).not.toBeNull();
    });
  });

  describe('GET /link-previews', () => {
    it('returns 401 without auth', async () => {
      const res = await fetch(`${BASE_URL}/link-previews?url=${encodeURIComponent('https://example.com')}`);
      expect(res.status).toBe(401);
    });

    it('returns 400 without url parameter', async () => {
      const res = await authedFetch(token, '/link-previews');
      expect(res.status).toBe(400);
      const body = (await res.json() as any) as any;
      expect(body.error).toBe('url parameter required');
    });
  });

  describe('Messages with link previews', () => {
    it('includes link preview data in message list after background unfurl', async () => {
      // First, manually insert a link preview and association to simulate the background unfurl
      // (We can't make real external HTTP requests in tests)

      // Send a message
      const previewUrl = 'https://manual-preview.invalid';
      const sendRes = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: `Check out ${previewUrl}` }),
      });
      expect(sendRes.status).toBe(201);
      const sentMsg = (await sendRes.json() as any) as any;

      // Manually insert a cached preview and association via admin endpoint
      // (simulating what the background unfurl would do). Use .invalid so a
      // background fetch cannot race the manual fixture and overwrite metadata.
      const urlHash = await sha256(previewUrl);
      const now = Math.floor(Date.now() / 1000);
      execSql(`INSERT OR REPLACE INTO link_previews (url_hash, url, title, description, image_url, site_name, fetched_at, expires_at)
                VALUES ('${urlHash}', '${previewUrl}', 'Example Domain', 'This domain is for examples.', 'https://example.com/image.png', 'Example', ${now}, ${now + 86400})`);
      execSql(`INSERT OR IGNORE INTO message_link_previews (message_id, url_hash, url)
                VALUES ('${sentMsg.id}', '${urlHash}', '${previewUrl}')`);

      // Now list messages and verify preview is included
      const listRes = await authedFetch(token, `/channels/${channelId}/messages`);
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json() as any) as any;
      const msg = listBody.messages.find((m: any) => m.id === sentMsg.id);
      expect(msg).toBeDefined();
      expect(msg.linkPreviews).toHaveLength(1);
      expect(msg.linkPreviews[0].url).toBe(previewUrl);
      expect(msg.linkPreviews[0].title).toBe('Example Domain');
      expect(msg.linkPreviews[0].description).toBe('This domain is for examples.');
      expect(msg.linkPreviews[0].imageUrl).toBe('https://example.com/image.png');
      expect(msg.linkPreviews[0].siteName).toBe('Example');
    });

    it('includes link preview data in single message get', async () => {
      // Send a message
      const sendRes = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'See https://test.org for info' }),
      });
      expect(sendRes.status).toBe(201);
      const sentMsg = (await sendRes.json() as any) as any;

      // Manually insert preview data
      const urlHash = await sha256('https://test.org');
      const now = Math.floor(Date.now() / 1000);
      execSql(`INSERT OR REPLACE INTO link_previews (url_hash, url, title, description, image_url, site_name, fetched_at, expires_at)
                VALUES ('${urlHash}', 'https://test.org', 'Test Org', 'A test website.', null, 'TestOrg', ${now}, ${now + 86400})`);
      execSql(`INSERT OR IGNORE INTO message_link_previews (message_id, url_hash, url)
                VALUES ('${sentMsg.id}', '${urlHash}', 'https://test.org')`);

      // Get single message
      const getRes = await authedFetch(token, `/messages/${sentMsg.id}`);
      expect(getRes.status).toBe(200);
      const msgBody = (await getRes.json() as any) as any;
      expect(msgBody.linkPreviews).toHaveLength(1);
      expect(msgBody.linkPreviews[0].title).toBe('Test Org');
    });

    it('returns empty linkPreviews array for messages without previews', async () => {
      const sendRes = await authedFetch(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'No links here' }),
      });
      expect(sendRes.status).toBe(201);
      const sentMsg = (await sendRes.json() as any) as any;

      const getRes = await authedFetch(token, `/messages/${sentMsg.id}`);
      expect(getRes.status).toBe(200);
      const msgBody = (await getRes.json() as any) as any;
      expect(msgBody.linkPreviews).toEqual([]);
    });
  });
});

/** SHA-256 hash helper for tests */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
