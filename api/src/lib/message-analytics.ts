import type { Env } from '../types.js';

export type MessageType = 'human' | 'response' | 'progress' | 'tool_output' | 'thinking';
type ActorRole = 'human' | 'bot';
type ChannelKind = 'public' | 'private' | 'dm' | 'ephemeral';

interface ChannelAnalyticsContext {
  is_dm?: number | null;
  is_private?: number | null;
  is_ephemeral?: number | null;
}

export interface MessageSentAnalyticsInput {
  userId: string;
  actorRole?: string | null;
  messageType: MessageType;
  channel: ChannelAnalyticsContext | null;
  threadId?: string | null;
  contentLength: number;
  attachmentCount: number;
  attachmentBytes: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

const textEncoder = new TextEncoder();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), textEncoder.encode(value));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), textEncoder.encode(value));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function contentLengthBucket(length: number): number {
  if (length <= 0) return 0;
  if (length <= 20) return 20;
  if (length <= 100) return 100;
  if (length <= 500) return 500;
  if (length <= 2000) return 2000;
  if (length <= 10000) return 10000;
  return 10001;
}

export function byteSizeBucket(bytes: number): number {
  if (bytes <= 0) return 0;
  if (bytes <= 1024) return 1024;
  if (bytes <= 10 * 1024) return 10 * 1024;
  if (bytes <= 100 * 1024) return 100 * 1024;
  if (bytes <= 1024 * 1024) return 1024 * 1024;
  if (bytes <= 10 * 1024 * 1024) return 10 * 1024 * 1024;
  return 10 * 1024 * 1024 + 1;
}

function channelKind(channel: ChannelAnalyticsContext | null): ChannelKind {
  if (channel?.is_dm) return 'dm';
  if (channel?.is_ephemeral) return 'ephemeral';
  if (channel?.is_private) return 'private';
  return 'public';
}

function actorRole(role?: string | null): ActorRole {
  return role === 'bot' ? 'bot' : 'human';
}

export async function recordMessageSent(env: Env, input: MessageSentAnalyticsInput): Promise<void> {
  const hashSecret = env.ANALYTICS_HASH_SECRET ?? env.INSTANCE_SECRET;
  if (!env.MESSAGE_ANALYTICS || !hashSecret) return;

  try {
    const instanceHash = await hmacSha256Hex(hashSecret, 'instance:threads');
    const instanceIndexHash = await hmacSha256Base64Url(hashSecret, 'instance:threads');
    const userIndexHash = await hmacSha256Base64Url(hashSecret, `user:${input.userId}`);
    const instanceUserHash = `${instanceIndexHash}:${userIndexHash}`;

    env.MESSAGE_ANALYTICS.writeDataPoint({
      indexes: [instanceUserHash],
      blobs: [
        'v1',
        instanceHash,
        actorRole(input.actorRole),
        input.messageType,
        channelKind(input.channel),
        input.threadId ? 'thread_reply' : 'top_level',
        input.attachmentCount > 0 ? 'has_attachments' : 'none',
      ],
      doubles: [
        1,
        contentLengthBucket(input.contentLength),
        Math.min(Math.max(0, input.attachmentCount), 20),
        byteSizeBucket(input.attachmentBytes),
        Math.max(0, input.inputTokens ?? 0),
        Math.max(0, input.outputTokens ?? 0),
        Math.max(0, input.cacheCreationInputTokens ?? 0),
        Math.max(0, input.cacheReadInputTokens ?? 0),
      ],
    });
  } catch (err) {
    console.error('Message analytics emission failed:', err);
  }
}
