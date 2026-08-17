import type { AuthPrincipal } from '../auth.js';
import {
  createSession,
  requireAdminPrincipal,
  requireInteractiveSession,
  verifyPassword,
} from '../auth.js';
import { clearSuccessfulLoginRateLimit } from './auth.js';
import { disconnectCredentialsForUser, sessionCredentialIdsForUser } from '../lib/credential-connections.js';
import {
  cancelMfaLoginChallenge,
  clearMfaChallengeCookie,
  completeMfaLoginChallenge,
  confirmMfaEnrollment,
  hasMfaEncryptionKey,
  isMfaEnabled,
  removeMfaForUser,
  startMfaEnrollment,
  verifyAndConsumeUserMfaCode,
  verifiedEmailForMfa,
  workspaceRequiresMfa,
} from '../lib/mfa.js';
import { logAppEvent } from '../lib/observability.js';
import type { Env, User } from '../types.js';
import { errorResponse, jsonResponse, setSessionCookie, readJsonObject } from '../utils.js';

async function passwordMatches(env: Env, userId: string, password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !password) return false;
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId).first<{ password_hash: string }>();
  return row != null && await verifyPassword(password, row.password_hash);
}

async function reauthorizeSensitiveAction(
  env: Env,
  principal: AuthPrincipal,
  currentPassword: unknown,
  code: unknown,
): Promise<Response | null> {
  requireInteractiveSession(principal);
  if (!await passwordMatches(env, principal.user.id, currentPassword)) {
    return errorResponse('Current password incorrect', 401);
  }
  if (!await isMfaEnabled(env, principal.user.id)) return null;
  if (typeof code !== 'string' || !await verifyAndConsumeUserMfaCode(env, principal.user.id, code)) {
    return errorResponse('A current authenticator code is required', 401);
  }
  return null;
}

function safeUser(user: User & { password_hash?: string }): Record<string, unknown> {
  const {
    password_hash: _passwordHash,
    email_normalized: _emailNormalized,
    ...safe
  } = user;
  return safe;
}

export async function handleCompleteMfa(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject<{ code?: unknown }>(request).catch(() => ({} as { code?: unknown }));
  if (typeof body.code !== 'string') return errorResponse('Authenticator code required');
  const result = await completeMfaLoginChallenge(request, env, body.code);
  if (!result.ok) {
    const status = result.reason === 'unavailable'
      ? 503
      : result.reason === 'email_unverified'
        ? 403
        : 401;
    const message = result.reason === 'unavailable'
      ? 'Authenticator verification is temporarily unavailable'
      : result.reason === 'email_unverified'
        ? 'Verify your recovery email before setting up authenticator MFA'
        : result.reason === 'expired'
          ? 'Authenticator challenge expired; sign in again'
          : result.reason === 'exhausted'
            ? 'Too many invalid codes; sign in again'
            : 'Invalid authenticator code';
    const response = errorResponse(message, status);
    if (
      result.reason === 'missing'
      || result.reason === 'expired'
      || result.reason === 'exhausted'
      || result.reason === 'email_unverified'
    ) {
      response.headers.append('Set-Cookie', clearMfaChallengeCookie(env.COOKIE_DOMAIN));
    }
    return response;
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(result.userId).first<User & { password_hash: string }>();
  if (!user) return errorResponse('User not found', 404);
  const session = await createSession(env, user.id);
  clearSuccessfulLoginRateLimit(request, env);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', setSessionCookie(session, undefined, env.COOKIE_DOMAIN));
  headers.append('Set-Cookie', clearMfaChallengeCookie(env.COOKIE_DOMAIN));
  logAppEvent(env, 'threads.auth.login', {
    outcome: 'success',
    auth_method: 'password_totp',
    actor_id: user.id,
    actor_role: user.role || 'user',
    actor_is_admin: user.is_admin === 1,
    mfa_purpose: result.purpose,
  });
  return new Response(JSON.stringify({ ...safeUser(user), next: 'complete' }), { status: 200, headers });
}

export async function handleCancelMfa(request: Request, env: Env): Promise<Response> {
  await cancelMfaLoginChallenge(request, env);
  const response = jsonResponse({ ok: true });
  response.headers.append('Set-Cookie', clearMfaChallengeCookie(env.COOKIE_DOMAIN));
  return response;
}

export async function handleGetMySecurity(env: Env, principal: AuthPrincipal): Promise<Response> {
  requireInteractiveSession(principal);
  const [enabled, required, enrollment] = await Promise.all([
    isMfaEnabled(env, principal.user.id),
    workspaceRequiresMfa(env),
    env.DB.prepare(
      'SELECT expires_at FROM mfa_enrollments WHERE user_id = ? AND expires_at > unixepoch()',
    ).bind(principal.user.id).first<{ expires_at: number }>(),
  ]);
  return jsonResponse({
    mfaEnabled: enabled,
    mfaRequired: required && principal.user.role !== 'bot',
    enrollmentExpiresAt: enrollment?.expires_at ?? null,
    email: principal.user.email,
    emailVerified: verifiedEmailForMfa(principal.user) != null,
  });
}

export async function handleStartMyMfaEnrollment(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireInteractiveSession(principal);
  if (principal.user.role === 'bot') return errorResponse('Bot users do not use authenticator MFA', 403);
  if (await isMfaEnabled(env, principal.user.id)) return errorResponse('Authenticator MFA is already enabled', 409);
  if (!verifiedEmailForMfa(principal.user)) {
    return errorResponse('Verify your recovery email before setting up authenticator MFA', 409);
  }
  const body = await readJsonObject<{ currentPassword?: unknown }>(request)
    .catch(() => ({} as { currentPassword?: unknown }));
  if (!await passwordMatches(env, principal.user.id, body.currentPassword)) {
    return errorResponse('Current password incorrect', 401);
  }
  if (!hasMfaEncryptionKey(env)) return errorResponse('Authenticator enrollment is temporarily unavailable', 503);
  const setup = await startMfaEnrollment(env, principal.user);
  logAppEvent(env, 'threads.auth.mfa_enrollment_started', { actor_id: principal.user.id });
  return jsonResponse(setup);
}

export async function handleConfirmMyMfaEnrollment(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireInteractiveSession(principal);
  if (principal.user.role === 'bot') return errorResponse('Bot users do not use authenticator MFA', 403);
  if (await isMfaEnabled(env, principal.user.id)) return errorResponse('Authenticator MFA is already enabled', 409);
  if (!verifiedEmailForMfa(principal.user)) {
    return errorResponse('Verify your recovery email before enabling authenticator MFA', 409);
  }
  const body = await readJsonObject<{ code?: unknown }>(request).catch(() => ({} as { code?: unknown }));
  if (typeof body.code !== 'string' || !await confirmMfaEnrollment(env, principal.user.id, body.code)) {
    return errorResponse('Invalid or expired authenticator enrollment', 400);
  }
  logAppEvent(env, 'threads.auth.mfa_enabled', { actor_id: principal.user.id });
  return jsonResponse({ ok: true, mfaEnabled: true });
}

export async function handleDisableMyMfa(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireInteractiveSession(principal);
  if (await workspaceRequiresMfa(env)) {
    return errorResponse('Workspace policy requires authenticator MFA', 409);
  }
  if (!await isMfaEnabled(env, principal.user.id)) return errorResponse('Authenticator MFA is not enabled', 409);
  const body = await readJsonObject<{ currentPassword?: unknown; code?: unknown }>(request)
    .catch(() => ({} as { currentPassword?: unknown; code?: unknown }));
  if (!await passwordMatches(env, principal.user.id, body.currentPassword)) {
    return errorResponse('Current password incorrect', 401);
  }
  if (typeof body.code !== 'string' || !await verifyAndConsumeUserMfaCode(env, principal.user.id, body.code)) {
    return errorResponse('A current authenticator code is required', 401);
  }
  await removeMfaForUser(env, principal.user.id);
  logAppEvent(env, 'threads.auth.mfa_disabled', { actor_id: principal.user.id });
  return jsonResponse({ ok: true, mfaEnabled: false });
}

type WorkspaceSecurityUser = {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  email_verified_at: number | null;
  is_admin: number;
  mfa_enabled: number;
};

async function workspaceSecurityState(env: Env): Promise<{
  requireMfaForHumans: boolean;
  users: WorkspaceSecurityUser[];
}> {
  const [required, users] = await Promise.all([
    workspaceRequiresMfa(env),
    env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.email, u.email_verified_at,
              u.is_admin, CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS mfa_enabled
       FROM users u LEFT JOIN mfa_credentials m ON m.user_id = u.id
       WHERE COALESCE(u.role, 'human') != 'bot'
       ORDER BY u.is_admin DESC, COALESCE(u.display_name, u.username) COLLATE NOCASE`,
    ).all<WorkspaceSecurityUser>(),
  ]);
  return { requireMfaForHumans: required, users: users.results ?? [] };
}

export async function handleGetWorkspaceSecurity(env: Env, principal: AuthPrincipal): Promise<Response> {
  requireAdminPrincipal(principal);
  requireInteractiveSession(principal);
  const state = await workspaceSecurityState(env);
  return jsonResponse({
    ...state,
    enrolledHumans: state.users.filter((user) => user.mfa_enabled === 1).length,
    totalHumans: state.users.length,
    unverifiedHumans: state.users.filter((user) => user.email_verified_at == null).length,
  });
}

export async function handleUpdateWorkspaceSecurity(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireAdminPrincipal(principal);
  requireInteractiveSession(principal);
  const body = await readJsonObject<{
    requireMfaForHumans?: unknown;
    currentPassword?: unknown;
    code?: unknown;
  }>(request).catch(() => ({} as {
    requireMfaForHumans?: unknown;
    currentPassword?: unknown;
    code?: unknown;
  }));
  if (typeof body.requireMfaForHumans !== 'boolean') return errorResponse('requireMfaForHumans must be a boolean');
  if (body.requireMfaForHumans) {
    if (!await isMfaEnabled(env, principal.user.id)) {
      return errorResponse('Enable authenticator MFA on your own account before requiring it workspace-wide', 409);
    }
    const { results } = await env.DB.prepare(
      `SELECT id, username FROM users
       WHERE COALESCE(role, 'human') != 'bot' AND email_verified_at IS NULL
       ORDER BY username`,
    ).all<{ id: string; username: string }>();
    if ((results ?? []).length > 0) {
      return jsonResponse({
        error: 'Every human user must have a verified recovery email before workspace MFA can be required',
        unverifiedUsers: results,
      }, 409);
    }
  }

  const reauth = await reauthorizeSensitiveAction(env, principal, body.currentPassword, body.code);
  if (reauth) return reauth;

  await env.DB.prepare(
    `UPDATE workspace_security
     SET require_mfa_for_humans = ?, updated_by = ?, updated_at = unixepoch()
     WHERE id = 1`,
  ).bind(body.requireMfaForHumans ? 1 : 0, principal.user.id).run();
  logAppEvent(env, 'threads.auth.mfa_policy_changed', {
    actor_id: principal.user.id,
    require_mfa_for_humans: body.requireMfaForHumans,
  });
  return handleGetWorkspaceSecurity(env, principal);
}

export async function handleResetUserMfa(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
  targetUserId: string,
): Promise<Response> {
  requireAdminPrincipal(principal);
  requireInteractiveSession(principal);
  if (targetUserId === principal.user.id) return errorResponse('Admins cannot reset their own MFA', 400);
  const target = await env.DB.prepare(
    `SELECT id, username FROM users WHERE id = ? AND COALESCE(role, 'human') != 'bot'`,
  ).bind(targetUserId).first<{ id: string; username: string }>();
  if (!target) return errorResponse('Human user not found', 404);
  if (!await isMfaEnabled(env, targetUserId)) return errorResponse('Authenticator MFA is not enabled for this user', 409);
  const body = await readJsonObject<{ currentPassword?: unknown; code?: unknown }>(request)
    .catch(() => ({} as { currentPassword?: unknown; code?: unknown }));
  const reauth = await reauthorizeSensitiveAction(env, principal, body.currentPassword, body.code);
  if (reauth) return reauth;

  const sessionIds = await sessionCredentialIdsForUser(env, targetUserId);
  await removeMfaForUser(env, targetUserId);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetUserId).run();
  await disconnectCredentialsForUser(env, targetUserId, sessionIds, 'MFA reset by an administrator');
  logAppEvent(env, 'threads.auth.mfa_reset', {
    actor_id: principal.user.id,
    target_user_id: targetUserId,
  });
  return jsonResponse({ ok: true, targetUserId });
}
