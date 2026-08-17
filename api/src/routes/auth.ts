import type { Env, User } from '../types.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  authenticatePrincipal,
  getSessionToken,
  requireInteractiveSession,
} from '../auth.js';
import { logAppEvent } from '../lib/observability.js';
import { errorResponse, setSessionCookie, clearSessionCookie, clearLegacySessionCookie, generateId, readJsonObject } from '../utils.js';
import { credentialId, credentialVerifier } from '../lib/credentials.js';
import {
  disconnectCredentialConnections,
  disconnectCredentialsForUser,
  sessionCredentialIdsForUser,
} from '../lib/credential-connections.js';
import {
  clearMfaChallengeCookie,
  createMfaLoginChallenge,
  hasMfaEncryptionKey,
  isMfaEnabled,
  setMfaChallengeCookie,
  workspaceRequiresMfa,
} from '../lib/mfa.js';

/**
 * Simple rate limiter: max attempts per window per IP.
 *
 * NOTE: this map is per-isolate — every Workers isolate starts empty, so a
 * distributed attacker (or an unlucky isolate recycle) isn't reliably
 * throttled. It's a best-effort speed bump; PBKDF2-100k is the real cost.
 */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAP_MAX_ENTRIES = 10_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  // Bound memory: sweep expired entries when the map gets large.
  if (loginAttempts.size > LOGIN_MAP_MAX_ENTRIES) {
    for (const [k, v] of loginAttempts) {
      if (now >= v.resetAt) loginAttempts.delete(k);
    }
  }
  const entry = loginAttempts.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count++;
    return { allowed: true };
  }

  loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  return { allowed: true };
}

function clearRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Claim a freshly-deployed instance by signing in as `admin` with the instance
 * secret. The INSERT is conditional, so concurrent first requests cannot create
 * two owners. Once any human account exists this path is permanently closed.
 */
async function bootstrapFirstAdmin(
  env: Env,
  username: string,
  password: string,
): Promise<(User & { password_hash: string }) | null> {
  if (username !== 'admin' || !env.INSTANCE_SECRET
    || !constantTimeEqual(password, env.INSTANCE_SECRET)) return null;

  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users
      (id, username, password_hash, display_name, role, is_admin)
     SELECT ?, 'admin', ?, 'Admin', 'human', 1
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'human')`,
  ).bind(generateId(), passwordHash).run();

  return env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind('admin').first<User & { password_hash: string }>();
}

export function clearSuccessfulLoginRateLimit(request: Request, env: Env): void {
  if (env.ENVIRONMENT !== 'production') return;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  if (ip) clearRateLimit(ip);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  // Rate limit by IP (CF-Connecting-IP in production, X-Forwarded-For as fallback)
  // Only enforce in production — local dev and tests don't have real IPs
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  if (ip && env.ENVIRONMENT === 'production') {
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      logAppEvent(env, 'threads.auth.login', {
        outcome: 'rate_limited',
        reason: 'too_many_attempts',
        auth_method: 'password',
      });
      return errorResponse(`Too many login attempts. Try again in ${rateCheck.retryAfterSeconds} seconds.`, 429);
    }
  }

  const { username, password } = await readJsonObject<{ username: string; password: string }>(request);
  if (!username || !password) {
    logAppEvent(env, 'threads.auth.login', {
      outcome: 'rejected',
      reason: 'missing_credentials',
      auth_method: 'password',
    });
    return errorResponse('Username and password required');
  }

  let user = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username).first<User & { password_hash: string }>();
  if (!user) user = await bootstrapFirstAdmin(env, username, password);
  if (!user) {
    logAppEvent(env, 'threads.auth.login', {
      outcome: 'failure',
      reason: 'invalid_credentials',
      auth_method: 'password',
    });
    return errorResponse('Invalid credentials', 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    logAppEvent(env, 'threads.auth.login', {
      outcome: 'failure',
      reason: 'invalid_credentials',
      auth_method: 'password',
    });
    return errorResponse('Invalid credentials', 401);
  }

  if (user.role !== 'bot') {
    const [mfaEnabled, mfaRequired] = await Promise.all([
      isMfaEnabled(env, user.id),
      workspaceRequiresMfa(env),
    ]);
    if (mfaEnabled || mfaRequired) {
      if (!mfaEnabled && (!user.email || user.email_verified_at == null)) {
        return errorResponse('Verify your recovery email before setting up authenticator MFA', 403);
      }
      if (!hasMfaEncryptionKey(env)) {
        return errorResponse('Authenticator verification is temporarily unavailable', 503);
      }
      const purpose = mfaEnabled ? 'verify' : 'enroll';
      const challenge = await createMfaLoginChallenge(env, user, purpose);
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', setMfaChallengeCookie(challenge.token, env.COOKIE_DOMAIN));
      headers.append('Set-Cookie', clearSessionCookie(env.COOKIE_DOMAIN));
      if (!env.COOKIE_DOMAIN) headers.append('Set-Cookie', clearLegacySessionCookie());
      logAppEvent(env, 'threads.auth.login', {
        outcome: 'mfa_required',
        auth_method: 'password',
        actor_id: user.id,
        actor_role: user.role || 'user',
        actor_is_admin: user.is_admin === 1,
        mfa_purpose: purpose,
      });
      return new Response(JSON.stringify({
        next: purpose === 'verify' ? 'verify_mfa' : 'enroll_mfa',
        ...(challenge.setup ? { setup: challenge.setup } : {}),
      }), { status: 200, headers });
    }
  }
  clearSuccessfulLoginRateLimit(request, env);
  const token = await createSession(env, user.id);
  const { password_hash: _, email_normalized: _emailNormalized, ...safeUser } = user;
  logAppEvent(env, 'threads.auth.login', {
    outcome: 'success',
    auth_method: 'password',
    actor_id: user.id,
    actor_role: user.role || 'user',
    actor_is_admin: user.is_admin === 1,
  });

  return new Response(JSON.stringify({ ...safeUser, next: 'complete' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token, undefined, env.COOKIE_DOMAIN),
    },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  // Delete session from DB before clearing cookie
  const sessionToken = getSessionToken(request);
  let outcome = 'no_session';
  if (sessionToken) {
    const verifier = await credentialVerifier(env, 'session', sessionToken);
    const id = await credentialId(sessionToken);
    const session = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE token_verifier = ?',
    ).bind(verifier).first<{ user_id: string }>();
    const result = await env.DB.prepare('DELETE FROM sessions WHERE token_verifier = ?')
      .bind(verifier).run();
    if ((result.meta.changes ?? 0) > 0 && session) {
      await disconnectCredentialConnections(env, session.user_id, id, 'Logged out');
    }
    outcome = (result.meta.changes ?? 0) > 0 ? 'success' : 'invalid_session';
  }
  logAppEvent(env, 'threads.auth.logout', {
    outcome,
    auth_method: 'session_cookie',
  });

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearSessionCookie(env.COOKIE_DOMAIN));
  headers.append('Set-Cookie', clearMfaChallengeCookie(env.COOKIE_DOMAIN));
  if (!env.COOKIE_DOMAIN) headers.append('Set-Cookie', clearLegacySessionCookie());
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}

export async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const principal = await authenticatePrincipal(request, env, 'threads:write');
  if (!principal) return errorResponse('Unauthorized', 401);
  requireInteractiveSession(principal);
  const user = principal.user;

  const { currentPassword, newPassword } = await readJsonObject<{ currentPassword: string; newPassword: string }>(request);

  const fullUser = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id).first<{ password_hash: string }>();
  if (!fullUser) return errorResponse('User not found', 404);

  const valid = await verifyPassword(currentPassword, fullUser.password_hash);
  if (!valid) return errorResponse('Current password incorrect', 401);

  const newHash = await hashPassword(newPassword);
  const sessionIds = await sessionCredentialIdsForUser(env, user.id);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  await disconnectCredentialsForUser(env, user.id, sessionIds, 'Password changed');
  const token = await createSession(env, user.id);
  logAppEvent(env, 'threads.auth.password_changed', {
    actor_id: user.id,
    auth_method: 'session_cookie',
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token, undefined, env.COOKIE_DOMAIN),
    },
  });
}
