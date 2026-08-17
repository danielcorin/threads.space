import type { Env, User } from '../types.js';
import type { AuthPrincipal } from '../auth.js';
import { hashPassword, requireAdminPrincipal } from '../auth.js';
import { jsonResponse, errorResponse, generateId, readJsonObject } from '../utils.js';
import { createdWebhookResponse, prepareWebhooksForToken, webhookInsertStatement, webhooksAllowInsecure } from '../lib/webhooks.js';
import { createApiTokenPolicy, parseApiTokenScopes } from '../lib/api-token-policy.js';
import {
  CREDENTIAL_VERIFIER_VERSION,
  credentialId,
  credentialStorageKey,
  credentialVerifier,
  generateApiToken,
  tokenHint,
} from '../lib/credentials.js';
import { logAppEvent } from '../lib/observability.js';
import {
  allCredentialIdsForUser,
  disconnectCredentialConnections,
  disconnectCredentialsForUser,
  sessionCredentialIdsForUser,
} from '../lib/credential-connections.js';
import { parseEmail } from '../lib/email.js';
import { sendInitialUserEmailVerification } from './email-verification.js';

function parseBotCapabilities(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

type CreateApiTokenBody = {
  name?: unknown;
  webhook_urls?: string[];
  scopes?: unknown;
  /** null explicitly creates a non-expiring token; omitted defaults to 90 days. */
  expires_in_days?: unknown;
};

// Admin-only: create a human or bot user. Authorized by the session user's
// admin flag (no shared secret in the browser).
export async function handleCreateUser(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
  requireAdminPrincipal(principal, 'users:provision');

  const { username, password, email: emailInput, displayName, role } = await readJsonObject<{
    username: string;
    password: string;
    email?: string;
    displayName?: string;
    role?: string;
  }>(request);
  if (!username || !password) return errorResponse('Username and password required');

  const userRole = role === 'bot' ? 'bot' : 'human';
  const parsedEmail = parseEmail(emailInput);
  if (userRole === 'human' && !parsedEmail) return errorResponse('A valid email is required for human users');
  if (emailInput !== undefined && !parsedEmail) return errorResponse('Email must be a valid address');

  if (parsedEmail) {
    const existingEmail = await env.DB.prepare(
      `SELECT id FROM users WHERE email_normalized = ?
       UNION ALL
       SELECT user_id AS id FROM user_email_verifications WHERE pending_email_normalized = ?
       LIMIT 1`,
    )
      .bind(parsedEmail.normalized, parsedEmail.normalized)
      .first<{ id: string }>();
    if (existingEmail) return errorResponse('Email already belongs to another user', 409);
  }

  const id = generateId();
  const passwordHash = await hashPassword(password);

  try {
    await env.DB.prepare(
      `INSERT INTO users
        (id, username, password_hash, email, email_normalized, display_name, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      username,
      passwordHash,
      parsedEmail?.email ?? null,
      parsedEmail?.normalized ?? null,
      displayName ?? null,
      userRole,
    ).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      if (parsedEmail) {
        const emailTaken = await env.DB.prepare(
          `SELECT id FROM users WHERE email_normalized = ?
           UNION ALL
           SELECT user_id AS id FROM user_email_verifications WHERE pending_email_normalized = ?
           LIMIT 1`,
        )
          .bind(parsedEmail.normalized, parsedEmail.normalized)
          .first<{ id: string }>();
        if (emailTaken) return errorResponse('Email already belongs to another user', 409);
      }
      return errorResponse('Username already exists', 409);
    }
    throw e;
  }

  let emailVerificationSent = false;
  let emailVerificationExpiresAt: number | null = null;
  if (userRole === 'human' && parsedEmail) {
    try {
      const verification = await sendInitialUserEmailVerification(
        request,
        env,
        id,
        parsedEmail.email,
        parsedEmail.normalized,
      );
      emailVerificationSent = true;
      emailVerificationExpiresAt = verification.expiresAt;
    } catch (error) {
      // The user account remains usable when email delivery is temporarily
      // unavailable. Surface that state so the creator can tell the user to
      // resend from Settings. Roll back on identity conflicts or DB failures.
      if (!(error instanceof Response) || (error.status !== 502 && error.status !== 503)) {
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
        throw error;
      }
    }
  }

  return jsonResponse({
    id,
    username,
    email: parsedEmail?.email ?? null,
    displayName: displayName ?? null,
    emailVerificationSent,
    emailVerificationExpiresAt,
  }, 201);
}

// Admin-only: mint an API bearer token for the authenticated user. Mirrors the
// session-based admin gate used by handleCreateUser (no shared secret). The raw
// token is returned once; the owner can revoke via DELETE /users/me/api-tokens/:id.
export async function handleCreateMyApiToken(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
  requireAdminPrincipal(principal);
  const user = principal.user;

  const body = await readJsonObject<CreateApiTokenBody>(request);
  if (typeof body.name !== 'string' || body.name.trim() === '') return errorResponse('Token name required');
  const name = body.name.trim();
  const policy = createApiTokenPolicy({ scopes: body.scopes, expiresInDays: body.expires_in_days });
  if ('error' in policy) return errorResponse(policy.error);

  const token = generateApiToken();
  const [id, verifier] = await Promise.all([
    credentialId(token),
    credentialVerifier(env, 'api_token', token),
  ]);
  let webhooks;
  try {
    webhooks = await prepareWebhooksForToken(
      env,
      user.id,
      credentialStorageKey(id),
      id,
      body.webhook_urls,
      { allowInsecure: webhooksAllowInsecure(env) },
    );
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }

  await env.DB.batch([
    env.DB.prepare(
    `INSERT INTO api_tokens
      (token, user_id, name, scopes, expires_at, credential_id, token_verifier,
       verifier_version, token_hint, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      credentialStorageKey(id), user.id, name, JSON.stringify(policy.scopes), policy.expiresAt,
      id, verifier, CREDENTIAL_VERIFIER_VERSION, tokenHint(token),
    ),
    ...webhooks.map((webhook) => webhookInsertStatement(env, webhook)),
  ]);

  const response = jsonResponse({
    token,
    id,
    name,
    scopes: policy.scopes,
    expires_at: policy.expiresAt,
    webhooks: webhooks.map(createdWebhookResponse),
  }, 201);
  logAppEvent(env, 'threads.auth.token_created', {
    actor_id: user.id,
    target_user_id: user.id,
    credential_id: id,
    expires_at: policy.expiresAt,
  });
  return response;
}

// Admin-only: mint an API bearer token FOR ANOTHER user (by id) — e.g. a bot the
// admin just created via POST /users. Gated by the session user's admin flag (no
// shared secret), so an admin with only UI/bearer access can provision a bot
// end-to-end. The raw token is returned once.
export async function handleCreateApiTokenForUser(request: Request, env: Env, principal: AuthPrincipal, targetUserId: string): Promise<Response> {
  requireAdminPrincipal(principal, 'tokens:manage');
  const user = principal.user;

  const body = await readJsonObject<CreateApiTokenBody>(request);
  if (typeof body.name !== 'string' || body.name.trim() === '') return errorResponse('Token name required');
  const name = body.name.trim();
  const policy = createApiTokenPolicy({ scopes: body.scopes, expiresInDays: body.expires_in_days });
  if ('error' in policy) return errorResponse(policy.error);
  if (principal.credential.kind === 'bearer') {
    const parentScopes = principal.credential.scopes ?? new Set();
    const escalatedScope = policy.scopes.find((scope) => !parentScopes.has(scope));
    if (escalatedScope) {
      return errorResponse(`A bearer token cannot delegate a scope it does not have: ${escalatedScope}`, 403);
    }
    if (principal.credential.expiresAt !== Number.MAX_SAFE_INTEGER
      && (policy.expiresAt === null || policy.expiresAt > principal.credential.expiresAt)) {
      policy.expiresAt = principal.credential.expiresAt;
    }
  }

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(targetUserId).first<{ id: string }>();
  if (!target) return errorResponse('User not found', 404);

  const token = generateApiToken();
  const [id, verifier] = await Promise.all([
    credentialId(token),
    credentialVerifier(env, 'api_token', token),
  ]);
  let webhooks;
  try {
    webhooks = await prepareWebhooksForToken(
      env,
      targetUserId,
      credentialStorageKey(id),
      id,
      body.webhook_urls,
      { allowInsecure: webhooksAllowInsecure(env) },
    );
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }

  await env.DB.batch([
    env.DB.prepare(
    `INSERT INTO api_tokens
      (token, user_id, name, scopes, expires_at, credential_id, token_verifier,
       verifier_version, token_hint, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      credentialStorageKey(id), targetUserId, name, JSON.stringify(policy.scopes), policy.expiresAt,
      id, verifier, CREDENTIAL_VERIFIER_VERSION, tokenHint(token),
    ),
    ...webhooks.map((webhook) => webhookInsertStatement(env, webhook)),
  ]);

  const response = jsonResponse({
    token,
    id,
    name,
    scopes: policy.scopes,
    expires_at: policy.expiresAt,
    webhooks: webhooks.map(createdWebhookResponse),
  }, 201);
  logAppEvent(env, 'threads.auth.token_created', {
    actor_id: user.id,
    target_user_id: targetUserId,
    credential_id: id,
    expires_at: policy.expiresAt,
  });
  return response;
}

// Admin-only: list the authenticated user's API tokens. Returns non-secret
// metadata only (a hashed id, name, created_at) — never the token value.
export async function handleListMyApiTokens(env: Env, principal: AuthPrincipal): Promise<Response> {
  requireAdminPrincipal(principal);
  const user = principal.user;

  const { results } = await env.DB.prepare(
    `SELECT credential_id, name, scopes, expires_at, created_at, last_used_at
     FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
  ).bind(user.id).all<{
    credential_id: string;
    name: string;
    scopes: string;
    expires_at: number | null;
    created_at: number;
    last_used_at: number | null;
  }>();

  const tokens = (results ?? []).map((row) => ({
        id: row.credential_id,
        name: row.name,
        scopes: parseApiTokenScopes(row.scopes),
        expires_at: row.expires_at,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
      }));

  return jsonResponse({ tokens });
}

// Admin-only: revoke one of the authenticated user's own API tokens by its
// hashed id. Scoped to user.id so a user can only revoke their own tokens.
export async function handleRevokeMyApiToken(env: Env, principal: AuthPrincipal, id: string): Promise<Response> {
  requireAdminPrincipal(principal);
  const user = principal.user;
  const row = await env.DB.prepare(
    'SELECT token FROM api_tokens WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL',
  ).bind(id, user.id).first<{ token: string }>();
  if (!row) return errorResponse('Token not found', 404);

  await env.DB.batch([
    env.DB.prepare(
      'UPDATE api_tokens SET revoked_at = unixepoch() WHERE credential_id = ? AND user_id = ?',
    ).bind(id, user.id),
    env.DB.prepare(
      `UPDATE webhooks SET active = 0, disabled_reason = 'token_revoked'
       WHERE user_id = ? AND (token_id = ? OR token = ?)`,
    ).bind(user.id, id, row.token),
  ]);
  const connectionsClosed = await disconnectCredentialConnections(env, user.id, id);
  logAppEvent(env, 'threads.auth.token_revoked', {
    actor_id: user.id,
    target_user_id: user.id,
    credential_id: id,
  });

  return jsonResponse({ ok: true, connections_closed: connectionsClosed });
}

// --- Admin-only user management (interactive session or explicit bearer scope) ---
// These replace the old X-Admin-Key `/admin/*` endpoints: operator actions on
// OTHER users, authorized by the caller's admin flag rather than a shared
// server secret. There is deliberately no "promote to admin" endpoint — the
// first admin is claimed atomically through the fresh-instance login bootstrap.

// Admin-only: reset ANOTHER user's password by id.
export async function handleResetPasswordForUser(request: Request, env: Env, principal: AuthPrincipal, targetUserId: string): Promise<Response> {
  requireAdminPrincipal(principal);
  const user = principal.user;
  const { password } = await readJsonObject<{ password: string }>(request);
  if (!password) return errorResponse('Password required');

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(targetUserId).first<{ id: string }>();
  if (!target) return errorResponse('User not found', 404);

  const passwordHash = await hashPassword(password);
  const sessionIds = await sessionCredentialIdsForUser(env, targetUserId);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, targetUserId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetUserId),
  ]);
  await disconnectCredentialsForUser(env, targetUserId, sessionIds, 'Password reset');
  logAppEvent(env, 'threads.auth.password_reset', {
    actor_id: user.id,
    target_user_id: targetUserId,
  });

  return jsonResponse({ ok: true });
}

/**
 * Admin-only: delete a user by id.
 *
 * Twelve columns reference users(id) with no ON DELETE clause, so SQLite's
 * default NO ACTION blocked the delete for any account that had actually been
 * used: a bare `DELETE FROM users` raised a D1 FOREIGN KEY error and the caller
 * got a 500. Offboarding anyone who had sent a message or created a channel was
 * therefore impossible. The handler resolves these references explicitly.
 *
 * Two different treatments, because authorship and ownership are not the same
 * thing:
 *
 *   Authorship is NULLed. A message keeps its content and its place in the
 *   channel but loses its author (messages.user_id is nullable and the read
 *   model already LEFT JOINs users, so a null author is an existing, supported
 *   state). Reattributing someone's words to whoever deleted them would be a
 *   lie, and deleting them would silently tear holes in shared history.
 *
 *   Ownership is TRANSFERRED to the admin performing the deletion. created_by
 *   and added_by are NOT NULL audit fields on shared artifacts — channels,
 *   widgets, pins, documents. Transfer is what every workspace tool does at
 *   offboarding; the alternative is destroying content the rest of the
 *   instance still uses.
 *
 * Purely personal rows (push subscriptions and preferences, agent processes)
 * are deleted outright. Everything else already cascades.
 *
 * The response reports what was transferred so the reassignment is visible to
 * the operator rather than silent.
 */
export async function handleDeleteUser(env: Env, principal: AuthPrincipal, targetUserId: string): Promise<Response> {
  requireAdminPrincipal(principal);
  const inheritorId = principal.user.id;
  if (targetUserId === inheritorId) {
    return errorResponse('You cannot delete the account you are signed in as', 409);
  }

  const credentialIds = await allCredentialIdsForUser(env, targetUserId);
  await disconnectCredentialsForUser(env, targetUserId, credentialIds, 'User deleted');

  const transferred = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM channels WHERE created_by = ?1) AS channels,
       (SELECT COUNT(*) FROM widgets WHERE created_by = ?1) AS widgets,
       (SELECT COUNT(*) FROM channel_widgets WHERE added_by = ?1) AS channel_widgets,
       (SELECT COUNT(*) FROM channel_documents WHERE created_by = ?1) AS documents,
       (SELECT COUNT(*) FROM pinned_messages WHERE pinned_by = ?1) AS pins,
       (SELECT COUNT(*) FROM messages WHERE user_id = ?1) AS messages_orphaned`,
  ).bind(targetUserId).first<Record<string, number>>();

  // Ordered so every reference is resolved before the user row goes. D1 runs a
  // batch as one transaction, so a failure anywhere leaves the user intact
  // rather than half-deleted.
  await env.DB.batch([
    // Authorship -> NULL (nullable columns).
    env.DB.prepare('UPDATE messages SET user_id = NULL WHERE user_id = ?').bind(targetUserId),
    env.DB.prepare('UPDATE processes SET bot_id = NULL WHERE bot_id = ?').bind(targetUserId),
    env.DB.prepare('UPDATE channels SET auto_respond_bot_id = NULL WHERE auto_respond_bot_id = ?').bind(targetUserId),
    // Self-referencing: other users pointing at this one as their ephemeral bot.
    env.DB.prepare('UPDATE users SET ephemeral_bot_id = NULL WHERE ephemeral_bot_id = ?').bind(targetUserId),
    // Ownership -> the deleting admin (NOT NULL columns on shared artifacts).
    env.DB.prepare('UPDATE channels SET created_by = ? WHERE created_by = ?').bind(inheritorId, targetUserId),
    env.DB.prepare('UPDATE widgets SET created_by = ? WHERE created_by = ?').bind(inheritorId, targetUserId),
    env.DB.prepare('UPDATE channel_widgets SET added_by = ? WHERE added_by = ?').bind(inheritorId, targetUserId),
    env.DB.prepare('UPDATE channel_documents SET created_by = ? WHERE created_by = ?').bind(inheritorId, targetUserId),
    env.DB.prepare('UPDATE pinned_messages SET pinned_by = ? WHERE pinned_by = ?').bind(inheritorId, targetUserId),
    // Personal rows with no cascade.
    env.DB.prepare('DELETE FROM processes WHERE user_id = ?').bind(targetUserId),
    env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(targetUserId),
    env.DB.prepare('DELETE FROM push_preferences WHERE user_id = ?').bind(targetUserId),
    // sync_state has no foreign key (keys are `<user.id>:<key>` strings), so it
    // never blocked the delete — it just leaked rows on every deletion.
    env.DB.prepare("DELETE FROM sync_state WHERE key LIKE ? ESCAPE '\\'").bind(`${targetUserId.replace(/[%_]/g, '\\$&')}:%`),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId),
  ]);

  return jsonResponse({
    ok: true,
    transferredTo: inheritorId,
    transferred: {
      channels: transferred?.channels ?? 0,
      widgets: transferred?.widgets ?? 0,
      channelWidgets: transferred?.channel_widgets ?? 0,
      documents: transferred?.documents ?? 0,
      pins: transferred?.pins ?? 0,
    },
    messagesOrphaned: transferred?.messages_orphaned ?? 0,
  });
}

// Admin-only: revoke ANOTHER user's API token by its hashed id.
export async function handleRevokeApiTokenForUser(env: Env, principal: AuthPrincipal, targetUserId: string, tokenId: string): Promise<Response> {
  requireAdminPrincipal(principal, 'tokens:manage');
  const user = principal.user;
  const row = await env.DB.prepare(
    'SELECT token FROM api_tokens WHERE credential_id = ? AND user_id = ? AND revoked_at IS NULL',
  ).bind(tokenId, targetUserId).first<{ token: string }>();
  if (!row) return errorResponse('Token not found', 404);

  await env.DB.batch([
    env.DB.prepare(
      'UPDATE api_tokens SET revoked_at = unixepoch() WHERE credential_id = ? AND user_id = ?',
    ).bind(tokenId, targetUserId),
    env.DB.prepare(
      `UPDATE webhooks SET active = 0, disabled_reason = 'token_revoked'
       WHERE user_id = ? AND (token_id = ? OR token = ?)`,
    ).bind(targetUserId, tokenId, row.token),
  ]);
  const connectionsClosed = await disconnectCredentialConnections(env, targetUserId, tokenId);
  logAppEvent(env, 'threads.auth.token_revoked', {
    actor_id: user.id,
    target_user_id: targetUserId,
    credential_id: tokenId,
  });

  return jsonResponse({ ok: true, connections_closed: connectionsClosed });
}

// Admin-only: the 50 most recent server error-log rows (see the 500 handler in
// index.ts that records them). Replaces the old X-Admin-Key GET /admin/errors.
export async function handleGetErrors(env: Env, principal: AuthPrincipal): Promise<Response> {
  requireAdminPrincipal(principal);
  const { results } = await env.DB.prepare(
    'SELECT * FROM error_logs ORDER BY id DESC LIMIT 50'
  ).all();
  return jsonResponse(results);
}

export async function handleGetMe(env: Env, user: User): Promise<Response> {
  const pendingEmail = await env.DB.prepare(
    `SELECT pending_email, expires_at FROM user_email_verifications
     WHERE user_id = ? AND expires_at > unixepoch()`,
  ).bind(user.id).first<{ pending_email: string; expires_at: number }>();
  return jsonResponse({
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified_at: user.email_verified_at,
    pending_email: pendingEmail?.pending_email ?? null,
    email_verification_expires_at: pendingEmail?.expires_at ?? null,
    display_name: user.display_name,
    name_color: user.name_color,
    code_theme: user.code_theme,
    role: user.role,
    ephemeral_bot_id: user.ephemeral_bot_id,
    bot_capabilities: parseBotCapabilities(user.bot_capabilities_json),
  });
}

// List all bot users (role='bot'). Used by the settings UI to populate the
// "default ephemeral bot" picker. Returns non-secret identity fields only.
export async function handleListBots(env: Env, _user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, username, display_name, name_color, avatar_url, role
     FROM users WHERE role = 'bot' ORDER BY COALESCE(display_name, username) COLLATE NOCASE`
  ).all();
  return jsonResponse(results);
}

// Bot-only: advertise this bot's capabilities (e.g. available model IDs for DM picker).
// Self-scoped — the authenticated bot updates its own row. Rejects non-bot users.
export async function handleUpdateSelfCapabilities(request: Request, env: Env, user: User): Promise<Response> {
  if (user.role !== 'bot') {
    return errorResponse('Only bot users can set capabilities', 403);
  }

  const body = await readJsonObject<{ models?: string[]; dm_allowed_usernames?: string[]; dm_allowed_user_ids?: string[] }>(request).catch(() => null);
  if (!body || typeof body !== 'object') {
    return errorResponse('Body must be a JSON object');
  }

  // Accept known bot capability keys.
  const caps: Record<string, unknown> = {};
  if (Array.isArray(body.models)) {
    const models = body.models
      .filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 200)
      .slice(0, 50);
    caps.models = models;
  }
  if (Array.isArray(body.dm_allowed_usernames)) {
    caps.dm_allowed_usernames = body.dm_allowed_usernames
      .filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 100)
      .slice(0, 100);
  }
  if (Array.isArray(body.dm_allowed_user_ids)) {
    caps.dm_allowed_user_ids = body.dm_allowed_user_ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100)
      .slice(0, 100);
  }

  const json = JSON.stringify(caps);
  await env.DB.prepare('UPDATE users SET bot_capabilities_json = ? WHERE id = ?')
    .bind(json, user.id).run();
  return jsonResponse({ ok: true, capabilities: caps });
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Allowlist of code themes — must stay in sync with the client's
// CODE_THEMES registry in client/src/lib/state/codeTheme.svelte.ts.
// Unknown values are rejected with 400 to keep garbage out of the DB.
const ALLOWED_CODE_THEMES = new Set<string>([
  'monokai-sublime',
  'monokai',
  'github-dark',
  'github',
  'atom-one-dark',
  'dracula',
  'solarized-dark',
  'solarized-light',
  'nord',
]);

export async function handleUpdateMe(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject<{ displayName?: string; nameColor?: string | null; codeTheme?: string | null; ephemeralBotId?: string | null }>(request);

  const updates: string[] = [];
  const bindings: any[] = [];

  if (typeof body.displayName === 'string') {
    const trimmed = body.displayName.trim().slice(0, 100);
    updates.push('display_name = ?');
    bindings.push(trimmed);
  }

  if (body.nameColor !== undefined) {
    if (body.nameColor === null || body.nameColor === '') {
      updates.push('name_color = NULL');
    } else if (HEX_COLOR_RE.test(body.nameColor)) {
      updates.push('name_color = ?');
      bindings.push(body.nameColor);
    } else {
      return errorResponse('nameColor must be a valid hex color (e.g. #FF5733)');
    }
  }

  if (body.codeTheme !== undefined) {
    if (body.codeTheme === null || body.codeTheme === '') {
      updates.push('code_theme = NULL');
    } else if (typeof body.codeTheme === 'string' && ALLOWED_CODE_THEMES.has(body.codeTheme)) {
      updates.push('code_theme = ?');
      bindings.push(body.codeTheme);
    } else {
      return errorResponse('codeTheme must be one of the allowed themes');
    }
  }

  if (body.ephemeralBotId !== undefined) {
    if (body.ephemeralBotId === null || body.ephemeralBotId === '') {
      updates.push('ephemeral_bot_id = NULL');
    } else if (typeof body.ephemeralBotId === 'string') {
      // Must reference an existing bot user — reject anything else so the
      // ephemeral-channel flow can't be pointed at a human or a stale id.
      const bot = await env.DB.prepare(
        `SELECT id FROM users WHERE id = ? AND role = 'bot'`
      ).bind(body.ephemeralBotId).first<{ id: string }>();
      if (!bot) return errorResponse('ephemeralBotId must reference an existing bot user');
      updates.push('ephemeral_bot_id = ?');
      bindings.push(body.ephemeralBotId);
    } else {
      return errorResponse('ephemeralBotId must be a bot user id or null');
    }
  }

  if (updates.length === 0) {
    return errorResponse('No valid fields to update');
  }

  bindings.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings).run();
  // Re-fetch updated user to return current state
  const updated = await env.DB.prepare('SELECT id, username, display_name, name_color, code_theme, role, ephemeral_bot_id FROM users WHERE id = ?')
    .bind(user.id).first<{ id: string; username: string; display_name: string | null; name_color: string | null; code_theme: string | null; ephemeral_bot_id: string | null }>();

  return jsonResponse({
    ok: true,
    displayName: updated?.display_name,
    nameColor: updated?.name_color,
    codeTheme: updated?.code_theme,
    ephemeralBotId: updated?.ephemeral_bot_id,
  });
}

const DEFAULT_EMOJIS = ['👍', '❤️', '😂'];

export async function handleGetFrequentEmojis(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT emoji, COUNT(*) as count FROM reactions WHERE user_id = ? GROUP BY emoji ORDER BY count DESC LIMIT 3'
  ).bind(user.id).all<{ emoji: string; count: number }>();

  const emojis = results.map(r => r.emoji);

  // Backfill with defaults if fewer than 3
  for (const def of DEFAULT_EMOJIS) {
    if (emojis.length >= 3) break;
    if (!emojis.includes(def)) {
      emojis.push(def);
    }
  }

  return jsonResponse(emojis);
}

export async function handleSearchUsers(env: Env, user: User, url: URL): Promise<Response> {
  const query = url.searchParams.get('q')?.trim() ?? '';

  const channelId = url.searchParams.get('channel');
  const pattern = query ? `%${query}%` : '%';

  let sql: string;
  let bindings: string[];

  if (channelId) {
    sql = `
      SELECT u.id, u.username, u.display_name, u.name_color, u.avatar_url, u.role
      FROM users u
      WHERE (u.username LIKE ?1 COLLATE NOCASE OR u.display_name LIKE ?1 COLLATE NOCASE)
        AND u.id NOT IN (SELECT user_id FROM channel_members WHERE channel_id = ?2)
      LIMIT 10
    `;
    bindings = [pattern, channelId];
  } else {
    sql = `
      SELECT id, username, display_name, name_color, avatar_url, role
      FROM users
      WHERE username LIKE ?1 COLLATE NOCASE OR display_name LIKE ?1 COLLATE NOCASE
      LIMIT 10
    `;
    bindings = [pattern];
  }

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return jsonResponse(results);
}
