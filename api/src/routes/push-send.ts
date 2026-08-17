import type { Env } from '../types.js';
import { sendPushNotification } from '../lib/web-push.js';

interface PushContext {
  channelId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  threadId: string | null;
  mentions: { userId: string; username: string }[];
  messageType?: string;
}

interface PushPayloadContext {
  channelId: string;
  messageId: string;
  title: string;
  body: string;
}

export function buildMessagePushPayload(ctx: PushPayloadContext): string {
  const url = `/?channel=${encodeURIComponent(ctx.channelId)}&msg=${encodeURIComponent(ctx.messageId)}`;
  return JSON.stringify({
    type: 'message',
    title: ctx.title,
    body: ctx.body,
    tag: `channel:${ctx.channelId}`,
    channelId: ctx.channelId,
    messageId: ctx.messageId,
    url,
  });
}

/** Apply the per-channel notification tier ('all' | 'mentions' | 'none') to candidate recipients. */
export function filterByNotificationTier<T extends { user_id: string; notifications: string }>(
  members: T[],
  mentionedUserIds: Set<string>,
): T[] {
  return members.filter((m) => {
    if (m.notifications === 'none') return false;
    if (m.notifications === 'mentions' && !mentionedUserIds.has(m.user_id)) return false;
    return true;
  });
}

export async function sendPushNotifications(env: Env, ctx: PushContext): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  // Only send push for human and response messages
  if (ctx.messageType && !['human', 'response'].includes(ctx.messageType)) return;

  // Get channel info for notification title
  const channel = await env.DB.prepare('SELECT name, is_private, is_dm FROM channels WHERE id = ?')
    .bind(ctx.channelId).first<{ name: string; is_private: number; is_dm: number }>();
  if (!channel) return;

  // Get active channel members (excluding sender) with their per-channel
  // notification tier — users who left must not be notified, and the tier
  // chosen in the channel menu must actually gate pushes.
  const members = await env.DB.prepare(
    'SELECT user_id, notifications FROM channel_members WHERE channel_id = ? AND user_id != ? AND left_at IS NULL'
  ).bind(ctx.channelId, ctx.senderId).all<{ user_id: string; notifications: string }>();

  if (!members.results.length) return;

  const tierEligible = filterByNotificationTier(
    members.results,
    new Set(ctx.mentions.map((m) => m.userId)),
  );
  if (!tierEligible.length) return;

  // Suppress notifications for users who are actively using the app right now —
  // a click/keystroke within the idle window (60s) on ANY of their open clients.
  // Liveness is GLOBAL, tracked on the always-connected presence socket, not per
  // channel: if you've switched channels, typed, or clicked anywhere in the last
  // minute you won't be pushed, and the unread badge covers what you missed. We
  // used to suppress on mere WebSocket presence, but an open-but-idle desktop tab
  // stays connected and so silenced push on the user's phone — keying off real
  // input means an idle (or disconnected) client no longer blocks delivery. The
  // per-channel tier ('none' fully mutes) and per-user push_preferences below
  // remain the explicit user controls.
  const presence = env.PRESENCE_ROOM.get(env.PRESENCE_ROOM.idFromName('global'));
  const activeUserIds = new Set(await presence.getActiveUserIds());

  const candidateUserIds = tierEligible
    .map((m) => m.user_id)
    .filter((uid) => !activeUserIds.has(uid));

  if (!candidateUserIds.length) return;

  // Check push preferences
  const placeholders = candidateUserIds.map(() => '?').join(',');
  const prefs = await env.DB.prepare(
    `SELECT user_id, enabled, notify_mentions_only FROM push_preferences WHERE user_id IN (${placeholders})`
  ).bind(...candidateUserIds).all<{ user_id: string; enabled: number; notify_mentions_only: number }>();

  const prefsMap = new Map(prefs.results.map((p) => [p.user_id, p]));
  const mentionedUserIds = new Set(ctx.mentions.map((m) => m.userId));

  // Filter users based on preferences
  const eligibleUserIds = candidateUserIds.filter((uid) => {
    const pref = prefsMap.get(uid);
    // Default: enabled=1, mentions_only=0
    if (pref && !pref.enabled) return false;
    if (pref?.notify_mentions_only && !mentionedUserIds.has(uid)) return false;
    return true;
  });

  if (!eligibleUserIds.length) return;

  // Get push subscriptions for eligible users
  const subPlaceholders = eligibleUserIds.map(() => '?').join(',');
  const subscriptions = await env.DB.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth, failure_count FROM push_subscriptions WHERE user_id IN (${subPlaceholders})`
  ).bind(...eligibleUserIds).all<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string; failure_count: number }>();

  if (!subscriptions.results.length) return;

  // Build notification payload
  const title = channel.is_dm ? ctx.senderName : `#${channel.name}`;
  const body = channel.is_dm
    ? (ctx.content.length > 120 ? `${ctx.content.slice(0, 117)}...` : ctx.content)
    : (ctx.content.length > 100
      ? `${ctx.senderName}: ${ctx.content.slice(0, 97)}...`
      : `${ctx.senderName}: ${ctx.content}`);
  const payload = buildMessagePushPayload({
    channelId: ctx.channelId,
    messageId: ctx.messageId,
    title,
    body,
  });

  const vapidKeys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  // Consecutive 4xx responses after which we assume the subscription is
  // permanently dead (stale VAPID, revoked permission, deleted device).
  // Push services are inconsistent about returning 410 Gone, so this is
  // the backstop that keeps push_subscriptions from accumulating orphans.
  const FAILURE_THRESHOLD = 5;

  async function recordFailure(sub: { id: string; failure_count: number }): Promise<void> {
    const nextCount = (sub.failure_count ?? 0) + 1;
    if (nextCount >= FAILURE_THRESHOLD) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    } else {
      await env.DB.prepare('UPDATE push_subscriptions SET failure_count = ? WHERE id = ?').bind(nextCount, sub.id).run();
    }
  }

  // Send to all subscriptions, handle 410 Gone by deleting stale subscriptions
  const results = await Promise.allSettled(
    subscriptions.results.map(async (sub) => {
      try {
        const res = await sendPushNotification(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          payload,
          vapidKeys,
          env.VAPID_SUBJECT || 'mailto:admin@example.com',
        );
        if (res.status === 410 || res.status === 404) {
          // Subscription expired or invalid — remove it
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
        } else if (res.status >= 400) {
          await recordFailure(sub);
        } else {
          // Reset failure_count on success so transient outages don't prune
          // otherwise-healthy subscriptions. Skip the UPDATE when already 0.
          if ((sub.failure_count ?? 0) > 0) {
            await env.DB.prepare('UPDATE push_subscriptions SET failure_count = 0 WHERE id = ?').bind(sub.id).run();
          }
        }
        return res;
      } catch (err) {
        // Network-level failure — count against threshold so perpetually
        // unreachable endpoints eventually get pruned.
        await recordFailure(sub).catch(() => {});
        throw err;
      }
    }),
  );

  // Log any failures for debugging
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Push send failed:', result.reason);
    } else if (result.value.status >= 400) {
      const body = await result.value.text().catch(() => '');
      console.error(`Push send HTTP ${result.value.status}:`, body);
    }
  }
}
