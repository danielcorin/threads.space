// Target configuration, the production guard, and the HTTP layer.
//
// Mirrors the conventions of the post-deploy smoke suite
// (api/src/__tests__/smoke/smoke-helpers.ts) so operators configure one thing,
// not two:
//
//   SECURITY_BASE_URL   required — instance origin, e.g. https://your-test-instance.example
//                       (falls back to SMOKE_BASE_URL)
//   SECURITY_USERNAME   admin login (default "admin"; falls back to SMOKE_USERNAME)
//   SECURITY_PASSWORD   required (falls back to SMOKE_PASSWORD)
//
// SAFETY: assertNonProduction() refuses to run against an instance whose /health
// reports environment "production". This suite sends deliberately malformed
// input and attempts cross-user reads; it must never point at real user data.

const env = process.env;

export const BASE_URL = (env.SECURITY_BASE_URL ?? env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');
export const USERNAME = env.SECURITY_USERNAME ?? env.SMOKE_USERNAME ?? 'admin';
export const PASSWORD = env.SECURITY_PASSWORD ?? env.SMOKE_PASSWORD ?? '';

const REQUEST_TIMEOUT_MS = Number(env.SECURITY_REQUEST_TIMEOUT_MS ?? 20000);

// On a deployed instance the combined worker serves the SvelteKit client at the
// root and mounts the REST API under /api/*, except for these root-level
// prefixes which go straight to the API worker. Kept in sync with
// API_ROOT_PREFIXES in client/worker/combined.ts — a real client resolves paths
// exactly this way, so the fuzzer exercises the same routing clients hit.
const API_ROOT_PREFIXES = [
  '/agents.txt', '/auth', '/docs', '/events', '/health', '/mcp',
  '/openapi.json', '/presence', '/uploads', '/w', '/ws', '/ws-events.json',
];

function isRootPath(path) {
  const pathname = path.split('?')[0];
  return API_ROOT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

// A deployed instance runs the combined worker (API under /api/*), but a local
// `wrangler dev` on port 8788 serves the bare API worker at the root. Rather
// than making the operator configure which they're pointing at — and silently
// fuzzing 404s if they get it wrong — detect it once at startup.
// SECURITY_API_PREFIX overrides ('' or '/api') if detection ever guesses wrong.
let apiPrefix = process.env.SECURITY_API_PREFIX ?? null;

/** Map an API-relative path to its URL on the target. */
export function resolveUrl(path) {
  return isRootPath(path) ? `${BASE_URL}${path}` : `${BASE_URL}${apiPrefix ?? '/api'}${path}`;
}

/**
 * Probe an authenticated route both ways and remember which one the target
 * answers. Called after login, before any probe runs.
 */
export async function detectApiPrefix(token) {
  if (apiPrefix !== null) return apiPrefix;

  for (const candidate of ['/api', '']) {
    apiPrefix = candidate;
    const res = await request('/users/me', { token });
    if (res.status === 200) return apiPrefix;
  }

  apiPrefix = null;
  throw new Error(
    `Could not reach GET /users/me at either ${BASE_URL}/api/users/me or ${BASE_URL}/users/me. ` +
    `Check SECURITY_BASE_URL, or set SECURITY_API_PREFIX explicitly ('' or '/api').`,
  );
}

/** The detected prefix, for reporting. */
export function currentApiPrefix() {
  return apiPrefix ?? '/api';
}

/** WebSocket URL for an API-relative path (/ws/* is a root prefix). */
export function resolveWsUrl(path) {
  return resolveUrl(path).replace(/^http/, 'ws');
}

// --- Pacing -----------------------------------------------------------------
// A fuzzer is an accidental load test. Test instances share Cloudflare account
// limits with everything else you run, so requests are capped at a modest concurrency
// and every request pays a small delay. Raise deliberately, not by default.

const CONCURRENCY = Number(env.SECURITY_CONCURRENCY ?? 4);
const DELAY_MS = Number(env.SECURITY_DELAY_MS ?? 25);

let inFlight = 0;
const waiting = [];

async function acquire() {
  if (inFlight >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  inFlight++;
}

function release() {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
export async function mapLimit(items, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Requests ---------------------------------------------------------------

/**
 * One raw request against the target. Never throws on an HTTP status — the
 * probes need to inspect 4xx/5xx, those ARE the signal. Network failures and
 * timeouts are returned as a synthetic result so a single hung request can
 * never abort a whole sweep.
 *
 * `rawBody` bypasses JSON.stringify so probes can send malformed payloads
 * (truncated JSON, non-JSON bytes) that a serializer would never produce.
 */
export async function request(path, { method = 'GET', token = null, bearer = null, body, rawBody, headers = {} } = {}) {
  await acquire();
  const url = resolveUrl(path);
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

  if (rawBody !== undefined) {
    init.body = rawBody;
    init.headers['Content-Type'] ??= 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  if (token) init.headers.Cookie = `session=${token}`;
  if (bearer) init.headers.Authorization = `Bearer ${bearer}`;

  const started = Date.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text,
      json: safeJson(text),
      ms: Date.now() - started,
      request: { url, method, body: init.body ?? null, authenticated: Boolean(token || bearer) },
    };
  } catch (err) {
    return {
      ok: false,
      // 0 means "no HTTP response" — distinct from a real 5xx, and never
      // reported as a server error finding.
      status: 0,
      headers: new Headers(),
      text: '',
      json: null,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
      request: { url, method, body: init.body ?? null, authenticated: Boolean(token || bearer) },
    };
  } finally {
    if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
    release();
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A copy-pasteable repro for a finding. Credentials are redacted. */
export function curlRepro(req) {
  const parts = ['curl -i'];
  if (req.method !== 'GET') parts.push(`-X ${req.method}`);
  if (req.authenticated) parts.push(`-H "Cookie: session=$TOKEN"`);
  if (req.body != null) {
    parts.push(`-H 'Content-Type: application/json'`);
    const body = req.body.length > 500 ? `${req.body.slice(0, 500)}...<truncated>` : req.body;
    parts.push(`--data-raw ${JSON.stringify(body)}`);
  }
  parts.push(`'${req.url}'`);
  return parts.join(' ');
}

// --- Health + production guard ----------------------------------------------

export async function getHealth() {
  const res = await request('/health');
  if (res.status !== 200) throw new Error(`GET ${BASE_URL}/health -> ${res.status || res.error}`);
  const body = res.json;
  if (!body || typeof body.environment !== 'string') {
    throw new Error('/health did not report "environment" — refusing to run against an unidentifiable target.');
  }
  return body;
}

/**
 * Hard production guard. Called before anything else, always.
 *
 * This suite writes garbage into channels, hammers endpoints with malformed
 * input, and probes for cross-account reads. Running it against production
 * would corrupt real conversations and page real people.
 */
export async function assertNonProduction() {
  if (!BASE_URL) {
    throw new Error('SECURITY_BASE_URL is not set — refusing to run. Point it at a test instance.');
  }
  if (!PASSWORD) {
    throw new Error('SECURITY_PASSWORD is not set — refusing to run.');
  }
  const health = await getHealth();
  if (health.environment === 'production') {
    throw new Error(
      `Refusing to run the security suite against a production instance ` +
      `(${BASE_URL} reports environment="production"). This suite mutates data and sends hostile input.`,
    );
  }
  return health;
}

/** Log in over the real login route; returns the session cookie value. */
export async function login(username, password) {
  const res = await request('/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  if (res.status !== 200) {
    throw new Error(`login as "${username}" failed: ${res.status} ${res.text.slice(0, 300)}`);
  }
  if (res.json?.mfaRequired) {
    throw new Error(
      `login as "${username}" requires MFA. Use an account without MFA enrolled for the security suite, ` +
      `or run it against an instance where MFA is not enforced.`,
    );
  }
  const cookie = res.headers.get('set-cookie') ?? '';
  const token = cookie.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error(`login as "${username}" returned no session cookie`);
  return token;
}
