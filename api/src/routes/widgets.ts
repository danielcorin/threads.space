import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { getAllowedOrigins } from '../lib/origins.js';

// --- CRUD ---

export async function handleListWidgets(env: Env, _user: User): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT id, name, description, icon, created_by, created_at, updated_at FROM widgets ORDER BY created_at DESC'
  ).all();
  return jsonResponse(rows.results);
}

export async function handleGetWidget(env: Env, user: User, widgetId: string): Promise<Response> {
  const widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);
  return jsonResponse(widget);
}

export async function handleCreateWidget(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject<{ name: string; description?: string; icon?: string; code: string }>(request);
  if (!body.name || !body.code) return errorResponse('name and code are required');

  const id = generateId();
  await env.DB.prepare(
    'INSERT INTO widgets (id, name, description, icon, code, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, body.name, body.description ?? null, body.icon ?? 'PuzzlePiece', body.code, user.id).run();

  const widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(id).first();
  return jsonResponse(widget, 201);
}

export async function handleUpdateWidget(request: Request, env: Env, user: User, widgetId: string): Promise<Response> {
  const widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(widgetId).first<{ created_by: string }>();
  if (!widget) return errorResponse('Widget not found', 404);
  if (widget.created_by !== user.id) return errorResponse('Only the creator can update this widget', 403);

  const body = await readJsonObject<{ name?: string; description?: string; icon?: string; code?: string }>(request);
  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }
  if (body.icon !== undefined) { sets.push('icon = ?'); values.push(body.icon); }
  if (body.code !== undefined) { sets.push('code = ?'); values.push(body.code); }

  if (sets.length === 0) return errorResponse('No fields to update');

  sets.push("updated_at = datetime('now')");
  values.push(widgetId);

  await env.DB.prepare(`UPDATE widgets SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  const updated = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?').bind(widgetId).first();
  return jsonResponse(updated);
}

export async function handleDeleteWidget(env: Env, user: User, widgetId: string): Promise<Response> {
  const widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(widgetId).first<{ created_by: string }>();
  if (!widget) return errorResponse('Widget not found', 404);
  if (widget.created_by !== user.id) return errorResponse('Only the creator can delete this widget', 403);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM channel_widgets WHERE widget_id = ?').bind(widgetId),
    env.DB.prepare('DELETE FROM widgets WHERE id = ?').bind(widgetId),
  ]);

  return jsonResponse({ ok: true });
}

// --- Channel scoping ---

async function checkChannelMembership(env: Env, user: User, channelId: string): Promise<Response | null> {
  const channel = await env.DB.prepare('SELECT is_private FROM channels WHERE id = ?')
    .bind(channelId).first<{ is_private: number }>();
  if (!channel) return errorResponse('Channel not found', 404);

  if (channel.is_private) {
    const membership = await env.DB.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
    ).bind(channelId, user.id).first();
    if (!membership) return errorResponse('Not a member of this channel', 403);
  }
  return null;
}

export async function handleListChannelWidgets(env: Env, user: User, channelId: string): Promise<Response> {
  const denied = await checkChannelMembership(env, user, channelId);
  if (denied) return denied;

  const rows = await env.DB.prepare(
    `SELECT w.id, w.name, w.description, w.icon, w.created_by, w.created_at, w.updated_at,
            cw.added_by, cw.added_at
     FROM channel_widgets cw
     JOIN widgets w ON w.id = cw.widget_id
     WHERE cw.channel_id = ?
     ORDER BY cw.added_at DESC`
  ).bind(channelId).all();

  return jsonResponse(rows.results);
}

export async function handleAddWidgetToChannel(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  const denied = await checkChannelMembership(env, user, channelId);
  if (denied) return denied;

  const body = await readJsonObject<{ widgetId: string }>(request);
  if (!body.widgetId) return errorResponse('widgetId is required');

  const widget = await env.DB.prepare('SELECT id FROM widgets WHERE id = ?')
    .bind(body.widgetId).first();
  if (!widget) return errorResponse('Widget not found', 404);

  await env.DB.prepare(
    'INSERT OR IGNORE INTO channel_widgets (channel_id, widget_id, added_by) VALUES (?, ?, ?)'
  ).bind(channelId, body.widgetId, user.id).run();

  return jsonResponse({ ok: true }, 201);
}

export async function handleRemoveWidgetFromChannel(env: Env, user: User, channelId: string, widgetId: string): Promise<Response> {
  const denied = await checkChannelMembership(env, user, channelId);
  if (denied) return denied;

  await env.DB.prepare(
    'DELETE FROM channel_widgets WHERE channel_id = ? AND widget_id = ?'
  ).bind(channelId, widgetId).run();

  return jsonResponse({ ok: true });
}

// --- Widget runtime ---

export async function handleWidgetRuntime(request: Request, env: Env, widgetId: string): Promise<Response> {
  // Widget runtime is public — the HTML/JS shell itself isn't sensitive.
  // All data access is gated through the authenticated postMessage bridge in WidgetPanel.
  // Making this public avoids iframe cookie issues on mobile Safari (ITP blocks
  // cookies in sandboxed iframes without allow-same-origin).
  const widget = await env.DB.prepare('SELECT * FROM widgets WHERE id = ?')
    .bind(widgetId).first<{ id: string; name: string; code: string }>();
  if (!widget) return errorResponse('Widget not found', 404);

  const url = new URL(request.url);
  const channelId = url.searchParams.get('channelId') ?? '';
  const parentOrigin = url.searchParams.get('parentOrigin') ?? '';

  // Validate the parent origin against our allowlist to prevent a
  // malicious embedder from setting an arbitrary target origin.
  const allowedParentOrigins = getAllowedOrigins(env, new URL(request.url).origin);
  if (!parentOrigin || !allowedParentOrigins.includes(parentOrigin)) {
    return errorResponse('Invalid parentOrigin parameter', 400);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(widget.name)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; padding: 0; }
</style>
</head>
<body>
<script>
var WIDGET_ID = ${JSON.stringify(widget.id)};
var CHANNEL_ID = ${JSON.stringify(channelId)};
var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
window.ThreadsWidget = {
  getContext: function() {
    return {
      widgetId: WIDGET_ID,
      channelId: CHANNEL_ID
    };
  },
  fetch: function(path, options) {
    var id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    return new Promise(function(resolve, reject) {
      function handler(event) {
        if (event.origin !== PARENT_ORIGIN) return;
        if (event.data && event.data.type === 'widget-data-response' && event.data.requestId === id) {
          window.removeEventListener('message', handler);
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.body);
          }
        }
      }
      window.addEventListener('message', handler);
      setTimeout(function() {
        window.removeEventListener('message', handler);
        reject(new Error('Widget data request timed out'));
      }, 30000);
      window.parent.postMessage({
        type: 'widget-data-request',
        requestId: id,
        widgetId: WIDGET_ID,
        path: path,
        method: (options && options.method) || 'GET',
        body: options && options.body
      }, PARENT_ORIGIN);
    });
  },
  fetchWorker: function(path, options) {
    return window.ThreadsWidget.fetch('/worker/' + path, options);
  },
  fetchTunnel: function(path, options) {
    return window.ThreadsWidget.fetch('/tunnel/' + path, options);
  },
  kv: {
    get: function(key) {
      return window.ThreadsWidget.fetch('/kv/' + key);
    },
    set: function(key, value) {
      return window.ThreadsWidget.fetch('/kv/' + key, { method: 'PUT', body: JSON.stringify({ value: value }) });
    },
    delete: function(key) {
      return window.ThreadsWidget.fetch('/kv/' + key, { method: 'DELETE' });
    }
  }
};
</script>
${widget.code}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Widget iframes run user-authored code (unsafe-inline) but communicate
      // exclusively via postMessage — no direct fetch/WS needed. connect-src
      // 'none' blocks network access; data flows through the parent bridge.
      // img-src must not allow arbitrary https: hosts — an image beacon would
      // let widget code exfiltrate data despite connect-src 'none'.
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        // Only allow the Threads client origins to embed this widget iframe
        `frame-ancestors ${allowedParentOrigins.join(' ')}`,
      ].join('; '),
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
