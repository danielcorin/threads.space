import type { Env } from '../types.js';
import { hashToken } from '../utils.js';

export type CredentialKind = 'api_token' | 'session';

export const CREDENTIAL_VERIFIER_VERSION = 1;
export const WEBHOOK_SECRET_KEY_VERSION = 1;

const encoder = new TextEncoder();
function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function masterSecret(env: Env): string {
  const value = env.CREDENTIAL_MASTER_KEY ?? env.INSTANCE_SECRET ?? env.ANALYTICS_HASH_SECRET;
  if (!value) throw new Error('INSTANCE_SECRET is not configured');
  return value;
}

async function hmac(env: Env, purpose: string, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(`threads:${purpose}:v1\0${value}`));
}

export async function credentialVerifier(
  env: Env,
  kind: CredentialKind,
  rawToken: string,
): Promise<string> {
  return toHex(await hmac(env, `credential:${kind}`, rawToken));
}

export async function credentialId(rawToken: string): Promise<string> {
  return hashToken(rawToken);
}

/** Non-secret primary-key value persisted instead of the raw credential. */
export function credentialStorageKey(id: string): string {
  return `id:${id}`;
}

export function tokenHint(rawToken: string): string {
  return rawToken.slice(-6);
}

function randomBase64Url(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateApiToken(): string {
  return `thr_pat_v2_${randomBase64Url(32)}`;
}

export function generateSessionToken(): string {
  return randomBase64Url(32);
}

/**
 * Derive an outbound webhook signing secret without persisting it. The value is
 * returned once at webhook creation and can always be recomputed by the Worker.
 */
export async function deriveWebhookSecret(
  env: Env,
  webhookId: string,
  keyVersion = WEBHOOK_SECRET_KEY_VERSION,
): Promise<string> {
  if (keyVersion !== WEBHOOK_SECRET_KEY_VERSION) {
    throw new Error(`Unsupported webhook secret key version: ${keyVersion}`);
  }
  return toHex(await hmac(env, 'webhook-signing-secret', webhookId));
}
