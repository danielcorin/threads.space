import type { AuthPrincipal } from '../auth.js';
import { requireInteractiveSession, verifyPassword } from '../auth.js';
import { appOrigin, AuthEmailDeliveryError, sendEmailVerification } from '../lib/auth-email.js';
import { parseEmail } from '../lib/email.js';
import type { Env } from '../types.js';
import { errorResponse, generateToken, hashToken, jsonResponse, readJsonObject } from '../utils.js';

const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const SEND_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_SENDS_PER_WINDOW = 5;

type PendingVerification = {
  user_id: string;
  pending_email: string;
  pending_email_normalized: string;
  token_hash: string;
  expires_at: number;
  last_sent_at: number;
  send_count: number;
  window_started_at: number;
  created_at: number;
  updated_at: number;
};

type VerificationState = {
  pendingEmail: string;
  expiresAt: number;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function emailBelongsToAnotherUser(
  env: Env,
  normalized: string,
  userId: string,
): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT id FROM users
     WHERE email_normalized = ? AND id != ?
     UNION ALL
     SELECT user_id AS id FROM user_email_verifications
     WHERE pending_email_normalized = ? AND user_id != ?
     LIMIT 1`,
  ).bind(normalized, userId, normalized, userId).first<{ id: string }>();
  return existing != null;
}

function rateLimitError(row: PendingVerification | null, now: number): Response | null {
  if (!row) return null;
  if (row.last_sent_at > now - RESEND_COOLDOWN_SECONDS) {
    const retryAfter = row.last_sent_at + RESEND_COOLDOWN_SECONDS - now;
    return new Response(JSON.stringify({ error: `Please wait ${retryAfter} seconds before sending another email` }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    });
  }
  if (row.window_started_at > now - SEND_WINDOW_SECONDS && row.send_count >= MAX_SENDS_PER_WINDOW) {
    const retryAfter = row.window_started_at + SEND_WINDOW_SECONDS - now;
    return new Response(JSON.stringify({ error: 'Too many verification emails. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    });
  }
  return null;
}

async function restorePendingVerification(env: Env, userId: string, previous: PendingVerification | null): Promise<void> {
  if (!previous) {
    await env.DB.prepare('DELETE FROM user_email_verifications WHERE user_id = ?').bind(userId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO user_email_verifications
      (user_id, pending_email, pending_email_normalized, token_hash, expires_at,
       last_sent_at, send_count, window_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       pending_email = excluded.pending_email,
       pending_email_normalized = excluded.pending_email_normalized,
       token_hash = excluded.token_hash,
       expires_at = excluded.expires_at,
       last_sent_at = excluded.last_sent_at,
       send_count = excluded.send_count,
       window_started_at = excluded.window_started_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).bind(
    previous.user_id,
    previous.pending_email,
    previous.pending_email_normalized,
    previous.token_hash,
    previous.expires_at,
    previous.last_sent_at,
    previous.send_count,
    previous.window_started_at,
    previous.created_at,
    previous.updated_at,
  ).run();
}

async function issueVerification(
  request: Request,
  env: Env,
  userId: string,
  email: string,
  normalized: string,
  previous: PendingVerification | null,
): Promise<VerificationState> {
  const now = nowSeconds();
  const limited = rateLimitError(previous, now);
  if (limited) throw limited;

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = now + VERIFICATION_TTL_SECONDS;
  const inCurrentWindow = previous && previous.window_started_at > now - SEND_WINDOW_SECONDS;
  const sendCount = inCurrentWindow ? previous.send_count + 1 : 1;
  const windowStartedAt = inCurrentWindow ? previous.window_started_at : now;

  try {
    await env.DB.prepare(
      `INSERT INTO user_email_verifications
        (user_id, pending_email, pending_email_normalized, token_hash, expires_at,
         last_sent_at, send_count, window_started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         pending_email = excluded.pending_email,
         pending_email_normalized = excluded.pending_email_normalized,
         token_hash = excluded.token_hash,
         expires_at = excluded.expires_at,
         last_sent_at = excluded.last_sent_at,
         send_count = excluded.send_count,
         window_started_at = excluded.window_started_at,
         updated_at = excluded.updated_at`,
    ).bind(
      userId,
      email,
      normalized,
      tokenHash,
      expiresAt,
      now,
      sendCount,
      windowStartedAt,
      previous?.created_at ?? now,
      now,
    ).run();
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String((error as Error)?.message))) {
      throw errorResponse('Email already belongs to another user', 409);
    }
    throw error;
  }

  const origin = appOrigin(env, request.url);
  const confirmationUrl = `${origin}/auth/email/confirm?token=${encodeURIComponent(token)}`;
  try {
    await sendEmailVerification(env, email, confirmationUrl);
  } catch (error) {
    if (error instanceof AuthEmailDeliveryError && error.message === 'Email delivery is not configured') {
      await restorePendingVerification(env, userId, previous).catch(() => {});
      throw errorResponse('Email verification is temporarily unavailable', 503);
    }
    // Retain the attempted pending state on transient/provider failures. That
    // lets the user resend later and, importantly, preserves the durable
    // cooldown instead of allowing an unbounded retry loop against Resend.
    throw errorResponse('Could not send verification email. Please try again.', 502);
  }

  return { pendingEmail: email, expiresAt };
}

/**
 * Start verification for an address supplied while an admin creates a human
 * user. The caller owns creation rollback for uniqueness failures; delivery
 * failures can be reported without discarding the newly-created account.
 */
export function sendInitialUserEmailVerification(
  request: Request,
  env: Env,
  userId: string,
  email: string,
  normalized: string,
): Promise<VerificationState> {
  return issueVerification(request, env, userId, email, normalized, null);
}

export async function handleRequestEmailChange(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireInteractiveSession(principal);
  const user = principal.user;
  if (user.role === 'bot') return errorResponse('Bot users do not use recovery email');

  const body = await readJsonObject<{ email?: unknown; currentPassword?: unknown }>(request).catch(() => null);
  if (!body) return errorResponse('Invalid request');
  const parsed = parseEmail(body.email);
  if (!parsed) return errorResponse('A valid email is required');
  if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
    return errorResponse('Current password is required');
  }

  const password = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!password || !(await verifyPassword(body.currentPassword, password.password_hash))) {
    return errorResponse('Current password is incorrect', 401);
  }

  if (user.email_verified_at && user.email_normalized === parsed.normalized) {
    // Treat choosing the already-verified address as an explicit cancellation
    // of any replacement, so an older confirmation link cannot change it later.
    await env.DB.prepare('DELETE FROM user_email_verifications WHERE user_id = ?').bind(user.id).run();
    return jsonResponse({
      ok: true,
      verified: true,
      email: user.email,
      pendingEmail: null,
      expiresAt: null,
    });
  }
  if (await emailBelongsToAnotherUser(env, parsed.normalized, user.id)) {
    return errorResponse('Email already belongs to another user', 409);
  }

  const previous = await env.DB.prepare('SELECT * FROM user_email_verifications WHERE user_id = ?')
    .bind(user.id)
    .first<PendingVerification>();
  const state = await issueVerification(request, env, user.id, parsed.email, parsed.normalized, previous);
  return jsonResponse({ ok: true, verified: false, ...state });
}

export async function handleResendEmailVerification(
  request: Request,
  env: Env,
  principal: AuthPrincipal,
): Promise<Response> {
  requireInteractiveSession(principal);
  if (principal.user.role === 'bot') return errorResponse('Bot users do not use recovery email');

  const previous = await env.DB.prepare('SELECT * FROM user_email_verifications WHERE user_id = ?')
    .bind(principal.user.id)
    .first<PendingVerification>();
  if (!previous) return errorResponse('No email verification is pending', 404);

  const state = await issueVerification(
    request,
    env,
    principal.user.id,
    previous.pending_email,
    previous.pending_email_normalized,
    previous,
  );
  return jsonResponse({ ok: true, verified: false, ...state });
}

function confirmationError(message: string, status = 400): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Email verification</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:5rem auto;padding:0 1.5rem"><h1>Email not verified</h1><p>${message}</p><p><a href="/">Return to Threads</a></p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleConfirmEmail(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) return confirmationError('This confirmation link is invalid or has expired.');
  const tokenHash = await hashToken(token);
  const pending = await env.DB.prepare('SELECT * FROM user_email_verifications WHERE token_hash = ?')
    .bind(tokenHash)
    .first<PendingVerification>();
  if (!pending || pending.expires_at <= nowSeconds()) {
    if (pending) {
      await env.DB.prepare('DELETE FROM user_email_verifications WHERE user_id = ?').bind(pending.user_id).run();
    }
    return confirmationError('This confirmation link is invalid or has expired.');
  }
  if (await emailBelongsToAnotherUser(env, pending.pending_email_normalized, pending.user_id)) {
    return confirmationError('That email address is already associated with another account.', 409);
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE users SET email = ?, email_normalized = ?, email_verified_at = unixepoch() WHERE id = ?',
      ).bind(pending.pending_email, pending.pending_email_normalized, pending.user_id),
      env.DB.prepare('DELETE FROM user_email_verifications WHERE user_id = ?').bind(pending.user_id),
    ]);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String((error as Error)?.message))) {
      return confirmationError('That email address is already associated with another account.', 409);
    }
    throw error;
  }
  const destination = new URL(appOrigin(env, request.url));
  destination.searchParams.set('email_verified', '1');
  return new Response(null, {
    status: 303,
    headers: {
      Location: destination.toString(),
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
    },
  });
}
