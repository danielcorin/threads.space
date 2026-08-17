import type { Env, User } from './types.js';
import {
  CREDENTIAL_VERIFIER_VERSION,
  credentialId,
  credentialStorageKey,
  credentialVerifier,
  generateSessionToken,
} from './lib/credentials.js';
import { getCookie, errorResponse, serviceUnavailableResponse } from './utils.js';
import { parseApiTokenScopes, type ApiTokenScope } from './lib/api-token-policy.js';

export type { ApiTokenScope } from './lib/api-token-policy.js';

const PBKDF2_ITERATIONS = 100_000;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
const LAST_USED_WRITE_INTERVAL_SECONDS = 5 * 60;

export interface AuthCredential {
  kind: 'bearer' | 'session';
  id: string;
  scopes: ReadonlySet<ApiTokenScope> | null;
  expiresAt: number;
}

export interface AuthPrincipal {
  user: User;
  credential: AuthCredential;
}

type ExtractedCredential = { kind: AuthCredential['kind']; token: string };
type PreparedCredential = ExtractedCredential & { verifier: string; id: string };

function extractCredential(request: Request): ExtractedCredential | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return token ? { kind: 'bearer', token } : null;
  }
  const sessionToken = getSessionToken(request);
  return sessionToken ? { kind: 'session', token: sessionToken } : null;
}

export function getSessionToken(request: Request): string | null {
  return getCookie(request, '__Host-session') ?? getCookie(request, 'session');
}

async function prepareCredential(env: Env, extracted: ExtractedCredential): Promise<PreparedCredential> {
  const kind = extracted.kind === 'bearer' ? 'api_token' : 'session';
  const [verifier, id] = await Promise.all([
    credentialVerifier(env, kind, extracted.token),
    credentialId(extracted.token),
  ]);
  return { ...extracted, verifier, id };
}

function authUnavailable(cause: unknown): Response {
  console.warn(
    '[auth] credential lookup failed (serving 503):',
    cause instanceof Error ? cause.message : cause,
  );
  return serviceUnavailableResponse();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  const hash = new Uint8Array(bits);
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, storedHashHex] = stored.split(':');
  const saltBytes = saltHex?.match(/.{2}/g);
  if (!saltBytes || !storedHashHex) return false;
  const salt = new Uint8Array(saltBytes.map((b) => Number.parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hashHex, storedHashHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i];
  return result === 0;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = generateSessionToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_LIFETIME_SECONDS;
  const [id, verifier] = await Promise.all([
    credentialId(token),
    credentialVerifier(env, 'session', token),
  ]);
  await env.DB.prepare(
    `INSERT INTO sessions
      (token, user_id, expires_at, credential_id, token_verifier, verifier_version, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    credentialStorageKey(id),
    userId,
    expiresAt,
    id,
    verifier,
    CREDENTIAL_VERIFIER_VERSION,
    now,
  ).run();
  return token;
}

export async function authenticatePrincipal(
  request: Request,
  env: Env,
  requiredScope?: ApiTokenScope,
): Promise<AuthPrincipal | null> {
  const extracted = extractCredential(request);
  if (!extracted) return null;
  const credential = await prepareCredential(env, extracted);
  const principal = await lookupPrincipal(env, credential);
  if (!principal) return null;
  requireScope(principal, requiredScope);
  return principal;
}

/** Convenience wrapper for ordinary handlers that only need the user. */
export async function authenticate(
  request: Request,
  env: Env,
  requiredScope?: ApiTokenScope,
): Promise<User | null> {
  return (await authenticatePrincipal(request, env, requiredScope))?.user ?? null;
}

function requireScope(principal: AuthPrincipal, requiredScope?: ApiTokenScope): void {
  const scopes = principal.credential.scopes;
  if (!requiredScope || scopes === null || scopes.has(requiredScope)) return;
  throw errorResponse(`API token lacks required scope: ${requiredScope}`, 403);
}

type BearerAuthRow = User & {
  _credential_id: string;
  _token_scopes: string;
  _token_expires_at: number | null;
  _last_used_at: number | null;
};

type SessionAuthRow = User & {
  _credential_id: string;
  _session_expires_at: number;
  _last_used_at: number | null;
};

function bearerPrincipal(row: BearerAuthRow): AuthPrincipal {
  const { _credential_id, _token_scopes, _token_expires_at, _last_used_at: _, ...user } = row;
  return {
    user: user as User,
    credential: {
      kind: 'bearer',
      id: _credential_id,
      scopes: new Set(parseApiTokenScopes(_token_scopes)),
      expiresAt: _token_expires_at ?? Number.MAX_SAFE_INTEGER,
    },
  };
}

function sessionPrincipal(row: SessionAuthRow): AuthPrincipal {
  const { _credential_id, _session_expires_at, _last_used_at: _, ...user } = row;
  return {
    user: user as User,
    credential: {
      kind: 'session',
      id: _credential_id,
      scopes: null,
      expiresAt: _session_expires_at,
    },
  };
}

async function lookupPrincipal(env: Env, credential: PreparedCredential): Promise<AuthPrincipal | null> {
  try {
    return credential.kind === 'bearer'
      ? await lookupBearerPrincipal(env, credential)
      : await lookupSessionPrincipal(env, credential);
  } catch (error) {
    throw authUnavailable(error);
  }
}

async function lookupBearerPrincipal(env: Env, credential: PreparedCredential): Promise<AuthPrincipal | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT u.*, t.credential_id AS _credential_id, t.scopes AS _token_scopes,
            t.expires_at AS _token_expires_at, t.last_used_at AS _last_used_at
     FROM users u JOIN api_tokens t ON u.id = t.user_id
     WHERE t.token_verifier = ? AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > ?)`,
  ).bind(credential.verifier, now).first<BearerAuthRow>();

  if (!row) return null;
  if (row._last_used_at == null || row._last_used_at < now - LAST_USED_WRITE_INTERVAL_SECONDS) {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE credential_id = ?')
      .bind(now, row._credential_id)
      .run();
  }
  return bearerPrincipal(row);
}

async function lookupSessionPrincipal(env: Env, credential: PreparedCredential): Promise<AuthPrincipal | null> {
  const now = Math.floor(Date.now() / 1000);
  const idleCutoff = now - SESSION_IDLE_SECONDS;
  const row = await env.DB.prepare(
    `SELECT u.*, s.credential_id AS _credential_id, s.expires_at AS _session_expires_at,
            s.last_used_at AS _last_used_at
     FROM users u JOIN sessions s ON u.id = s.user_id
     WHERE s.token_verifier = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       AND (s.last_used_at IS NULL OR s.last_used_at > ?)`,
  ).bind(credential.verifier, now, idleCutoff).first<SessionAuthRow>();

  if (!row) return null;
  if (row._last_used_at == null || row._last_used_at < now - LAST_USED_WRITE_INTERVAL_SECONDS) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE credential_id = ?')
      .bind(now, row._credential_id)
      .run();
  }
  return sessionPrincipal(row);
}

export interface ChannelAuth {
  user: User;
  isMember: boolean;
  credential: AuthCredential;
}

export async function authenticateForChannel(
  request: Request,
  env: Env,
  channelId: string,
  requiredScope: ApiTokenScope = 'threads:read',
): Promise<ChannelAuth | null> {
  const principal = await authenticatePrincipal(request, env, requiredScope);
  if (!principal) return null;
  const membership = await env.DB.prepare(
    'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? AND left_at IS NULL',
  ).bind(channelId, principal.user.id).first();
  return { user: principal.user, credential: principal.credential, isMember: membership != null };
}

/** Revalidate a long-lived WebSocket credential before a state-changing action. */
export async function assertCredentialActive(env: Env, credential: AuthCredential): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (credential.expiresAt <= now) throw errorResponse('Credential expired', 401);
  const row = credential.kind === 'bearer'
    ? await env.DB.prepare(
      `SELECT 1 FROM api_tokens
       WHERE credential_id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(credential.id, now).first()
    : await env.DB.prepare(
      `SELECT 1 FROM sessions
       WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?
         AND (last_used_at IS NULL OR last_used_at > ?)`,
    ).bind(credential.id, now, now - SESSION_IDLE_SECONDS).first();
  if (!row) throw errorResponse('Credential revoked or expired', 401);
}

export function requireAuth(user: User | null): User {
  if (!user) throw errorResponse('Unauthorized', 401);
  return user;
}

export function requireAdminUser(user: User): void {
  if (!user.is_admin) throw errorResponse('Forbidden', 403);
}

/** Require an interactive session, or an explicitly-scoped admin automation token. */
export function requireAdminPrincipal(
  principal: AuthPrincipal,
  bearerScope?: ApiTokenScope,
): void {
  requireAdminUser(principal.user);
  if (principal.credential.kind === 'session') return;
  if (bearerScope && principal.credential.scopes?.has(bearerScope)) return;
  throw errorResponse('This administrative action requires an interactive session', 403);
}

export function requireInteractiveSession(principal: AuthPrincipal): void {
  if (principal.credential.kind !== 'session') {
    throw errorResponse('This security-sensitive action requires an interactive session', 403);
  }
}
