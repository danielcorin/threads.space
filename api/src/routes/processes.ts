import { requireChannelMembership } from '../middleware.js';
import { ProcessReadModel } from '../read-models/processes.js';
import { ProcessService } from '../services/processes.js';
import type { Env, User } from '../types.js';
import { errorResponse, jsonResponse, readJsonObject } from '../utils.js';

// Writes that advance a process (create/update/activity) are the agent reporting its own
// progress, so they are restricted to bot principals. Reads and cancellation are open to
// any channel member (admins see/act everywhere) so a human can manage a runaway turn.
function requireBot(user: User): Response | null {
  if (user.role !== 'bot' && !user.is_admin) {
    return errorResponse('Only bots can report process state', 403);
  }
  return null;
}

export async function handleListProcesses(env: Env, user: User, url: URL): Promise<Response> {
  const processes = await new ProcessReadModel(env).listProcesses(user, {
    status: url.searchParams.get('status'),
  });
  return jsonResponse({ processes });
}

export async function handleGetProcess(env: Env, user: User, processId: string): Promise<Response> {
  const process = await new ProcessReadModel(env).getProcessDetail(processId);
  if (!process) return errorResponse('Process not found', 404);

  if (!user.is_admin) await requireChannelMembership(env, user.id, process.channel_id);

  return jsonResponse(process);
}

export async function handleCreateProcess(request: Request, env: Env, user: User, ctx?: ExecutionContext): Promise<Response> {
  const botError = requireBot(user);
  if (botError) return botError;

  const input = await readJsonObject<{
    id?: string;
    channel_id: string;
    message_id: string;
    user_id?: string;
    status?: string;
    bot_id?: string;
  }>(request);

  if (!input.channel_id) return errorResponse('channel_id required');
  if (!input.message_id) return errorResponse('message_id required');
  if (input.bot_id && input.bot_id !== user.id && !user.is_admin) {
    return errorResponse('Bots may only create processes they own', 403);
  }

  await requireChannelMembership(env, user.id, input.channel_id);

  const service = new ProcessService(env, ctx);
  if (input.status && !service.isValidStatus(input.status)) {
    return errorResponse('Invalid status. Must be: queued, running, done, error, killed');
  }

  const message = await env.DB.prepare(
    'SELECT channel_id, deleted_at FROM messages WHERE id = ?'
  ).bind(input.message_id).first<{ channel_id: string; deleted_at: number | null }>();
  if (!message || message.deleted_at !== null) return errorResponse('Message not found', 404);
  if (message.channel_id !== input.channel_id) {
    return errorResponse('message_id does not belong to channel_id');
  }

  const result = await service.createProcess(input, user);
  return jsonResponse(result, 201);
}

export async function handleCleanupProcessesByBot(env: Env, user: User, ctx?: ExecutionContext): Promise<Response> {
  const botError = requireBot(user);
  if (botError) return botError;

  const result = await new ProcessService(env, ctx).cleanupProcessesByBot(user.id);
  return jsonResponse(result);
}

export async function handleKillAllProcesses(env: Env, user: User, ctx?: ExecutionContext): Promise<Response> {
  const result = await new ProcessService(env, ctx).killAllProcesses(user);
  return jsonResponse(result);
}

export async function handleUpdateProcess(request: Request, env: Env, user: User, processId: string, ctx?: ExecutionContext): Promise<Response> {
  const botError = requireBot(user);
  if (botError) return botError;

  const body = await readJsonObject<{
    status?: string;
    tool_call_count?: number;
    reply_count?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }>(request);
  const service = new ProcessService(env, ctx);

  if (body.status && !service.isValidStatus(body.status)) {
    return errorResponse('Invalid status. Must be: queued, running, done, error, killed');
  }

  if (!body.status && body.tool_call_count === undefined && body.reply_count === undefined && body.input_tokens === undefined && body.output_tokens === undefined && body.cache_creation_input_tokens === undefined && body.cache_read_input_tokens === undefined) {
    return errorResponse('status or metrics (tool_call_count, reply_count, input_tokens, output_tokens) required');
  }

  const process = await new ProcessReadModel(env).getProcess(processId);
  if (!process) return errorResponse('Process not found', 404);

  if (!user.is_admin) await requireChannelMembership(env, user.id, process.channel_id);
  if (!user.is_admin && process.bot_id !== user.id) {
    return errorResponse('Only the owning bot may update this process', 403);
  }

  if (!await service.updateProcess(process, body)) {
    return errorResponse('Process is already terminal', 409);
  }
  return jsonResponse({ ok: true });
}

export async function handleProcessActivity(request: Request, env: Env, user: User, processId: string, ctx?: ExecutionContext): Promise<Response> {
  const botError = requireBot(user);
  if (botError) return botError;

  const body = await readJsonObject<{
    type: 'tool_call' | 'reply' | 'token_usage';
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }>(request);

  if (body.type !== 'tool_call' && body.type !== 'reply' && body.type !== 'token_usage') {
    return errorResponse('type must be tool_call, reply, or token_usage');
  }

  const process = await new ProcessReadModel(env).getProcess(processId);
  if (!process) return errorResponse('Process not found', 404);

  if (!user.is_admin) await requireChannelMembership(env, user.id, process.channel_id);
  if (!user.is_admin && process.bot_id !== user.id) {
    return errorResponse('Only the owning bot may record activity for this process', 403);
  }

  if (!await new ProcessService(env, ctx).recordActivity(process, body)) {
    return errorResponse('Process is already terminal', 409);
  }
  return jsonResponse({ ok: true });
}

// Cooperative cancellation: any channel member (or admin) can request a kill. The service
// marks the row `killed` and signals the owning agent over WS + webhook.
export async function handleKillProcess(env: Env, user: User, processId: string, ctx?: ExecutionContext): Promise<Response> {
  const process = await new ProcessReadModel(env).getProcess(processId);
  if (!process) return errorResponse('Process not found', 404);

  if (!user.is_admin) await requireChannelMembership(env, user.id, process.channel_id);

  if (process.status !== 'running' && process.status !== 'queued') {
    return errorResponse('Process is not running or queued', 400);
  }

  if (!await new ProcessService(env, ctx).killProcess(process)) {
    return errorResponse('Process is not running or queued', 400);
  }
  return jsonResponse({ ok: true });
}
