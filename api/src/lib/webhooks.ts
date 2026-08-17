import type { Env } from '../types.js';
import type { AuthPrincipal } from '../auth.js';
import {
  deriveWebhookSecret,
  WEBHOOK_SECRET_KEY_VERSION,
} from './credentials.js';
import { generateId } from '../utils.js';

const MAX_WEBHOOK_URLS_PER_TOKEN = 10;
const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 6;
const WEBHOOK_TIMEOUT_MS = 8000;
const WEBHOOK_DRAIN_LIMIT = 50;

export interface WebhookRecord {
  id: string;
  user_id: string;
  token: string;
  token_id: string;
  url: string;
  secret: string;
  active: number;
  failure_count: number;
  last_status: number | null;
  last_delivered_at: number | null;
  disabled_reason: string | null;
  created_at: number;
}

export interface PublicWebhook {
  id: string;
  token_id: string;
  token_name: string;
  url: string;
  active: boolean;
  failure_count: number;
  last_status: number | null;
  last_delivered_at: number | null;
  disabled_reason: string | null;
  created_at: number;
}

export interface CreatedWebhook {
  id: string;
  url: string;
  secret: string;
}

export interface PreparedWebhook {
  id: string;
  userId: string;
  token: string;
  tokenId: string;
  url: string;
  secret: string;
  secretKeyVersion: number;
}

export interface ResolveBotRecipientsOptions {
  senderId?: string | null;
  senderRole?: string | null;
  mentionedUserIds?: string[];
  breakerTripped?: boolean;
}

interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  user_id: string;
  url: string;
  secret: string;
  event_type: string;
  channel_id: string | null;
  payload: string;
  attempt_count: number;
}

interface StoredWebhookSecret {
  id: string;
  secret: string;
  secret_key_version: number | null;
}

async function resolveStoredWebhookSecret(env: Env, row: StoredWebhookSecret): Promise<string> {
  if (row.secret_key_version != null) {
    return deriveWebhookSecret(env, row.id, row.secret_key_version);
  }
  return row.secret;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 192 && b === 0 ||
    a === 198 && (b === 18 || b === 19) ||
    a >= 224
  );
}

export interface ValidateWebhookUrlOptions {
  // Local-dev only: allow http and localhost/private targets (see Env.WEBHOOK_ALLOW_INSECURE_URLS).
  allowInsecure?: boolean;
}

/** True when the env opts into the local-dev insecure-URL escape hatch. */
export function webhooksAllowInsecure(env: Env): boolean {
  return env.WEBHOOK_ALLOW_INSECURE_URLS === 'true';
}

export function validateWebhookUrl(
  url: string,
  options: ValidateWebhookUrlOptions = {},
): { ok: true; url: string } | { ok: false; error: string } {
  const { allowInsecure = false } = options;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'url must be a valid URL' };
  }

  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    return { ok: false, error: 'webhook URLs must use https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'webhook URLs must not include credentials' };
  }

  // SSRF guard: block localhost/private/internal targets. Skipped only when the
  // env explicitly opts in (local dev), so a webhook can hit a same-machine receiver.
  if (!allowInsecure) {
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return { ok: false, error: 'webhook host is not allowed' };
    }
    if (!hostname.includes('.') && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
      return { ok: false, error: 'webhook host must be a public hostname' };
    }
    if (hostname.includes(':')) {
      return { ok: false, error: 'IPv6 literal webhook URLs are not allowed' };
    }
    if (isPrivateIpv4(hostname)) {
      return { ok: false, error: 'webhook host is not allowed' };
    }
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export async function prepareWebhooksForToken(
  env: Env,
  userId: string,
  token: string,
  tokenId: string,
  urls: string[] | undefined,
  options: ValidateWebhookUrlOptions = {},
): Promise<PreparedWebhook[]> {
  if (urls === undefined) return [];
  if (!Array.isArray(urls)) {
    throw new Error('webhook_urls must be an array of URLs');
  }
  if (urls.length > MAX_WEBHOOK_URLS_PER_TOKEN) {
    throw new Error(`webhook_urls may contain at most ${MAX_WEBHOOK_URLS_PER_TOKEN} URLs`);
  }

  const seen = new Set<string>();
  const prepared: PreparedWebhook[] = [];
  for (const candidate of urls) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('webhook_urls must contain URL strings');
    }
    const validated = validateWebhookUrl(candidate.trim(), options);
    if (!validated.ok) throw new Error(validated.error);
    if (seen.has(validated.url)) continue;
    seen.add(validated.url);
    const id = `wh_${generateId()}`;
    const secret = await deriveWebhookSecret(env, id);
    prepared.push({
      id,
      userId,
      token,
      tokenId,
      url: validated.url,
      secret,
      secretKeyVersion: WEBHOOK_SECRET_KEY_VERSION,
    });
  }
  return prepared;
}

export function webhookInsertStatement(env: Env, webhook: PreparedWebhook): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO webhooks
      (id, user_id, token, token_id, url, secret, secret_key_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    webhook.id,
    webhook.userId,
    webhook.token,
    webhook.tokenId,
    webhook.url,
    'derived',
    webhook.secretKeyVersion,
  );
}

export function createdWebhookResponse(webhook: PreparedWebhook): CreatedWebhook {
  return { id: webhook.id, url: webhook.url, secret: webhook.secret };
}

export async function listWebhooks(env: Env, userId: string): Promise<PublicWebhook[]> {
  const { results } = await env.DB.prepare(
    `SELECT w.*, t.name AS token_name
     FROM webhooks w
     JOIN api_tokens t ON t.credential_id = w.token_id
     WHERE w.user_id = ?
     ORDER BY w.created_at DESC`,
  ).bind(userId).all<WebhookRecord & { token_name: string }>();

  return (results ?? []).map((row) => ({
    id: row.id,
    token_id: row.token_id,
    token_name: row.token_name,
    url: row.url,
    active: row.active === 1,
    failure_count: row.failure_count,
    last_status: row.last_status,
    last_delivered_at: row.last_delivered_at,
    disabled_reason: row.disabled_reason,
    created_at: row.created_at,
  }));
}

export async function resolveWebhookTokenForRequest(
  principal: AuthPrincipal,
  env: Env,
  userId: string,
  tokenId?: string,
): Promise<{ token: string; credential_id: string; name: string } | null> {
  if (principal.credential.kind === 'bearer') {
    const row = await env.DB.prepare(
      `SELECT token, credential_id, name FROM api_tokens
       WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(principal.credential.id, userId).first<{ token: string; credential_id: string; name: string }>();
    return row ?? null;
  }

  const { results } = await env.DB.prepare(
    `SELECT token, credential_id, name FROM api_tokens
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(userId).all<{ token: string; credential_id: string; name: string }>();
  const tokens = results ?? [];
  if (tokenId) {
    const found = tokens.find((token) => token.credential_id === tokenId);
    if (found) return found;
    return null;
  }
  if (tokens.length === 1) return tokens[0];
  throw new Error(tokens.length === 0 ? 'No API token exists for this user' : 'token_id is required when the user has multiple API tokens');
}

export async function createWebhookForToken(env: Env, userId: string, token: string, tokenId: string, url: string): Promise<CreatedWebhook> {
  const [webhook] = await prepareWebhooksForToken(env, userId, token, tokenId, [url], { allowInsecure: webhooksAllowInsecure(env) });
  await webhookInsertStatement(env, webhook).run();
  return createdWebhookResponse(webhook);
}

export async function deleteWebhook(env: Env, userId: string, webhookId: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    'SELECT id FROM webhooks WHERE id = ? AND user_id = ?',
  ).bind(webhookId, userId).first<{ id: string }>();
  if (!existing) return false;
  await env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').bind(webhookId, userId).run();
  return true;
}

export async function resolveBotRecipients(
  env: Env,
  channelId: string,
  options: ResolveBotRecipientsOptions = {},
): Promise<string[]> {
  if (options.breakerTripped) return [];
  const { results } = await env.DB.prepare(
    `SELECT u.id
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = ? AND cm.left_at IS NULL AND u.role = 'bot'
     ORDER BY u.id`,
  ).bind(channelId).all<{ id: string }>();

  const mentioned = new Set(options.mentionedUserIds ?? []);
  return (results ?? [])
    .map((row) => row.id)
    .filter((botId) => botId !== options.senderId)
    .filter((botId) => options.senderRole === 'bot' ? mentioned.has(botId) : true);
}

export async function dispatchWebhookEvent(
  env: Env,
  channelId: string,
  payload: Record<string, unknown>,
  options: ResolveBotRecipientsOptions & { extraBotRecipientIds?: string[] },
): Promise<void> {
  const eventType = typeof payload.type === 'string' ? payload.type : null;
  if (!eventType) return;

  const recipientUserIds = [
    ...new Set([
      ...await resolveBotRecipients(env, channelId, options),
      ...(options.extraBotRecipientIds ?? []).filter((id) => id !== options.senderId),
    ]),
  ];
  if (!recipientUserIds.length) return;

  const placeholders = recipientUserIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, url, secret, secret_key_version
     FROM webhooks
     WHERE active = 1 AND user_id IN (${placeholders})
     ORDER BY created_at ASC`,
  ).bind(...recipientUserIds).all<{
    id: string;
    user_id: string;
    url: string;
    secret: string;
    secret_key_version: number | null;
  }>();
  if (!results?.length) return;

  const seen = new Set<string>();
  const timestamp = nowSeconds();
  const deliveries: WebhookDeliveryRow[] = [];
  for (const webhook of results) {
    const key = `${webhook.user_id}\n${webhook.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const eventId = `evt_${generateId()}`;
    const body = JSON.stringify({
      event_id: eventId,
      type: eventType,
      timestamp,
      bot_user_id: webhook.user_id,
      channel_id: channelId,
      data: payload,
    });
    deliveries.push({
      id: eventId,
      webhook_id: webhook.id,
      user_id: webhook.user_id,
      url: webhook.url,
      secret: await resolveStoredWebhookSecret(env, webhook),
      event_type: eventType,
      channel_id: channelId,
      payload: body,
      attempt_count: 0,
    });
  }
  if (!deliveries.length) return;

  await env.DB.batch(deliveries.map((delivery) => env.DB.prepare(
    `INSERT INTO webhook_deliveries
      (id, webhook_id, event_type, channel_id, payload, status, attempt_count, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).bind(delivery.id, delivery.webhook_id, delivery.event_type, delivery.channel_id, delivery.payload, timestamp)));

  await Promise.allSettled(deliveries.map((delivery) => attemptWebhookDelivery(env, delivery)));
}

async function sendWebhookPost(row: WebhookDeliveryRow, allowInsecure: boolean): Promise<number> {
  const validation = validateWebhookUrl(row.url, { allowInsecure });
  if (!validation.ok) throw new Error(validation.error);

  const parsed = JSON.parse(row.payload) as { event_id: string; timestamp: number };
  const signature = await hmacSha256Hex(row.secret, `${parsed.timestamp}.${row.payload}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(validation.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Threads-Webhooks/1.0',
        'X-Threads-Event-Id': parsed.event_id,
        'X-Threads-Timestamp': String(parsed.timestamp),
        'X-Threads-Signature': `sha256=${signature}`,
      },
      body: row.payload,
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

function nextBackoffSeconds(attemptCount: number): number {
  return Math.min(60 * 60, 2 ** Math.max(0, attemptCount - 1) * 60);
}

async function recordDeliverySuccess(env: Env, row: WebhookDeliveryRow, status: number): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'delivered', attempt_count = ?, next_attempt_at = NULL, last_status = ?
       WHERE id = ?`,
    ).bind(row.attempt_count + 1, status, row.id),
    env.DB.prepare(
      `UPDATE webhooks
       SET failure_count = 0, last_status = ?, last_delivered_at = ?, disabled_reason = NULL
       WHERE id = ?`,
    ).bind(status, now, row.webhook_id),
  ]);
}

async function recordDeliveryFailure(env: Env, row: WebhookDeliveryRow, status: number | null): Promise<void> {
  const attemptCount = row.attempt_count + 1;
  const now = nowSeconds();
  if (attemptCount >= MAX_WEBHOOK_DELIVERY_ATTEMPTS) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE webhook_deliveries
         SET status = 'dead', attempt_count = ?, next_attempt_at = NULL, last_status = ?
         WHERE id = ?`,
      ).bind(attemptCount, status, row.id),
      env.DB.prepare(
        `UPDATE webhooks
         SET active = 0,
             failure_count = failure_count + 1,
             last_status = ?,
             disabled_reason = 'retry_budget_exhausted'
         WHERE id = ?`,
      ).bind(status, row.webhook_id),
    ]);
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'pending', attempt_count = ?, next_attempt_at = ?, last_status = ?
       WHERE id = ?`,
    ).bind(attemptCount, now + nextBackoffSeconds(attemptCount), status, row.id),
    env.DB.prepare(
      `UPDATE webhooks
       SET failure_count = failure_count + 1, last_status = ?
       WHERE id = ?`,
    ).bind(status, row.webhook_id),
  ]);
}

async function attemptWebhookDelivery(env: Env, row: WebhookDeliveryRow): Promise<void> {
  try {
    const status = await sendWebhookPost(row, webhooksAllowInsecure(env));
    if (status >= 200 && status < 300) {
      await recordDeliverySuccess(env, row, status);
    } else {
      await recordDeliveryFailure(env, row, status);
    }
  } catch (err) {
    console.error(`Webhook delivery ${row.id} failed:`, err);
    await recordDeliveryFailure(env, row, null);
  }
}

export async function drainWebhookDeliveries(env: Env, ctx?: ExecutionContext): Promise<number> {
  const now = nowSeconds();
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, w.id AS webhook_secret_id, w.user_id, w.url, w.secret,
            w.secret_key_version,
            d.event_type, d.channel_id, d.payload, d.attempt_count
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending'
       AND w.active = 1
       AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
     ORDER BY d.created_at ASC
     LIMIT ?`,
  ).bind(now, WEBHOOK_DRAIN_LIMIT).all<WebhookDeliveryRow & StoredWebhookSecret & { webhook_secret_id: string }>();

  const hydrated = await Promise.all((results ?? []).map(async (row) => ({
    ...row,
    secret: await resolveStoredWebhookSecret(env, { ...row, id: row.webhook_secret_id }),
  })));
  const work = Promise.allSettled(hydrated.map((row) => attemptWebhookDelivery(env, row)));
  if (ctx) ctx.waitUntil(work);
  else await work;

  await pruneWebhookDeliveries(env);
  return results?.length ?? 0;
}

export async function pruneWebhookDeliveries(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(
    `DELETE FROM webhook_deliveries
     WHERE (status = 'delivered' AND created_at < ?)
        OR (status = 'dead' AND created_at < ?)`,
  ).bind(now - 24 * 60 * 60, now - 7 * 24 * 60 * 60).run();
}
