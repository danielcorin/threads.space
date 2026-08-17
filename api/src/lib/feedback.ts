import type { Env } from '../types.js';
import {
  FEEDBACK_BOT_ID,
  FEEDBACK_CHANNEL_ID,
  FEEDBACK_REPLIES,
} from '../constants.js';

export interface FeedbackImageAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
}

interface ResendAttachment {
  filename: string;
  content: string;
}

// Resend caps the entire email at 40 MB after Base64 encoding. Keep a little
// headroom for the message body and MIME metadata so multiple images cannot
// make the whole feedback email fail.
const MAX_RESEND_ATTACHMENT_BYTES = 39 * 1024 * 1024;

// Idempotently join a user to the global feedback channel. The channel is
// surfaced as a pinned sidebar item, not via the membership UI, so every
// accessor self-joins on first touch (the per-channel WS gate and the message
// routes both hard-require membership). Returns true once the user is a member
// (false only if the channel hasn't been seeded yet).
export async function ensureFeedbackMembership(env: Env, userId: string): Promise<boolean> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO channel_members (channel_id, user_id, notifications)
     SELECT ?, ?, 'none' WHERE EXISTS (SELECT 1 FROM channels WHERE id = ?)`,
  ).bind(FEEDBACK_CHANNEL_ID, userId, FEEDBACK_CHANNEL_ID).run();
  const member = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL',
  ).bind(FEEDBACK_CHANNEL_ID, userId).first();
  return member != null;
}

// Instance label for the email subject. Prefer a configured custom origin and
// fall back to the product name.
function instanceLabel(env: Env): string {
  const origin = env.APP_ORIGIN?.split(',')[0]?.trim();
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      /* fall through */
    }
  }
  return 'Threads';
}

function base64EncodedSize(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

function toBase64(bytes: Uint8Array): string {
  // Modern Workers expose Uint8Array.prototype.toBase64(). Keep the chunked
  // fallback for the local test runtime and older workerd releases.
  const nativeToBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (nativeToBase64) return nativeToBase64.call(bytes);

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function loadEmailAttachments(
  env: Env,
  images: FeedbackImageAttachment[],
): Promise<{ attachments: ResendAttachment[]; omittedCount: number }> {
  const attachments: ResendAttachment[] = [];
  let encodedBytes = 0;
  let omittedCount = 0;

  for (const image of images) {
    if (!image.contentType.toLowerCase().startsWith('image/')) continue;

    const expectedSize = base64EncodedSize(image.sizeBytes);
    if (encodedBytes + expectedSize > MAX_RESEND_ATTACHMENT_BYTES) {
      omittedCount += 1;
      console.error('Feedback image omitted from email: attachment size limit exceeded', image.filename);
      continue;
    }

    try {
      const object = await env.UPLOADS.get(image.r2Key);
      if (!object) {
        omittedCount += 1;
        console.error('Feedback image missing from R2:', image.r2Key);
        continue;
      }

      const bytes = new Uint8Array(await object.arrayBuffer());
      const actualSize = base64EncodedSize(bytes.byteLength);
      if (encodedBytes + actualSize > MAX_RESEND_ATTACHMENT_BYTES) {
        omittedCount += 1;
        console.error('Feedback image omitted from email: attachment size limit exceeded', image.filename);
        continue;
      }

      attachments.push({ filename: image.filename, content: toBase64(bytes) });
      encodedBytes += actualSize;
    } catch (err) {
      omittedCount += 1;
      console.error('Feedback image could not be loaded:', image.r2Key, err);
    }
  }

  return { attachments, omittedCount };
}

export async function emailFeedback(
  env: Env,
  author: string,
  content: string,
  images: FeedbackImageAttachment[] = [],
): Promise<void> {
  // Best-effort: a mail or attachment failure must not affect the user's
  // message or the auto-reply. No-op unless both email delivery and an
  // instance-owned destination are explicitly configured.
  if (!env.RESEND_API_KEY || !env.FEEDBACK_EMAIL_TO) return;
  const from = env.FEEDBACK_EMAIL_FROM || 'onboarding@resend.dev';
  const to = env.FEEDBACK_EMAIL_TO;
  try {
    const { attachments, omittedCount } = await loadEmailAttachments(env, images);
    let text = content || 'Image feedback attached.';
    if (omittedCount > 0) {
      text += `\n\n${omittedCount} image attachment${omittedCount === 1 ? ' was' : 's were'} omitted from this email.`;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Threads Feedback <${from}>`,
        to: [to],
        reply_to: to,
        subject: `[${instanceLabel(env)}] New feedback from ${author}`,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    });
    if (!res.ok) {
      console.error('Feedback email failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('Feedback email error:', err);
  }
}

// Pick the next canned reply, rotating in order by how many the bot has already
// posted here (true round-robin; low-volume channel, so the COUNT is cheap).
async function nextReply(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND user_id = ? AND message_type = 'response'",
  ).bind(FEEDBACK_CHANNEL_ID, FEEDBACK_BOT_ID).first<{ n: number }>();
  return FEEDBACK_REPLIES[(row?.n ?? 0) % FEEDBACK_REPLIES.length];
}

// Entry point, called from handleSendMessage via ctx.waitUntil when a human posts
// in the feedback channel: email the operator, then post the canned acknowledgement.
export async function handleFeedbackMessage(
  env: Env,
  author: string,
  content: string,
  images: FeedbackImageAttachment[] = [],
  postAcknowledgement: (content: string) => Promise<void>,
): Promise<void> {
  await emailFeedback(env, author, content, images);
  await postAcknowledgement(await nextReply(env));
}
