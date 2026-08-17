import type { BackgroundTaskContext, Env } from '../types.js';
import {
  dispatchWebhookEvent,
  type ResolveBotRecipientsOptions,
} from './webhooks.js';

export type ChannelEvent = { type: string } & Record<string, unknown>;

export interface ChannelRealtimeOptions {
  excludeRoles?: string[];
  botSender?: { mentionedUserIds: string[] };
}

export interface ChannelWebhookOptions extends ResolveBotRecipientsOptions {
  extraBotRecipientIds?: string[];
}

export interface PublishChannelEventOptions {
  realtime?: ChannelRealtimeOptions;
  /** Omit to keep the event realtime-only. Pass an object to enable webhooks. */
  webhooks?: ChannelWebhookOptions;
}

/**
 * Authoritative publication seam for channel-scoped events.
 *
 * The channel argument is the canonical routing key: callers cannot
 * accidentally skip global delivery by forgetting channelId in the payload.
 * Event payloads remain unchanged for per-channel sockets and webhooks. Webhooks
 * remain opt-in so migrating a realtime-only producer cannot expand its
 * externally visible behavior.
 */
export async function publishChannelEvent(
  env: Env,
  ctx: BackgroundTaskContext | undefined,
  channelId: string,
  event: ChannelEvent,
  options: PublishChannelEventOptions = {},
): Promise<void> {
  const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(channelId));
  await room.broadcastMessage(
    channelId,
    event,
    options.realtime?.excludeRoles,
    options.realtime?.botSender,
  );

  if (options.webhooks === undefined) return;

  const delivery = dispatchWebhookEvent(env, channelId, event, options.webhooks)
    .catch((err) => console.error('Webhook dispatch failed:', err));
  if (ctx) {
    ctx.waitUntil(delivery);
  } else {
    await delivery;
  }
}
