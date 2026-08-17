import type { Env, User } from '../types.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';

export async function handleListDrafts(env: Env, user: User): Promise<Response> {
  // Query text drafts and attachment drafts separately, then merge.
  // This avoids a UNION subquery that can fail if draft_attachments doesn't exist.
  const textRows = await env.DB.prepare(
    `SELECT channel_id FROM drafts WHERE user_id = ? AND content != ''`
  ).bind(user.id).all<{ channel_id: string }>();

  let attachmentChannelIds: string[] = [];
  try {
    const attRows = await env.DB.prepare(
      `SELECT DISTINCT channel_id FROM draft_attachments WHERE user_id = ?`
    ).bind(user.id).all<{ channel_id: string }>();
    attachmentChannelIds = attRows.results.map(r => r.channel_id);
  } catch (e) {
    console.warn('draft_attachments query failed:', e);
  }

  const channelIdSet = new Set([
    ...textRows.results.map(r => r.channel_id),
    ...attachmentChannelIds,
  ]);

  return jsonResponse({ channel_ids: [...channelIdSet] });
}

export async function handleGetDraft(env: Env, user: User, channelId: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT content FROM drafts WHERE user_id = ? AND channel_id = ?'
  ).bind(user.id, channelId).first<{ content: string }>();

  let attachments: Array<{ id: string; filename: string; contentType: string; sizeBytes: number; url: string }> = [];
  try {
    const attachmentRows = await env.DB.prepare(
      `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.r2_key
       FROM draft_attachments da
       JOIN attachments a ON a.id = da.attachment_id
       WHERE da.user_id = ? AND da.channel_id = ?`
    ).bind(user.id, channelId).all<{
      id: string; filename: string; content_type: string; size_bytes: number; r2_key: string;
    }>();

    attachments = attachmentRows.results.map(a => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      url: `/uploads/${a.r2_key}`,
    }));
  } catch (e) {
    console.warn('draft_attachments query failed:', e);
  }

  return jsonResponse({ content: row?.content ?? '', attachments });
}

export async function handlePutDraft(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  const body = await readJsonObject<{ content: string; attachment_ids?: string[] }>(request);
  const { content } = body;
  const attachmentIds = body.attachment_ids ?? [];

  if (typeof content !== 'string') {
    return errorResponse('content is required', 400);
  }

  const isEmpty = content === '' && attachmentIds.length === 0;

  if (isEmpty) {
    // Delete the draft row and all draft attachments
    await env.DB.batch([
      env.DB.prepare('DELETE FROM drafts WHERE user_id = ? AND channel_id = ?').bind(user.id, channelId),
      env.DB.prepare('DELETE FROM draft_attachments WHERE user_id = ? AND channel_id = ?').bind(user.id, channelId),
    ]);
  } else {
    const statements = [];

    // Upsert draft text (always, even if empty -- the attachments keep the draft alive)
    if (content !== '') {
      statements.push(
        env.DB.prepare(
          `INSERT INTO drafts (user_id, channel_id, content, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, channel_id)
           DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
        ).bind(user.id, channelId, content, new Date().toISOString())
      );
    } else {
      // No text content but has attachments -- remove text row if any
      statements.push(
        env.DB.prepare('DELETE FROM drafts WHERE user_id = ? AND channel_id = ?').bind(user.id, channelId)
      );
    }

    // Replace draft attachments: delete old, insert new
    statements.push(
      env.DB.prepare('DELETE FROM draft_attachments WHERE user_id = ? AND channel_id = ?').bind(user.id, channelId)
    );
    for (const aid of attachmentIds) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO draft_attachments (user_id, channel_id, attachment_id) VALUES (?, ?, ?)'
        ).bind(user.id, channelId, aid)
      );
    }

    await env.DB.batch(statements);
  }

  return jsonResponse({ ok: true });
}
