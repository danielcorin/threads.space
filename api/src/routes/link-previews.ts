import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse } from '../utils.js';
import { publishChannelEvent } from '../lib/channel-events.js';

export interface LinkPreview {
  url: string;
  urlHash: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

/** Extract HTTP/HTTPS URLs from message content, ignoring code blocks */
export function extractUrls(content: string): string[] {
  // Remove code blocks (``` ... ```) and inline code (` ... `)
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, '');
  const withoutInlineCode = withoutCodeBlocks.replace(/`[^`]+`/g, '');

  const urlRegex = /https?:\/\/[^\s<>[\]()'"]+/gi;
  const matches = withoutInlineCode.match(urlRegex);
  if (!matches) return [];

  // Clean trailing punctuation that's likely not part of the URL
  const cleaned = matches.map(url => url.replace(/[.,;:!?)]+$/, ''));
  return [...new Set(cleaned)];
}

/** Compute SHA-256 hash of a URL for cache key */
export async function hashUrl(url: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Parse OG tags from HTML */
export function parseOgTags(html: string): {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
} {
  function getMetaContent(property: string): string | null {
    // Match both property="og:X" and name="og:X" patterns
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']|<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      'i'
    );
    const match = html.match(regex);
    return match ? (match[1] || match[2] || null) : null;
  }

  let title = getMetaContent('og:title');
  if (!title) {
    // Fall back to <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    title = titleMatch ? titleMatch[1].trim() : null;
  }

  // Validate og:image is an https:// or http:// URL (reject data:, javascript:, etc.)
  let imageUrl = getMetaContent('og:image');
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        imageUrl = null;
      }
    } catch {
      imageUrl = null;
    }
  }

  return {
    title,
    description: getMetaContent('og:description'),
    imageUrl,
    siteName: getMetaContent('og:site_name'),
  };
}

/**
 * Parse an IPv4 literal with inet_aton semantics: decimal, hex (0x7f...),
 * octal (0177...) components, and 1-4 part forms (e.g. 2130706433,
 * 0x7f.1, 127.1). Returns the 4 octets or null if not an IPv4 literal.
 */
function parseIPv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    nums.push(n);
  }
  // Last component covers the remaining bytes (inet_aton)
  const last = nums[nums.length - 1];
  const prefix = nums.slice(0, -1);
  const restBytes = 4 - prefix.length;
  if (prefix.some((n) => n > 255) || last >= 256 ** restBytes) return null;
  let value = 0;
  for (const n of prefix) value = value * 256 + n;
  value = value * 256 ** restBytes + last;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** Check if a hostname is (or may resolve to) a private/internal address */
function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // Block localhost variants (including *.localhost) and mDNS .local names
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    return true;
  }
  // Block ALL IPv6 literals: enumerating every internal range (loopback,
  // link-local, ULA, v4-mapped, NAT64...) is error-prone and legitimate
  // link-preview targets are practically never raw IPv6 addresses.
  if (lower.includes(':') || lower.startsWith('[')) {
    return true;
  }
  // Block private/special IPv4 ranges, including encoded forms
  // (decimal/hex/octal/partial dotted) that fetch would still resolve.
  const ip = parseIPv4(lower);
  if (ip) {
    const [a, b] = ip;
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (incl. cloud metadata)
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true;                           // multicast + reserved
  }
  return false;
}

/** Validate a URL is safe to fetch (not internal/private) */
export function validateFetchUrl(urlString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https URLs are allowed';
  }
  if (isPrivateHostname(parsed.hostname)) {
    return 'URL points to a private/internal address';
  }
  return null;
}

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Read at most maxBytes of a response body as text, then cancel the stream */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

/** Fetch link preview with timeout, returns null on any error */
export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    // Follow redirects manually so every hop is re-validated — a public URL
    // 302ing to an internal address must not be fetched.
    let currentUrl = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (validateFetchUrl(currentUrl)) return null;

      const res = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ThreadsBot/1.0 (link preview)',
          'Accept': 'text/html',
        },
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        res.body?.cancel().catch(() => {});
        if (!location) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      response = res;
      break;
    }
    if (!response) return null; // redirect chain too long

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    const og = parseOgTags(html);

    // If we got nothing useful, return null
    if (!og.title && !og.description) return null;

    const urlHash = await hashUrl(url);

    return {
      url,
      urlHash,
      title: og.title,
      description: og.description,
      imageUrl: og.imageUrl,
      siteName: og.siteName,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const CACHE_DURATION_SECONDS = 24 * 60 * 60; // 24 hours

/** Get cached preview or fetch and cache */
export async function getCachedOrFetchPreview(env: Env, url: string): Promise<LinkPreview | null> {
  const urlHash = await hashUrl(url);
  const now = Math.floor(Date.now() / 1000);

  // Check cache
  const cached = await env.DB.prepare(
    'SELECT * FROM link_previews WHERE url_hash = ? AND expires_at > ?'
  ).bind(urlHash, now).first<any>();

  if (cached) {
    return {
      url: cached.url,
      urlHash: cached.url_hash,
      title: cached.title,
      description: cached.description,
      imageUrl: cached.image_url,
      siteName: cached.site_name,
    };
  }

  // Fetch fresh
  const preview = await fetchLinkPreview(url);
  if (!preview) return null;

  // Cache in D1
  await env.DB.prepare(`
    INSERT OR REPLACE INTO link_previews (url_hash, url, title, description, image_url, site_name, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    preview.urlHash,
    preview.url,
    preview.title,
    preview.description,
    preview.imageUrl,
    preview.siteName,
    now,
    now + CACHE_DURATION_SECONDS,
  ).run();

  return preview;
}

/** Save link preview association to a message */
export async function saveLinkPreviewForMessage(
  env: Env,
  messageId: string,
  preview: LinkPreview,
): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO message_link_previews (message_id, url_hash, url) VALUES (?, ?, ?)'
  ).bind(messageId, preview.urlHash, preview.url).run();
}

/** GET /link-previews?url=<encoded-url> */
export async function handleGetLinkPreview(env: Env, user: User, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return errorResponse('url parameter required');

  const preview = await getCachedOrFetchPreview(env, targetUrl);
  if (!preview) return jsonResponse({ preview: null });

  return jsonResponse({ preview });
}

/** Background unfurl: extract URLs from message, fetch previews, cache, broadcast */
export async function unfurlMessageLinks(
  env: Env,
  messageId: string,
  channelId: string,
  content: string,
): Promise<void> {
  const urls = extractUrls(content);
  if (urls.length === 0) return;

  // Only unfurl the first URL
  const url = urls[0];
  const preview = await getCachedOrFetchPreview(env, url);
  if (!preview) return;

  // Save association
  await saveLinkPreviewForMessage(env, messageId, preview);

  // Broadcast via WebSocket
  await publishChannelEvent(env, undefined, channelId, {
    type: 'link_preview',
    messageId,
    url: preview.url,
    title: preview.title,
    description: preview.description,
    imageUrl: preview.imageUrl,
    siteName: preview.siteName,
  });
}
