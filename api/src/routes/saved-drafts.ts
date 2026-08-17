import type { Env, User } from '../types.js';
import { generateId, jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import { requireChannelMembership } from '../middleware.js';
import { createMessage, MessageCreationError } from '../services/messages.js';

export async function handleCreateSavedDraft(request: Request, env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);
  const { content } = await readJsonObject<{ content: string }>(request);
  if (!content || typeof content !== 'string' || content.trim() === '') {
    return errorResponse('content is required', 400);
  }

  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO saved_drafts (id, channel_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, channelId, user.id, content, now, now).run();

  return jsonResponse({ id, channel_id: channelId, user_id: user.id, content, created_at: now, updated_at: now, scheduled_at: null }, 201);
}

export async function handleListSavedDrafts(env: Env, user: User, channelId: string): Promise<Response> {
  await requireChannelMembership(env, user.id, channelId);

  const result = await env.DB.prepare(
    'SELECT id, channel_id, user_id, content, created_at, updated_at, scheduled_at FROM saved_drafts WHERE channel_id = ? AND user_id = ? ORDER BY created_at DESC'
  ).bind(channelId, user.id).all();

  return jsonResponse(result.results);
}

export async function handleDeleteSavedDraft(env: Env, user: User, draftId: string): Promise<Response> {
  const existing = await env.DB.prepare(
    'SELECT id FROM saved_drafts WHERE id = ? AND user_id = ?'
  ).bind(draftId, user.id).first();

  if (!existing) return errorResponse('Draft not found', 404);

  await env.DB.prepare('DELETE FROM saved_drafts WHERE id = ?').bind(draftId).run();

  return jsonResponse({ ok: true });
}

export async function handleScheduleSavedDraft(request: Request, env: Env, user: User, draftId: string): Promise<Response> {
  const { scheduled_at } = await readJsonObject<{ scheduled_at: string | null }>(request);

  // Look up the draft without filtering by user_id so we can distinguish 404 vs 403
  const draft = await env.DB.prepare(
    'SELECT id, channel_id, user_id, content, created_at, updated_at, scheduled_at FROM saved_drafts WHERE id = ?'
  ).bind(draftId).first<{ id: string; channel_id: string; user_id: string; content: string; created_at: string; updated_at: string; scheduled_at: string | null }>();

  if (!draft) return errorResponse('Draft not found', 404);
  if (draft.user_id !== user.id) return errorResponse('Forbidden', 403);

  if (scheduled_at !== null) {
    const date = new Date(scheduled_at);
    if (isNaN(date.getTime())) {
      return errorResponse('scheduled_at must be a valid ISO date string', 400);
    }
    if (date.getTime() <= Date.now()) {
      return errorResponse('scheduled_at must be in the future', 400);
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE saved_drafts SET scheduled_at = ?, updated_at = ? WHERE id = ?'
  ).bind(scheduled_at, now, draftId).run();

  return jsonResponse({
    ...draft,
    scheduled_at,
    updated_at: now,
  });
}

/** Cron handler: deliver all saved drafts whose scheduled_at is in the past */
export async function handleScheduledDelivery(env: Env, ctx?: ExecutionContext): Promise<number> {
  const now = new Date().toISOString();
  // Claim atomically: the DELETE ... RETURNING removes due drafts in one
  // statement, so a concurrent run (cron + the manual admin endpoint) or a
  // crash mid-loop can never deliver the same draft twice. The tradeoff is
  // that a draft whose delivery fails is dropped (and logged) rather than
  // retried every minute forever.
  const claimed = await env.DB.prepare(
    'DELETE FROM saved_drafts WHERE scheduled_at IS NOT NULL AND scheduled_at <= ? RETURNING id, channel_id, user_id, content'
  ).bind(now).all<{ id: string; channel_id: string; user_id: string; content: string }>();

  let delivered = 0;
  for (const draft of claimed.results) {
    try {
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
        .bind(draft.user_id).first<User>();
      if (!user) {
        console.error(`Scheduled draft ${draft.id}: user ${draft.user_id} not found, dropping`);
        continue;
      }
      // Cross the same application interface as REST and WebSocket sends so
      // scheduled messages get mentions, push, unfurls, and breaker accounting.
      await createMessage(env, {
        actor: user,
        channelId: draft.channel_id,
        content: draft.content,
      }, ctx);
      delivered++;
    } catch (err) {
      // Per-draft isolation: one bad draft (deleted channel, lost membership)
      // must not block the rest of the run.
      if (err instanceof MessageCreationError) {
        console.error(`Scheduled draft ${draft.id}: delivery failed with ${err.status}, dropping`);
      } else {
        console.error(`Scheduled draft ${draft.id}: delivery threw, dropping`, err);
      }
    }
  }
  return delivered;
}
