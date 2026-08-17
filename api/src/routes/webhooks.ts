import type { Env, User } from '../types.js';
import type { AuthPrincipal } from '../auth.js';
import { jsonResponse, errorResponse, readJsonObject } from '../utils.js';
import {
  createWebhookForToken,
  deleteWebhook,
  listWebhooks,
  resolveWebhookTokenForRequest,
} from '../lib/webhooks.js';

export async function handleListWebhooks(env: Env, user: User): Promise<Response> {
  return jsonResponse({ webhooks: await listWebhooks(env, user.id) });
}

export async function handleCreateWebhook(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
  const user = principal.user;
  const body = await readJsonObject<{ url?: string; token_id?: string }>(request).catch(() => null);
  if (!body || typeof body.url !== 'string') return errorResponse('url is required');

  let token: { token: string; credential_id: string; name: string } | null;
  try {
    token = await resolveWebhookTokenForRequest(principal, env, user.id, body.token_id);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
  if (!token) return errorResponse('API token not found', 404);

  try {
    return jsonResponse(await createWebhookForToken(env, user.id, token.token, token.credential_id, body.url), 201);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}

export async function handleDeleteWebhook(env: Env, user: User, webhookId: string): Promise<Response> {
  const deleted = await deleteWebhook(env, user.id, webhookId);
  if (!deleted) return errorResponse('Webhook not found', 404);
  return jsonResponse({ ok: true });
}
