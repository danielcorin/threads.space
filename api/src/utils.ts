// ULID-like ID generation: timestamp prefix + random suffix
// Lexicographically sortable by time
export function generateId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map(b => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return `${timestamp}${random}`;
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Stable, non-secret identifier for an API token. SHA-256 of the token value so
// tokens can be listed and revoked by id without ever exposing the secret.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(error: string, status = 400): Response {
  return jsonResponse({ error }, status);
}

/**
 * Read a JSON object request body, rejecting anything that is not one.
 *
 * `request.json<T>()` is a COMPILE-TIME assertion: it promises a shape the
 * runtime never checks. An empty, truncated, or non-JSON body makes it throw,
 * and a body that parses to `null` or an array survives the call only to break
 * the destructuring on the next line. Either way the handler faults and the
 * caller gets a 500 for input the server should simply have refused.
 *
 * This is that refusal. It throws a Response rather than returning one, matching
 * the authorization helpers (requireChannelMembership et al.), so handlers opt
 * in by swapping one call and need no other changes.
 *
 * Every request.json<T>() site in this codebase declares an object type, so
 * rejecting non-objects here narrows nothing that was legitimately accepted.
 */
export async function readJsonObject<T>(request: Request): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw errorResponse('Request body must be valid JSON', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errorResponse('Request body must be a JSON object', 400);
  }
  return parsed as T;
}

/**
 * 503 with a Retry-After hint for transient backend overload (e.g. D1 queued
 * for too long). Distinct from a 500 so well-behaved clients/proxies back off
 * and retry instead of treating it as a hard failure — and so a reconnect
 * storm doesn't get re-amplified by the edge masking overload as a crash.
 */
export function serviceUnavailableResponse(retryAfterSeconds = 5): Response {
  return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

export function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setSessionCookie(token: string, maxAge = 30 * 24 * 60 * 60, domain?: string): string {
  const domainPart = domain ? `; Domain=${domain}` : '';
  const name = domain ? 'session' : '__Host-session';
  return `${name}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${domainPart}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(domain?: string): string {
  const domainPart = domain ? `; Domain=${domain}` : '';
  const name = domain ? 'session' : '__Host-session';
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/${domainPart}; Max-Age=0`;
}

/** Remove the pre-hardening cookie name after accepting it during migration. */
export function clearLegacySessionCookie(): string {
  return 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
