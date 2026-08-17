import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCaller } from '../../../agent-tools/cli/src/index.js';
import { BASE_URL, authedFetch, json, loginUser } from './helpers.js';

const MCP_PROTOCOL_VERSION = '2025-11-25';

type JsonRpcResponse = {
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string };
};

function protocolHeaders(token?: string, method?: string, name?: string): HeadersInit {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(method ? { 'Mcp-Method': method } : {}),
    ...(name ? { 'Mcp-Name': name } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readProtocolResponse(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  if (!text) return {};
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length).trim()) as JsonRpcResponse);
    const message = messages.at(-1);
    if (!message) throw new Error(`MCP SSE response contained no data event: ${text}`);
    return message;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

function postMcp(
  body: Record<string, unknown>,
  options: { token?: string; origin?: string; cookie?: string } = {},
): Promise<Response> {
  const params = body.params as { name?: string } | undefined;
  return fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      ...protocolHeaders(options.token, String(body.method ?? ''), params?.name),
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('hosted MCP adapter', () => {
  let apiToken: string;
  let readOnlyToken: string;
  let sessionCookie: string;

  beforeAll(async () => {
    const login = await loginUser('__testadmin__');
    sessionCookie = login.cookie;
    const tokenResponse = await authedFetch(login.sessionToken, '/users/me/api-tokens', {
      method: 'POST',
      body: JSON.stringify({ name: `mcp-contract-${Date.now()}` }),
    });
    expect(tokenResponse.status).toBe(201);
    apiToken = (await json(tokenResponse)).token;
    const readOnlyResponse = await authedFetch(login.sessionToken, '/users/me/api-tokens', {
      method: 'POST',
      body: JSON.stringify({
        name: `mcp-read-only-${Date.now()}`,
        scopes: ['threads:read'],
      }),
    });
    expect(readOnlyResponse.status).toBe(201);
    readOnlyToken = (await json(readOnlyResponse)).token;
  });

  it('requires a bearer API token and does not accept a browser session cookie', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'threads-test', version: '1.0.0' },
      },
    };

    const anonymous = await postMcp(initialize);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');

    const cookieOnly = await postMcp(initialize, { cookie: sessionCookie });
    expect(cookieOnly.status).toBe(401);
  });

  it('rejects untrusted browser origins before handling protocol requests', async () => {
    const response = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {
      token: apiToken,
      origin: 'https://evil.example.com',
    });

    expect(response.status).toBe(403);
  });

  it('allows MCP protocol headers in same-instance CORS preflights', async () => {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8788',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version,mcp-method,mcp-name',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8788');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('mcp-protocol-version');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('mcp-method');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('mcp-name');
  });

  it('declines optional stateful streams and session teardown without hanging', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${BASE_URL}/mcp`, {
        method,
        headers: protocolHeaders(apiToken),
      });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST, OPTIONS');
    }
  });

  it('negotiates Streamable HTTP and publishes the caller registry as MCP tools', async () => {
    const initializeResponse = await postMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'threads-test', version: '1.0.0' },
      },
    }, { token: apiToken });
    expect(initializeResponse.status).toBe(200);
    const initialized = await readProtocolResponse(initializeResponse);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'threads', version: '0.0.1' },
      capabilities: { tools: {} },
    });

    const listResponse = await postMcp(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      { token: apiToken },
    );
    expect(listResponse.status).toBe(200);
    const listed = await readProtocolResponse(listResponse);
    expect(listed.error).toBeUndefined();

    const expectedActions = createCaller({
      baseUrl: BASE_URL,
      token: apiToken,
    }).listActions();
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(
      expectedActions.map((action) => action.name),
    );
    for (const [index, action] of expectedActions.entries()) {
      expect(listed.result.tools[index]).toMatchObject({
        name: action.name,
        title: action.title,
        description: action.description,
        inputSchema: action.inputSchema,
        outputSchema: action.outputSchema,
        annotations: action.annotations,
        _meta: {
          'threads/operationIds': action.operationIds,
          'threads/requiredScopes': action.requiredScopes,
        },
      });
    }
  });

  it('dispatches tool calls through caller.run with structured results and errors', async () => {
    const whoamiResponse = await postMcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }, { token: apiToken });
    expect(whoamiResponse.status).toBe(200);
    const whoami = await readProtocolResponse(whoamiResponse);
    expect(whoami.error).toBeUndefined();
    expect(whoami.result).toMatchObject({
      structuredContent: { username: '__testadmin__' },
      isError: false,
    });
    expect(JSON.parse(whoami.result.content[0].text)).toMatchObject({ username: '__testadmin__' });

    const invalidResponse = await postMcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { content: 'missing channel' } },
    }, { token: apiToken });
    expect(invalidResponse.status).toBe(200);
    const invalid = await readProtocolResponse(invalidResponse);
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0].text).toContain('Invalid input for send_message');
  });

  it('allows read-only MCP tools and blocks write tools at the API boundary', async () => {
    const whoamiResponse = await postMcp({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }, { token: readOnlyToken });
    expect(whoamiResponse.status).toBe(200);
    const whoami = await readProtocolResponse(whoamiResponse);
    expect(whoami.result.isError).toBe(false);

    const sendResponse = await postMcp({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: { channel_id: 'scope-check', content: 'must not send' },
      },
    }, { token: readOnlyToken });
    expect(sendResponse.status).toBe(200);
    const send = await readProtocolResponse(sendResponse);
    expect(send.result.isError).toBe(true);
    expect(send.result.content[0].text).toContain('threads:write');
  });

  it('interoperates with the official MCP Streamable HTTP client', async () => {
    const client = new Client({ name: 'threads-sdk-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiToken}` } },
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({ name: 'threads', version: '0.0.1' });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('whoami');

      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(result.structuredContent).toMatchObject({ username: '__testadmin__' });
    } finally {
      await client.close();
    }
  });
});
