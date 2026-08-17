import type { Env } from '../types.js';

export type AppEventName =
  | 'threads.auth.login'
  | 'threads.auth.logout'
  | 'threads.auth.password_changed'
  | 'threads.auth.password_reset'
  | 'threads.auth.token_created'
  | 'threads.auth.token_revoked'
  | 'threads.auth.mfa_enrollment_started'
  | 'threads.auth.mfa_enabled'
  | 'threads.auth.mfa_disabled'
  | 'threads.auth.mfa_policy_changed'
  | 'threads.auth.mfa_reset'
  | 'threads.message.sent';

type AppEventField = string | number | boolean | null | undefined;

/**
 * Emit one searchable application event to Cloudflare Workers Logs.
 *
 * Keep fields scalar so Cloudflare can index them predictably. Callers must not
 * include message content, usernames, credentials, cookies, tokens, or IPs.
 * Cloudflare supplies the event timestamp and invocation metadata.
 */
export function logAppEvent(
  env: Env,
  event: AppEventName,
  fields: Readonly<Record<string, AppEventField>> = {},
): void {
  const definedFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

  console.log({
    ...definedFields,
    event,
    event_schema: 'threads.app_event.v1',
    service: 'threads-api',
    environment: env.ENVIRONMENT || 'development',
  });
}
