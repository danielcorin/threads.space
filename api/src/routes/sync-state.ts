import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';

// Keys are namespaced per user server-side (`<user.id>:<key>`) so clients and
// bots can only see and overwrite their own cursor state. Callers never see
// the prefix: it's added on write/lookup and stripped from results.
function scopedKey(user: User, key: string): string {
  return `${user.id}:${key}`;
}

function stripScope(user: User, storedKey: string): string {
  return storedKey.slice(user.id.length + 1);
}

export async function handleGetSyncState(env: Env, user: User, key: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT key, value, updated_at FROM sync_state WHERE key = ?')
    .bind(scopedKey(user, key)).first<{ key: string; value: string; updated_at: number }>();
  if (!row) return errorResponse('Not found', 404);
  return jsonResponse({ ...row, key: stripScope(user, row.key) });
}

export async function handleGetSyncStateByPrefix(env: Env, user: User, prefix: string): Promise<Response> {
  // Escape SQL LIKE wildcards in the prefix to prevent unintended matches
  const escaped = scopedKey(user, prefix).replace(/[%_]/g, '\\$&');
  const rows = await env.DB.prepare("SELECT key, value, updated_at FROM sync_state WHERE key LIKE ? ESCAPE '\\'")
    .bind(`${escaped}%`).all<{ key: string; value: string; updated_at: number }>();
  return jsonResponse(rows.results.map((r) => ({ ...r, key: stripScope(user, r.key) })));
}

export async function handlePutSyncState(request: Request, env: Env, user: User, key: string): Promise<Response> {
  const body = await readJsonObject<{ value: string }>(request);
  if (body.value === undefined || body.value === null) return errorResponse('value is required');

  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(scopedKey(user, key), body.value).run();

  return jsonResponse({ key, value: body.value });
}
