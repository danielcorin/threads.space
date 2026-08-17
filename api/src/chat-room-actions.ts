import { handleAddReaction } from './routes/reactions.js';
import { handleUpdateProcessStatus } from './routes/messages.js';
import { handleCreateProcess, handleProcessActivity, handleUpdateProcess } from './routes/processes.js';
import { createMessage, MessageCreationError } from './services/messages.js';
import { assertCredentialActive, type AuthCredential } from './auth.js';
import { errorResponse } from './utils.js';
import type { ApiTokenScope } from './lib/api-token-policy.js';
import type { Env, User } from './types.js';

export interface ConnectionMeta {
  userId: string;
  username: string;
  displayName: string | null;
  nameColor: string | null;
  role: string | null;
  credentialKind: AuthCredential['kind'];
  credentialId: string;
  credentialScopes: ApiTokenScope[] | null;
  credentialExpiresAt: number;
}

export function credentialMetaFromUrl(url: URL): Pick<ConnectionMeta,
  'credentialKind' | 'credentialId' | 'credentialScopes' | 'credentialExpiresAt'> {
  const kind = url.searchParams.get('credentialKind');
  const id = url.searchParams.get('credentialId');
  const expiresAt = Number(url.searchParams.get('credentialExpiresAt'));
  const rawScopes = url.searchParams.get('credentialScopes');
  if ((kind !== 'bearer' && kind !== 'session') || !id || !Number.isFinite(expiresAt)) {
    throw new Error('Missing credential metadata');
  }
  let scopes: ApiTokenScope[] | null = null;
  if (kind === 'bearer') {
    try {
      const parsed: unknown = JSON.parse(rawScopes || '[]');
      scopes = Array.isArray(parsed)
        ? parsed.filter((scope): scope is ApiTokenScope => typeof scope === 'string') as ApiTokenScope[]
        : [];
    } catch {
      scopes = [];
    }
  }
  return {
    credentialKind: kind,
    credentialId: id,
    credentialScopes: scopes,
    credentialExpiresAt: expiresAt,
  };
}

interface ChatRoomActionContext {
  env: Env;
  ws: WebSocket;
  meta: ConnectionMeta;
  message: string | ArrayBuffer;
  onTypingStart: (ws: WebSocket, meta: ConnectionMeta, threadId: string | null) => void;
  onTypingStop: (ws: WebSocket, meta: ConnectionMeta, threadId: string | null) => void;
  /** Defer background work past the action's lifetime (DO ctx.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function dispatchChatRoomAction(ctx: ChatRoomActionContext): Promise<string> {
  const { message, ws } = ctx;
  if (typeof message !== 'string') return 'unknown';

  let data: Record<string, unknown> | null = null;
  let msgType = 'unknown';

  try {
    data = parseAction(message);
    msgType = typeof data.type === 'string' ? data.type : 'unknown';

    if (data.type !== 'ping') {
      const credential = credentialFromMeta(ctx.meta);
      if (credential.scopes !== null && !credential.scopes.has('threads:write')) {
        throw errorResponse('API token lacks required scope: threads:write', 403);
      }
      await assertCredentialActive(ctx.env, credential);
    }

    switch (data.type) {
      case 'typing_start':
        ctx.onTypingStart(ws, ctx.meta, typeof data.threadId === 'string' ? data.threadId : null);
        break;
      case 'typing_stop':
        ctx.onTypingStop(ws, ctx.meta, typeof data.threadId === 'string' ? data.threadId : null);
        break;
      case 'mark_read':
        // Handled by REST API, but acknowledge.
        break;
      case 'message.create':
        await handleMessageCreate(ctx, data);
        break;
      case 'reaction.add':
        await handleReactionAdd(ctx, data);
        break;
      case 'process.create':
        await handleProcessCreate(ctx, data);
        break;
      case 'process.update':
        await handleProcessUpdate(ctx, data);
        break;
      case 'process.activity':
        await handleProcessActivityAction(ctx, data);
        break;
      case 'message.process_status':
        await handleMessageProcessStatus(ctx, data);
        break;
      case 'ping':
        // App-level keepalive — reply with pong. Protocol-level WebSocket ping/pong
        // is unreliable through Cloudflare's edge proxy, so clients use JSON messages.
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        sendActionError(ws, data.actionId ?? null, 400, {
          error: `Unsupported WebSocket action: ${String(data.type ?? 'unknown')}`,
        });
        break;
    }
  } catch (e) {
    // Handlers (requireChannelMembership etc.) throw Response for authz
    // failures — forward the real status/body so a bot sees a permanent 403
    // instead of a retryable 500 reading "[object Response]".
    if (e instanceof MessageCreationError) {
      sendActionError(ws, data?.actionId ?? null, e.status, { error: e.message });
    } else if (e instanceof Response) {
      let body: unknown;
      try {
        body = await e.clone().json();
      } catch {
        body = await e.text().catch(() => null);
      }
      sendActionError(ws, data?.actionId ?? null, e.status, body);
      if (e.status === 401) ws.close(4001, 'Credential revoked or expired');
    } else if (e instanceof WsProtocolError) {
      // The client sent something malformed. That is a permanent 400, not a
      // 500: bots retry on 5xx, so reporting a bad frame as a server fault
      // turned one buggy client into a retry loop against this Durable Object.
      sendActionError(ws, data?.actionId ?? null, 400, { error: e.message });
    } else if (e instanceof SyntaxError) {
      // JSON.parse in parseAction — likewise the client's fault.
      sendActionError(ws, data?.actionId ?? null, 400, { error: 'WebSocket message must be valid JSON' });
    } else {
      console.error('WebSocket message error:', e);
      sendActionError(ws, data?.actionId ?? null, 500, e instanceof Error ? e.message : String(e));
    }
  }

  return msgType;
}

/**
 * A malformed or incomplete client frame. Distinguished from a genuine server
 * fault so dispatchChatRoomAction can answer 400 rather than 500 — the
 * difference between a client that stops and a client that retries forever.
 */
export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

function credentialFromMeta(meta: ConnectionMeta): AuthCredential {
  return {
    kind: meta.credentialKind,
    id: meta.credentialId,
    scopes: meta.credentialScopes === null ? null : new Set(meta.credentialScopes),
    expiresAt: meta.credentialExpiresAt,
  };
}

function parseAction(message: string): Record<string, unknown> {
  const parsed = JSON.parse(message);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WsProtocolError('WebSocket message must be an object');
  }
  return parsed as Record<string, unknown>;
}

function userFromMeta(meta: ConnectionMeta): User {
  return {
    id: meta.userId,
    username: meta.username,
    display_name: meta.displayName,
    name_color: meta.nameColor,
    role: meta.role,
  } as User;
}

function jsonRequest(body: Record<string, unknown>): Request {
  return new Request('https://ws.local/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function respondAction(ws: WebSocket, actionId: unknown, response: Response, okType: string): Promise<void> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => null);
  }

  if (!response.ok) {
    sendActionError(ws, actionId ?? null, response.status, body);
    return;
  }

  sendActionResult(ws, actionId, okType, response.status, body);
}

function sendActionResult(
  ws: WebSocket,
  actionId: unknown,
  action: string,
  status: number,
  result: unknown,
): void {
  ws.send(JSON.stringify({
    type: 'action_result',
    actionId: actionId ?? null,
    action,
    status,
    result,
  }));
}

function sendActionError(ws: WebSocket, actionId: unknown, status: number, error: unknown): void {
  ws.send(JSON.stringify({ type: 'action_error', actionId: actionId ?? null, status, error }));
}

/**
 * `as string` on a WebSocket payload field is the same empty promise that
 * request.json<T>() makes over HTTP: the value is whatever the client sent. An
 * object in `content` used to reach createMessage and die on `content?.trim()`,
 * which surfaced as a 500 — a retryable status for input that will never
 * succeed. These narrow instead, so a bad field is a permanent 400.
 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new WsProtocolError(`${field} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new WsProtocolError(`${field} must be an array of strings`);
  }
  return value as string[];
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WsProtocolError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function handleMessageCreate(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  const channelId = typeof data.channelId === 'string' ? data.channelId : null;
  if (!channelId) throw new WsProtocolError('message.create requires channelId');
  const background = ctx.waitUntil
    ? { waitUntil: ctx.waitUntil }
    : undefined;
  const result = await createMessage(ctx.env, {
    actor: userFromMeta(ctx.meta),
    channelId,
    content: optionalString(data.content, 'content') ?? '',
    threadId: optionalString(data.threadId ?? data.parentId, 'threadId') ?? null,
    attachmentIds: optionalStringArray(data.attachmentIds, 'attachmentIds'),
    metadata: optionalObject(data.metadata, 'metadata'),
    messageType: optionalString(data.message_type ?? data.messageType, 'message_type'),
  }, background);
  sendActionResult(
    ctx.ws,
    data.actionId,
    'message.create',
    result.outcome === 'created' ? 201 : 200,
    result.message,
  );
}

async function handleReactionAdd(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  if (typeof data.messageId !== 'string') throw new WsProtocolError('reaction.add requires messageId');
  if (typeof data.emoji !== 'string') throw new WsProtocolError('emoji must be a string');
  const executionCtx = ctx.waitUntil
    ? ({ waitUntil: ctx.waitUntil, passThroughOnException: () => {}, props: {} } as ExecutionContext)
    : undefined;
  const response = await handleAddReaction(jsonRequest({ emoji: data.emoji }), ctx.env, userFromMeta(ctx.meta), data.messageId, executionCtx);
  await respondAction(ctx.ws, data.actionId, response, 'reaction.add');
}

async function handleProcessCreate(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  const response = await handleCreateProcess(
    jsonRequest({
      id: data.id,
      channel_id: data.channel_id ?? data.channelId,
      message_id: data.message_id ?? data.messageId,
      user_id: data.user_id ?? data.userId,
      status: data.status,
      bot_id: data.bot_id ?? data.botUserId,
    }),
    ctx.env,
    userFromMeta(ctx.meta),
  );
  await respondAction(ctx.ws, data.actionId, response, 'process.create');
}

async function handleProcessUpdate(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  const processId = data.processId ?? data.id;
  if (typeof processId !== 'string') throw new WsProtocolError('process.update requires processId');
  const response = await handleUpdateProcess(jsonRequest(data), ctx.env, userFromMeta(ctx.meta), processId);
  await respondAction(ctx.ws, data.actionId, response, 'process.update');
}

async function handleProcessActivityAction(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  if (typeof data.processId !== 'string') throw new WsProtocolError('process.activity requires processId');
  const activityType = data.activityType ?? data.activity_type ?? data.processActivityType;
  if (typeof activityType !== 'string') throw new WsProtocolError('process.activity requires activityType');
  const response = await handleProcessActivity(
    jsonRequest({
      type: activityType,
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      cache_creation_input_tokens: data.cache_creation_input_tokens,
      cache_read_input_tokens: data.cache_read_input_tokens,
    }),
    ctx.env,
    userFromMeta(ctx.meta),
    data.processId,
  );
  await respondAction(ctx.ws, data.actionId, response, 'process.activity');
}

async function handleMessageProcessStatus(ctx: ChatRoomActionContext, data: Record<string, unknown>): Promise<void> {
  if (typeof data.messageId !== 'string') throw new WsProtocolError('message.process_status requires messageId');
  const response = await handleUpdateProcessStatus(
    jsonRequest({
      processId: data.processId,
      status: data.status,
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      cache_creation_input_tokens: data.cache_creation_input_tokens,
      cache_read_input_tokens: data.cache_read_input_tokens,
      error_text: data.error_text,
    }),
    ctx.env,
    userFromMeta(ctx.meta),
    data.messageId,
  );
  await respondAction(ctx.ws, data.actionId, response, 'message.process_status');
}
