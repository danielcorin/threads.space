import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  CallerContractError,
  CallerInputError,
  ThreadsApiError,
  createCaller,
  type ActionDescriptor,
  type JsonSchema,
} from '../../agent-tools/cli/src/index.js';
import { authenticate } from './auth.js';
import { getAllowedOrigins } from './lib/origins.js';
import type { Env } from './types.js';

export const MCP_PATH = '/mcp';
export const MCP_SERVER_INFO = { name: 'threads', version: '0.0.1' } as const;

type ApiFetch = (request: Request) => Promise<Response>;

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  return getAllowedOrigins(env).includes(origin);
}

function objectSchema(schema: JsonSchema, actionName: string, direction: 'input' | 'output'):
  Tool['inputSchema'] {
  if (schema.type !== 'object') {
    throw new Error(`MCP ${direction} schema for ${actionName} must have an object root`);
  }
  return schema as Tool['inputSchema'];
}

function mcpTool(action: ActionDescriptor): Tool {
  return {
    name: action.name,
    title: action.title,
    description: action.description,
    inputSchema: objectSchema(action.inputSchema, action.name, 'input'),
    outputSchema: objectSchema(action.outputSchema, action.name, 'output'),
    annotations: action.annotations,
    _meta: {
      'threads/operationIds': [...action.operationIds],
      'threads/requiredScopes': [...action.requiredScopes],
    },
  };
}

function knownToolError(error: unknown): string | null {
  if (error instanceof CallerInputError) return error.message;
  if (error instanceof ThreadsApiError) return `Threads API HTTP ${error.status}: ${error.message}`;
  if (error instanceof CallerContractError) return 'Threads API response violated its caller contract';
  return null;
}

function toolResult(output: unknown): CallToolResult {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Threads caller actions must return an object for MCP structured content');
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
    isError: false,
  };
}

function createThreadsMcpServer(token: string, requestOrigin: string, apiFetch: ApiFetch): Server {
  const caller = createCaller({
    baseUrl: requestOrigin,
    token,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== requestOrigin) {
        throw new Error('Caller attempted an unexpected cross-origin API request');
      }
      return apiFetch(request);
    }) as typeof globalThis.fetch,
  });
  const actions = caller.listActions();
  const actionNames = new Set(actions.map((action) => action.name));
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: 'Use Threads tools to read and participate in conversations. Start with list_conversations; use find_channels to resolve a public #channel, join_channel if needed, then send_message with its channel_id. get_thread accepts either a root or reply id. search_users resolves people, and create_dm_by_username opens a DM. Upload files before referencing their ids in messages.',
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: actions.map(mcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const actionName = request.params.name;
    if (!actionNames.has(actionName)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown Threads tool: ${actionName}`);
    }

    try {
      return toolResult(await caller.run(actionName, request.params.arguments ?? {}));
    } catch (error) {
      const message = knownToolError(error);
      if (!message) {
        console.error(`[mcp] ${actionName} failed`, error);
      }
      return {
        content: [{ type: 'text', text: message ?? 'Threads tool failed' }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Serve one stateless Streamable HTTP request using the same caller registry as
 * the CLI. The supplied apiFetch keeps tool calls inside this Worker while still
 * traversing the real Hono routes, auth middleware, and OpenAPI-shaped wire seam.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  apiFetch: ApiFetch,
): Promise<Response> {
  if (!originAllowed(request, env)) return jsonError(403, 'Forbidden origin');

  const token = bearerToken(request);
  if (!token || !(await authenticate(request, env))) {
    return jsonError(401, 'Unauthorized', {
      'WWW-Authenticate': 'Bearer realm="Threads MCP"',
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }), {
      status: 405,
      headers: {
        Allow: 'POST, OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  const origin = new URL(request.url).origin;
  const server = createThreadsMcpServer(token, origin, apiFetch);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
