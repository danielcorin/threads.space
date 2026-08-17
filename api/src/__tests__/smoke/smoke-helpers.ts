// Helpers for the post-deploy smoke suite (post-deploy.smoke.test.ts).
//
// Unlike the integration helpers (which hit a local wrangler dev server with a
// bootstrap admin seeded into a throwaway local D1), these drive the REAL
// authenticated HTTP API of a *deployed* instance as a single logged-in user.
// Everything is configured from the environment so the same suite can target
// any instance origin:
//
//   SMOKE_BASE_URL   required — the instance origin, e.g. https://your-test-instance.example
//   SMOKE_USERNAME   the login username (default "admin")
//   SMOKE_PASSWORD   required — that user's password
//
// Safety: assertNonProduction() refuses to run against an instance whose /health
// reports environment "production", so this can never mutate the prod database.

export const BASE_URL = (process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');
export const USERNAME = process.env.SMOKE_USERNAME ?? 'admin';
export const PASSWORD = process.env.SMOKE_PASSWORD ?? '';

export interface Health {
  status: string;
  commit: string;
  environment: string;
  latestMigration: string | null;
}

// Per-request timeout. A worker mid-rollout can leave a connection hanging; with
// the default (no timeout) that stalled `fetch` consumed the whole 30s hook and
// failed the deploy on a transient. Abort fast instead so the caller can retry.
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS ?? 15000);

// Cloudflare edge codes (worker unavailable / origin handshake) and timeouts seen
// while a new version propagates across PoPs — safe to retry. App-level 4xx (and
// a steady 500) are NOT retried: those are real signal the deploy should gate on.
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526]);

function smokeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** fetch with a per-request timeout + bounded retry on transient rollout errors. */
async function fetchWithRetry(input: string, init: RequestInit = {}, attempts = 6, delayMs = 2000): Promise<Response> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await smokeFetch(input, init);
      if (!RETRYABLE_STATUS.has(res.status)) return res;
      last = new Error(`${input} -> ${res.status}`);
    } catch (err) {
      last = err; // network error or AbortSignal timeout
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw last instanceof Error ? last : new Error(`fetch failed after ${attempts} attempts: ${input}`);
}

/** Read /health. Throws (failing the suite) if the endpoint is missing/unreachable. */
export async function getHealth(): Promise<Health> {
  const res = await fetchWithRetry(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`GET ${BASE_URL}/health -> ${res.status}`);
  const body = (await res.json()) as Partial<Health>;
  if (typeof body.environment !== 'string') {
    throw new Error(
      `/health did not report "environment" — the target is running a build that predates the smoke guard. Refusing to run.`,
    );
  }
  return body as Health;
}

/**
 * Wait until /health reports the expected commit, so smoke never mutates a
 * half-rolled deploy (the cross-PoP propagation window where some edge nodes
 * still serve the previous version). No-op unless an expected commit is given.
 */
export async function waitForCommit(expected: string, attempts = 20, delayMs = 2000): Promise<Health> {
  let health = await getHealth();
  for (let i = 1; health.commit !== expected && i <= attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    health = await getHealth();
  }
  if (health.commit !== expected) {
    throw new Error(
      `/health still reports commit ${health.commit}, expected ${expected} after ${attempts} attempts — refusing to smoke a half-rolled deploy`,
    );
  }
  return health;
}

/**
 * Hard production guard. Call before any mutation. Refuses unless SMOKE_BASE_URL
 * is set and the target's /health reports a non-production environment.
 */
export async function assertNonProduction(): Promise<Health> {
  if (!BASE_URL) throw new Error('SMOKE_BASE_URL is not set — refusing to run the smoke suite');
  if (!PASSWORD) throw new Error('SMOKE_PASSWORD is not set — refusing to run the smoke suite');
  const health = await getHealth();
  if (health.environment === 'production') {
    throw new Error(
      `Refusing to run the smoke suite against a production instance (${BASE_URL} reports environment="production").`,
    );
  }
  return health;
}

/** Log in and return the session token from the Set-Cookie header. */
export async function login(): Promise<string> {
  const res = await fetchWithRetry(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login as "${USERNAME}" failed: ${res.status} ${await res.text()}`);
  }
  const cookie = res.headers.get('set-cookie') ?? '';
  const token = cookie.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error('login succeeded but no session cookie was returned');
  return token;
}

/**
 * Authenticated fetch against the deployed instance. Defaults to a JSON
 * Content-Type, but omits it for FormData bodies so the runtime can set the
 * multipart boundary itself (used by the attachment upload).
 */
export function authed(token: string, path: string, options?: RequestInit): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  // Single-shot (no blind retry — bodies mutate), but with the per-request
  // timeout so a stalled request can never hang the whole test.
  return smokeFetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      Cookie: `session=${token}`,
      ...options?.headers,
    },
  });
}

/** authed() that throws on a non-OK status, returning the parsed JSON body. */
export async function authedJson<T = any>(
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await authed(token, path, options);
  if (!res.ok) {
    throw new Error(`${options?.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}
