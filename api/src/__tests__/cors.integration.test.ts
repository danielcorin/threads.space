import { describe, it, expect, beforeAll } from 'vitest';
import { BASE_URL, createTestUser, loginUser } from './helpers.js';

describe('CORS allowlist', () => {
  let token: string;

  beforeAll(async () => {
    await createTestUser('cors_user1');
    const login = await loginUser('cors_user1');
    token = login.sessionToken;
  });

  // Helper that sends an authed request with a specific Origin header
  function fetchWithOrigin(path: string, origin?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Cookie: `session=${token}`,
    };
    if (origin) {
      headers['Origin'] = origin;
    }
    return fetch(`${BASE_URL}${path}`, { headers });
  }

  describe('Access-Control-Allow-Origin', () => {
    it('allowed origin gets CORS header', async () => {
      const res = await fetchWithOrigin('/channels', 'http://localhost:5173');
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('disallowed origin gets no CORS header', async () => {
      const res = await fetchWithOrigin('/channels', 'https://evil.com');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('no Origin header gets no CORS header', async () => {
      const res = await fetchWithOrigin('/channels');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('OPTIONS preflight', () => {
    it('allowed origin returns 204 with CORS header', async () => {
      const res = await fetch(`${BASE_URL}/channels`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('disallowed origin returns 204 but no CORS header', async () => {
      const res = await fetch(`${BASE_URL}/channels`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.com' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('standard CORS headers always present', () => {
    it('Allow-Credentials is present with allowed origin', async () => {
      const res = await fetchWithOrigin('/channels', 'http://localhost:5173');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('Allow-Methods is present with allowed origin', async () => {
      const res = await fetchWithOrigin('/channels', 'http://localhost:5173');
      expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
    });

    it('sets Vary: Origin so cached upload responses do not poison CORS previews', async () => {
      const res = await fetchWithOrigin('/channels', 'http://localhost:5173');
      expect(res.headers.get('vary')).toContain('Origin');
    });
  });
});
