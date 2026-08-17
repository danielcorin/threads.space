import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';

export async function handleGetVapidKey(env: Env): Promise<Response> {
  return jsonResponse({ key: env.VAPID_PUBLIC_KEY ?? null });
}

// The stored endpoint is POSTed server-side later (web-push delivery), so an
// arbitrary URL here is a stored SSRF. Only accept the known browser push
// services.
const PUSH_ENDPOINT_ALLOWED_HOSTS = new Set([
  'fcm.googleapis.com',                  // Chrome / Chromium
  'updates.push.services.mozilla.com',   // Firefox
  'web.push.apple.com',                  // Safari
]);
const PUSH_ENDPOINT_ALLOWED_SUFFIXES = [
  '.googleapis.com',
  '.push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',                 // Edge / WNS
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_ENDPOINT_ALLOWED_HOSTS.has(host)
    || PUSH_ENDPOINT_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export async function handleSubscribe(request: Request, env: Env, user: User): Promise<Response> {
  const { endpoint, p256dh, auth, userAgent } = await readJsonObject<{
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  }>(request);

  if (!endpoint || !p256dh || !auth) {
    return errorResponse('endpoint, p256dh, and auth are required');
  }

  if (!isAllowedPushEndpoint(endpoint)) {
    return errorResponse('endpoint is not a recognized browser push service', 400);
  }

  // An endpoint is a per-browser capability URL; letting a different account
  // silently take it over would redirect (and DoS) the original user's
  // notifications. The client recovers from 409 by creating a fresh
  // subscription with a new endpoint.
  const existing = await env.DB.prepare(
    'SELECT user_id FROM push_subscriptions WHERE endpoint = ?'
  ).bind(endpoint).first<{ user_id: string }>();
  if (existing && existing.user_id !== user.id) {
    return errorResponse('endpoint is registered to a different user', 409);
  }

  const id = generateId();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint)
      DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
                    user_agent = excluded.user_agent, updated_at = unixepoch()
    `).bind(id, user.id, endpoint, p256dh, auth, userAgent ?? null),
    env.DB.prepare(`
      INSERT INTO push_preferences (user_id, enabled, notify_mentions_only)
      VALUES (?, 1, COALESCE((SELECT notify_mentions_only FROM push_preferences WHERE user_id = ?), 0))
      ON CONFLICT(user_id)
      DO UPDATE SET enabled = 1, updated_at = unixepoch()
    `).bind(user.id, user.id),
  ]);

  return jsonResponse({ ok: true }, 201);
}

export async function handleUnsubscribe(request: Request, env: Env, user: User): Promise<Response> {
  const { endpoint } = await readJsonObject<{ endpoint: string }>(request);
  if (!endpoint) return errorResponse('endpoint is required');

  await env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'
  ).bind(endpoint, user.id).run();

  return jsonResponse({ ok: true });
}

export async function handleGetPreferences(env: Env, user: User): Promise<Response> {
  const prefs = await env.DB.prepare(
    'SELECT * FROM push_preferences WHERE user_id = ?'
  ).bind(user.id).first<{ enabled: number; notify_mentions_only: number }>();

  return jsonResponse({
    enabled: prefs?.enabled ?? 1,
    notifyMentionsOnly: prefs?.notify_mentions_only ?? 0,
  });
}

export async function handleUpdatePreferences(request: Request, env: Env, user: User): Promise<Response> {
  const { enabled, notifyMentionsOnly } = await readJsonObject<{
    enabled?: number;
    notifyMentionsOnly?: number;
  }>(request);

  await env.DB.prepare(`
    INSERT INTO push_preferences (user_id, enabled, notify_mentions_only)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id)
    DO UPDATE SET enabled = excluded.enabled, notify_mentions_only = excluded.notify_mentions_only,
                  updated_at = unixepoch()
  `).bind(user.id, enabled ?? 1, notifyMentionsOnly ?? 0).run();

  return jsonResponse({ ok: true });
}
