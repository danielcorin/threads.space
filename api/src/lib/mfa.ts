import type { Env } from '../types.js';
import { generateToken, getCookie, hashToken } from '../utils.js';

export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const MFA_CHALLENGE_TTL_SECONDS = 10 * 60;
export const MFA_ENROLLMENT_TTL_SECONDS = 10 * 60;
export const MFA_CHALLENGE_ATTEMPTS = 5;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();

export type MfaChallengePurpose = 'verify' | 'enroll';

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
};

export type MfaSetup = {
  secret: string;
  otpauthUri: string;
};

type MfaCredentialRow = {
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  last_used_step: number | null;
  enabled_at: number;
};

type MfaChallengeRow = {
  token_hash: string;
  user_id: string;
  purpose: MfaChallengePurpose;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  attempts_remaining: number;
  expires_at: number;
};

type MfaEnrollmentRow = {
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  expires_at: number;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Uint8Array {
  const normalized = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid Base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

export function generateTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}

export function totpProvisioningUri(secret: string, issuer: string, accountName: string): string {
  const cleanIssuer = issuer.trim() || 'Threads';
  const label = `${cleanIssuer}:${accountName}`;
  const params = new URLSearchParams({
    secret,
    issuer: cleanIssuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function mfaProvisioningIssuer(env: Env): string {
  const origin = env.APP_ORIGIN?.trim();
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      // Fall back to the product name for malformed local-development config.
    }
  }
  return 'Threads';
}

export function verifiedEmailForMfa(
  user: { email?: string | null; email_verified_at?: number | null },
): string | null {
  const email = user.email?.trim();
  return email && user.email_verified_at != null ? email : null;
}

export async function generateTotpCode(secret: string, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = BigInt(step);
  for (let index = counter.length - 1; index >= 0; index--) {
    counter[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function equalCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function matchTotpStep(
  secret: string,
  code: string,
  options: { now?: number; lastUsedStep?: number | null; window?: number } = {},
): Promise<number | null> {
  const normalizedCode = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) return null;
  const currentStep = Math.floor((options.now ?? nowSeconds()) / TOTP_PERIOD_SECONDS);
  const lastUsedStep = options.lastUsedStep ?? null;
  const window = options.window ?? TOTP_WINDOW;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = currentStep + offset;
    if (candidate < 0 || (lastUsedStep !== null && candidate <= lastUsedStep)) continue;
    if (equalCode(await generateTotpCode(secret, candidate), normalizedCode)) return candidate;
  }
  return null;
}

function mfaKeyBytes(env: Env): Uint8Array {
  const configured = env.MFA_ENCRYPTION_KEY ?? env.INSTANCE_SECRET;
  if (!configured) throw new Error('INSTANCE_SECRET is not configured');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(configured);
  } catch {
    bytes = encoder.encode(configured);
  }
  if (bytes.byteLength < 32) throw new Error('INSTANCE_SECRET must contain at least 32 bytes');
  const key = bytes.slice(0, 32);
  // Keep the AES key distinct from the HMAC key even though both are rooted in
  // the same instance secret. This derivation is stable for the lifetime of the
  // instance and avoids another required deploy-time secret.
  const label = encoder.encode('threads:mfa:aes-gcm:v1');
  for (let i = 0; i < key.length; i++) key[i] ^= label[i % label.length];
  return key;
}

export function hasMfaEncryptionKey(env: Env): boolean {
  try {
    mfaKeyBytes(env);
    return true;
  } catch {
    return false;
  }
}

async function aesKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', mfaKeyBytes(env), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function secretAad(userId: string): Uint8Array {
  return encoder.encode(`threads:mfa-secret:v1\0${userId}`);
}

export async function encryptMfaSecret(env: Env, userId: string, secret: string): Promise<EncryptedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: secretAad(userId) },
    await aesKey(env),
    encoder.encode(secret),
  );
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv) };
}

export async function decryptMfaSecret(
  env: Env,
  userId: string,
  encrypted: EncryptedSecret,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(encrypted.iv),
      additionalData: secretAad(userId),
    },
    await aesKey(env),
    fromBase64Url(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function setMfaChallengeCookie(token: string, domain?: string): string {
  const domainPart = domain ? `; Domain=${domain}` : '';
  const name = domain ? 'mfa_challenge' : '__Host-mfa_challenge';
  return `${name}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${domainPart}; Max-Age=${MFA_CHALLENGE_TTL_SECONDS}`;
}

export function clearMfaChallengeCookie(domain?: string): string {
  const domainPart = domain ? `; Domain=${domain}` : '';
  const name = domain ? 'mfa_challenge' : '__Host-mfa_challenge';
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/${domainPart}; Max-Age=0`;
}

export function getMfaChallengeToken(request: Request): string | null {
  return getCookie(request, '__Host-mfa_challenge') ?? getCookie(request, 'mfa_challenge');
}

export async function isMfaEnabled(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM mfa_credentials WHERE user_id = ?')
    .bind(userId).first();
  return row != null;
}

export async function workspaceRequiresMfa(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT require_mfa_for_humans FROM workspace_security WHERE id = 1',
  ).first<{ require_mfa_for_humans: number }>();
  return row?.require_mfa_for_humans === 1;
}

export async function createMfaLoginChallenge(
  env: Env,
  user: { id: string; email?: string | null; email_verified_at?: number | null },
  purpose: MfaChallengePurpose,
): Promise<{ token: string; setup?: MfaSetup }> {
  if (!hasMfaEncryptionKey(env)) throw new Error('MFA encryption key is not configured');
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = nowSeconds() + MFA_CHALLENGE_TTL_SECONDS;
  let encrypted: EncryptedSecret | null = null;
  let setup: MfaSetup | undefined;
  if (purpose === 'enroll') {
    const email = verifiedEmailForMfa(user);
    if (!email) throw new Error('A verified email is required for authenticator enrollment');
    const secret = generateTotpSecret();
    encrypted = await encryptMfaSecret(env, user.id, secret);
    setup = {
      secret,
      otpauthUri: totpProvisioningUri(secret, mfaProvisioningIssuer(env), email),
    };
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').bind(user.id),
    env.DB.prepare(
      `INSERT INTO mfa_challenges
        (token_hash, user_id, purpose, secret_ciphertext, secret_iv,
         attempts_remaining, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tokenHash,
      user.id,
      purpose,
      encrypted?.ciphertext ?? null,
      encrypted?.iv ?? null,
      MFA_CHALLENGE_ATTEMPTS,
      expiresAt,
    ),
  ]);
  return { token, setup };
}

async function rejectChallengeAttempt(env: Env, row: MfaChallengeRow): Promise<'invalid' | 'exhausted'> {
  if (row.attempts_remaining <= 1) {
    await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?')
      .bind(row.token_hash).run();
    return 'exhausted';
  }
  await env.DB.prepare(
    'UPDATE mfa_challenges SET attempts_remaining = attempts_remaining - 1 WHERE token_hash = ?',
  ).bind(row.token_hash).run();
  return 'invalid';
}

export type CompleteMfaChallengeResult =
  | { ok: true; userId: string; purpose: MfaChallengePurpose }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' | 'exhausted' | 'unavailable' | 'email_unverified' };

export async function completeMfaLoginChallenge(
  request: Request,
  env: Env,
  code: string,
): Promise<CompleteMfaChallengeResult> {
  const token = getMfaChallengeToken(request);
  if (!token) return { ok: false, reason: 'missing' };
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?')
    .bind(tokenHash).first<MfaChallengeRow>();
  if (!row) return { ok: false, reason: 'missing' };
  if (row.expires_at <= nowSeconds()) {
    await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run();
    return { ok: false, reason: 'expired' };
  }
  if (!hasMfaEncryptionKey(env)) return { ok: false, reason: 'unavailable' };

  if (row.purpose === 'enroll') {
    if (!row.secret_ciphertext || !row.secret_iv) return { ok: false, reason: 'unavailable' };
    const identity = await env.DB.prepare(
      'SELECT email, email_verified_at FROM users WHERE id = ?',
    ).bind(row.user_id).first<{ email: string | null; email_verified_at: number | null }>();
    if (!identity || !verifiedEmailForMfa(identity)) {
      await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run();
      return { ok: false, reason: 'email_unverified' };
    }
    const existing = await isMfaEnabled(env, row.user_id);
    if (existing) {
      await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run();
      return { ok: false, reason: 'invalid' };
    }
    const secret = await decryptMfaSecret(env, row.user_id, {
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
    });
    const matchedStep = await matchTotpStep(secret, code);
    if (matchedStep === null) return { ok: false, reason: await rejectChallengeAttempt(env, row) };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mfa_credentials
          (user_id, secret_ciphertext, secret_iv, last_used_step)
         VALUES (?, ?, ?, ?)`,
      ).bind(row.user_id, row.secret_ciphertext, row.secret_iv, matchedStep),
      env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash),
    ]);
    return { ok: true, userId: row.user_id, purpose: row.purpose };
  }

  const credential = await env.DB.prepare('SELECT * FROM mfa_credentials WHERE user_id = ?')
    .bind(row.user_id).first<MfaCredentialRow>();
  if (!credential) return { ok: false, reason: 'unavailable' };
  const secret = await decryptMfaSecret(env, row.user_id, {
    ciphertext: credential.secret_ciphertext,
    iv: credential.secret_iv,
  });
  const matchedStep = await matchTotpStep(secret, code, { lastUsedStep: credential.last_used_step });
  if (matchedStep === null) return { ok: false, reason: await rejectChallengeAttempt(env, row) };
  const update = await env.DB.prepare(
    `UPDATE mfa_credentials SET last_used_step = ?, updated_at = unixepoch()
     WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).bind(matchedStep, row.user_id, matchedStep).run();
  if ((update.meta.changes ?? 0) !== 1) return { ok: false, reason: await rejectChallengeAttempt(env, row) };
  await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').bind(tokenHash).run();
  return { ok: true, userId: row.user_id, purpose: row.purpose };
}

export async function cancelMfaLoginChallenge(request: Request, env: Env): Promise<void> {
  const token = getMfaChallengeToken(request);
  if (!token) return;
  await env.DB.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?')
    .bind(await hashToken(token)).run();
}

export async function startMfaEnrollment(
  env: Env,
  user: { id: string; email?: string | null; email_verified_at?: number | null },
): Promise<MfaSetup & { expiresAt: number }> {
  if (!hasMfaEncryptionKey(env)) throw new Error('MFA encryption key is not configured');
  const email = verifiedEmailForMfa(user);
  if (!email) throw new Error('A verified email is required for authenticator enrollment');
  const secret = generateTotpSecret();
  const encrypted = await encryptMfaSecret(env, user.id, secret);
  const expiresAt = nowSeconds() + MFA_ENROLLMENT_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO mfa_enrollments
      (user_id, secret_ciphertext, secret_iv, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       secret_ciphertext = excluded.secret_ciphertext,
       secret_iv = excluded.secret_iv,
       expires_at = excluded.expires_at,
       created_at = unixepoch()`,
  ).bind(user.id, encrypted.ciphertext, encrypted.iv, expiresAt).run();
  return {
    secret,
    otpauthUri: totpProvisioningUri(secret, mfaProvisioningIssuer(env), email),
    expiresAt,
  };
}

export async function confirmMfaEnrollment(env: Env, userId: string, code: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT * FROM mfa_enrollments WHERE user_id = ?')
    .bind(userId).first<MfaEnrollmentRow>();
  if (!row || row.expires_at <= nowSeconds()) {
    if (row) await env.DB.prepare('DELETE FROM mfa_enrollments WHERE user_id = ?').bind(userId).run();
    return false;
  }
  const secret = await decryptMfaSecret(env, userId, {
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
  });
  const matchedStep = await matchTotpStep(secret, code);
  if (matchedStep === null) return false;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mfa_credentials
        (user_id, secret_ciphertext, secret_iv, last_used_step)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(userId, row.secret_ciphertext, row.secret_iv, matchedStep),
    env.DB.prepare('DELETE FROM mfa_enrollments WHERE user_id = ?').bind(userId),
  ]);
  return true;
}

export async function verifyAndConsumeUserMfaCode(
  env: Env,
  userId: string,
  code: string,
): Promise<boolean> {
  const credential = await env.DB.prepare('SELECT * FROM mfa_credentials WHERE user_id = ?')
    .bind(userId).first<MfaCredentialRow>();
  if (!credential || !hasMfaEncryptionKey(env)) return false;
  const secret = await decryptMfaSecret(env, userId, {
    ciphertext: credential.secret_ciphertext,
    iv: credential.secret_iv,
  });
  const matchedStep = await matchTotpStep(secret, code, { lastUsedStep: credential.last_used_step });
  if (matchedStep === null) return false;
  const update = await env.DB.prepare(
    `UPDATE mfa_credentials SET last_used_step = ?, updated_at = unixepoch()
     WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
  ).bind(matchedStep, userId, matchedStep).run();
  return (update.meta.changes ?? 0) === 1;
}

export async function removeMfaForUser(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM mfa_enrollments WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM mfa_credentials WHERE user_id = ?').bind(userId),
  ]);
}
