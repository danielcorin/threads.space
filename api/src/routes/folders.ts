import type { Env, User, ChannelFolder } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { ensureChannelMembership } from '../middleware.js';

interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  position: number;
  collapsed: number;
  created_at: number;
}

interface FolderItemRow {
  folder_id: string;
  channel_id: string;
  position: number;
}

export async function handleListFolders(env: Env, user: User): Promise<Response> {
  const folders = await env.DB.prepare(
    'SELECT * FROM channel_folders WHERE user_id = ? ORDER BY position'
  ).bind(user.id).all<FolderRow>();

  const items = await env.DB.prepare(
    'SELECT folder_id, channel_id, position FROM channel_folder_items WHERE user_id = ? ORDER BY position'
  ).bind(user.id).all<FolderItemRow>();

  // Group channel IDs by folder, ordered by position
  const channelsByFolder = new Map<string, string[]>();
  for (const item of items.results) {
    const list = channelsByFolder.get(item.folder_id) ?? [];
    list.push(item.channel_id);
    channelsByFolder.set(item.folder_id, list);
  }

  const result: Omit<ChannelFolder, 'user_id' | 'created_at'>[] = folders.results.map((f) => ({
    id: f.id,
    name: f.name,
    position: f.position,
    collapsed: f.collapsed,
    channels: channelsByFolder.get(f.id) ?? [],
  }));

  return jsonResponse(result);
}

export async function handleCreateFolder(request: Request, env: Env, user: User): Promise<Response> {
  const { name } = await readJsonObject<{ name: string }>(request);
  if (!name) return errorResponse('Folder name required');

  const id = generateId();

  // Set position to max + 1
  const maxPos = await env.DB.prepare(
    'SELECT MAX(position) as max_pos FROM channel_folders WHERE user_id = ?'
  ).bind(user.id).first<{ max_pos: number | null }>();
  const position = (maxPos?.max_pos ?? -1) + 1;

  await env.DB.prepare(
    'INSERT INTO channel_folders (id, user_id, name, position) VALUES (?, ?, ?, ?)'
  ).bind(id, user.id, name, position).run();

  return jsonResponse({ id, name, position, collapsed: 0, channels: [] }, 201);
}

export async function handleUpdateFolder(request: Request, env: Env, user: User, folderId: string): Promise<Response> {
  // Verify ownership
  const folder = await env.DB.prepare(
    'SELECT id FROM channel_folders WHERE id = ? AND user_id = ?'
  ).bind(folderId, user.id).first();
  if (!folder) return errorResponse('Folder not found', 404);

  const body = await readJsonObject<{ name?: unknown; position?: unknown; collapsed?: unknown }>(request);
  const updates: string[] = [];
  const values: any[] = [];

  // readJsonObject guarantees an object, not the type of each field. D1 only
  // binds primitives, so an array or object here threw at .bind() and surfaced
  // as a 500 for what is plainly a bad request.
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return errorResponse('name must be a string');
    updates.push('name = ?'); values.push(body.name);
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
      return errorResponse('position must be a finite number');
    }
    updates.push('position = ?'); values.push(body.position);
  }
  if (body.collapsed !== undefined) {
    if (typeof body.collapsed !== 'number' && typeof body.collapsed !== 'boolean') {
      return errorResponse('collapsed must be a number or boolean');
    }
    updates.push('collapsed = ?'); values.push(Number(body.collapsed));
  }
  if (!updates.length) return errorResponse('No updates provided');

  values.push(folderId, user.id);
  await env.DB.prepare(
    `UPDATE channel_folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...values).run();

  return jsonResponse({ ok: true });
}

export async function handleDeleteFolder(env: Env, user: User, folderId: string): Promise<Response> {
  const folder = await env.DB.prepare(
    'SELECT id FROM channel_folders WHERE id = ? AND user_id = ?'
  ).bind(folderId, user.id).first();
  if (!folder) return errorResponse('Folder not found', 404);

  // Deleting the folder cascades to channel_folder_items, channels themselves are untouched
  await env.DB.prepare(
    'DELETE FROM channel_folders WHERE id = ? AND user_id = ?'
  ).bind(folderId, user.id).run();

  return jsonResponse({ ok: true });
}

export async function handleAddChannelToFolder(request: Request, env: Env, user: User, folderId: string): Promise<Response> {
  const folder = await env.DB.prepare(
    'SELECT id FROM channel_folders WHERE id = ? AND user_id = ?'
  ).bind(folderId, user.id).first();
  if (!folder) return errorResponse('Folder not found', 404);

  const { channelId, position } = await readJsonObject<{ channelId: string; position?: number }>(request);
  if (!channelId) return errorResponse('channelId required');

  // channel_folder_items.channel_id is a foreign key, so an id that does not
  // resolve made the INSERT below fail with a D1 FOREIGN KEY error — a 500 for
  // what is just a bad request. Membership (not mere existence) is the right
  // check: you organize channels you are in, and answering 404 identically for
  // "no such channel" and "not yours" keeps this from confirming whether a
  // private channel exists.
  if (!await ensureChannelMembership(env, user.id, channelId)) {
    return errorResponse('Channel not found', 404);
  }

  // Remove from any existing folder for this user first
  await env.DB.prepare(
    'DELETE FROM channel_folder_items WHERE channel_id = ? AND user_id = ?'
  ).bind(channelId, user.id).run();

  // Calculate position if not provided
  let pos = position;
  if (pos === undefined) {
    const maxPos = await env.DB.prepare(
      'SELECT MAX(position) as max_pos FROM channel_folder_items WHERE folder_id = ? AND user_id = ?'
    ).bind(folderId, user.id).first<{ max_pos: number | null }>();
    pos = (maxPos?.max_pos ?? -1) + 1;
  }

  await env.DB.prepare(
    'INSERT INTO channel_folder_items (folder_id, channel_id, user_id, position) VALUES (?, ?, ?, ?)'
  ).bind(folderId, channelId, user.id, pos).run();

  return jsonResponse({ ok: true }, 201);
}

export async function handleRemoveChannelFromFolder(env: Env, user: User, folderId: string, channelId: string): Promise<Response> {
  await env.DB.prepare(
    'DELETE FROM channel_folder_items WHERE folder_id = ? AND channel_id = ? AND user_id = ?'
  ).bind(folderId, channelId, user.id).run();

  return jsonResponse({ ok: true });
}

export async function handleReorderFolders(request: Request, env: Env, user: User): Promise<Response> {
  const { folders, items } = await readJsonObject<{
    folders?: { id: string; position: number }[];
    items?: { folderId: string; channelId: string; position: number }[];
  }>(request);

  const statements: any[] = [];

  if (folders?.length) {
    for (const f of folders) {
      statements.push(
        env.DB.prepare(
          'UPDATE channel_folders SET position = ? WHERE id = ? AND user_id = ?'
        ).bind(f.position, f.id, user.id)
      );
    }
  }

  if (items?.length) {
    for (const item of items) {
      statements.push(
        env.DB.prepare(
          'UPDATE channel_folder_items SET position = ?, folder_id = ? WHERE channel_id = ? AND user_id = ?'
        ).bind(item.position, item.folderId, item.channelId, user.id)
      );
    }
  }

  if (statements.length) {
    await env.DB.batch(statements);
  }

  return jsonResponse({ ok: true });
}
