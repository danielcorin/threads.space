# Threads hosted MCP

Each combined Threads deployment serves a remote MCP endpoint at:

```text
https://<instance>/mcp
```

The standalone API development Worker uses the same root path, for example
`http://localhost:8788/mcp`.

## Connect

The server uses stateless MCP Streamable HTTP. Supply a Threads API token on every
request:

```http
Authorization: Bearer <THREADS_API_TOKEN>
```

Use an MCP client that supports a remote URL plus custom request headers. Browser
session cookies are deliberately rejected. API tokens have `threads:read` and
`threads:write` scopes, enforced by the same REST authorization boundary used by
MCP tool calls. New tokens expire after 90 days by default; admins can choose a
different lifetime or explicitly create a non-expiring token. Store tokens as
secrets and revoke them from Threads user settings when they are no longer needed.

The current server is request/response only. It does not allocate an MCP session,
publish server-initiated notifications, or support resumability, so `GET` and
`DELETE` on `/mcp` return `405`. This keeps ordinary Threads actions stateless at
the edge; the protocol can gain durable sessions later without changing any tool.

## One synchronized tool contract

The MCP server does not declare tools itself. For every request it creates the same
caller used by the CLI and maps `caller.listActions()` directly to `tools/list`:

- action name, title, and description become MCP tool metadata;
- action input and output JSON Schemas are returned unchanged;
- read-only, destructive, idempotent, and open-world annotations are preserved;
- backing OpenAPI operation ids and enforced required scopes are exposed in tool
  `_meta`;
- `tools/call` dispatches only through `caller.run(name, arguments)`.

Successful calls return both JSON text content and MCP `structuredContent`. Invalid
caller input and documented API failures return MCP tool errors. The caller still
validates the API result against the OpenAPI-derived output schema before MCP returns
it to the client.

## Change workflow

1. Change the API route and canonical `api/openapi/threads.yaml` contract together.
2. Regenerate/check the OpenAPI clients with `npm --prefix api run openapi:check`.
3. Update `agent-tools/cli/src/actions.ts` only when the stable caller-facing
   action should change.
4. Run `npm --prefix agent-tools/cli run check`.
5. Run the live adapters with:

   ```bash
   npm --prefix api exec -- vitest run --root api \
     caller.integration.test.ts mcp.integration.test.ts
   ```

Pre-commit selects both live tests for agent-tools or OpenAPI changes. CI also
runs the full API suite and the dedicated OpenAPI/agent-tools contract job.

## Future OAuth discovery

The current bearer-token model already supports scoped, expiring credentials.
OAuth authorization and protected-resource discovery can wrap `/mcp` later for
clients that cannot accept a manually configured bearer token. That layer should
produce a credential for this same handler and must not create a second MCP tool
registry.
