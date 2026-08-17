import type { Env } from './types.js';
import { errorResponse } from './utils.js';
import { FEEDBACK_CHANNEL_ID } from './constants.js';
import { ensureFeedbackMembership } from './lib/feedback.js';

/**
 * Return whether a user may access a channel, performing the feedback channel's
 * intentional auto-join on first access.
 */
export async function ensureChannelMembership(env: Env, userId: string, channelId: string): Promise<boolean> {
  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL'
  ).bind(channelId, userId).first();
  if (membership) return true;
  // The global feedback channel auto-joins any authenticated user on first access
  // instead of rejecting (it has no membership UI; see lib/feedback.ts).
  return channelId === FEEDBACK_CHANNEL_ID && await ensureFeedbackMembership(env, userId);
}

/** Throws a 403 Response if the user is not a member of the channel. */
export async function requireChannelMembership(env: Env, userId: string, channelId: string): Promise<void> {
  if (await ensureChannelMembership(env, userId, channelId)) return;
  throw errorResponse('Not a member of this channel', 403);
}
