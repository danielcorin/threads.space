import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';

// --- KV (D1-backed) ---
// Per-widget key/value store. The worker/tunnel proxy and the metrics/schedules
// data endpoints were removed; only this durable KV surface remains.

export async function handleWidgetKvGet(
  env: Env,
  user: User,
  widgetId: string,
  key: string,
): Promise<Response> {
  const widget = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?')
    .bind(widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);

  const row = await env.DB.prepare(
    'SELECT value FROM widget_kv WHERE widget_id = ? AND user_id = ? AND key = ?'
  ).bind(widgetId, user.id, key).first<{ value: string }>();

  if (!row) return errorResponse('Key not found', 404);

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    parsed = row.value;
  }

  return jsonResponse({ key, value: parsed });
}

export async function handleWidgetKvGetGlobal(
  env: Env,
  user: User,
  widgetId: string,
  key: string,
): Promise<Response> {
  if (user.role !== 'bot') return errorResponse('Bot access required', 403);

  const widget = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?')
    .bind(widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);

  const rows = await env.DB.prepare(
    'SELECT user_id, value FROM widget_kv WHERE widget_id = ? AND key = ?'
  ).bind(widgetId, key).all<{ user_id: string; value: string }>();

  const values = rows.results.map(r => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      parsed = r.value;
    }
    return { userId: r.user_id, value: parsed };
  });

  return jsonResponse({ key, values });
}

export async function handleWidgetKvPut(
  request: Request,
  env: Env,
  user: User,
  widgetId: string,
  key: string,
): Promise<Response> {
  const widget = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?')
    .bind(widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);

  const body = await readJsonObject<{ value: unknown }>(request);
  if (body.value === undefined) return errorResponse('value is required');

  const serialized = JSON.stringify(body.value);

  await env.DB.prepare(
    `INSERT INTO widget_kv (widget_id, user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (widget_id, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(widgetId, user.id, key, serialized).run();

  return jsonResponse({ ok: true });
}

export async function handleWidgetKvDelete(
  env: Env,
  user: User,
  widgetId: string,
  key: string,
): Promise<Response> {
  const widget = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?')
    .bind(widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);

  await env.DB.prepare(
    'DELETE FROM widget_kv WHERE widget_id = ? AND user_id = ? AND key = ?'
  ).bind(widgetId, user.id, key).run();

  return jsonResponse({ ok: true });
}
