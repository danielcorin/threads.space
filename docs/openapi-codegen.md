# OpenAPI contract and generated clients

The Threads contract is two documents: the REST API in `api/openapi/threads.yaml` and the
WebSocket event payload schemas in `api/openapi/ws-events.yaml`.

For the versioned bundle, standalone CLI artifacts, release naming, and the
`threads-agent-bridge` consumption flow, see
[`docs/api-contract.md`](api-contract.md).

## Fetching the spec from a running instance

A live instance publishes both documents (CORS-open, no repo access needed) — this is how
an external bot author gets the contract:

```bash
curl https://<instance>/api/openapi.json      # REST contract
curl https://<instance>/api/ws-events.json    # WebSocket event schemas
curl https://<instance>/api/cli.json          # compatible public CLI + provenance
open  https://<instance>/api/docs             # interactive reference (both documents)
```

(On a standalone API dev server these are served at the root: `/openapi.json`,
`/ws-events.json`, `/docs` — no `/api` prefix.) Point a generator straight at a URL:

```bash
npx openapi-typescript https://<instance>/api/openapi.json   -o threads.d.ts
npx openapi-typescript https://<instance>/api/ws-events.json -o ws-events.d.ts
```

The served JSON is bundled from the YAML sources into `api/src/{openapi,ws-events}-spec.json`
(Workers can't read the filesystem at runtime). Regenerate after editing either YAML:

```bash
npm --prefix api run openapi:bundle
```

A drift test (`api/src/__tests__/openapi-inventory.test.ts`) fails if a bundled JSON falls
out of sync with its YAML source.

## Commands

```bash
npm --prefix api run openapi:bundle
npm --prefix api run openapi:lint
npm --prefix api run openapi:types
npm --prefix api run openapi:python-client
npm --prefix api run openapi:clients
npm --prefix api run openapi:clients:check
npm --prefix api run openapi:check
npm run api:contract:check
npm run cli:artifacts:build -- --target host
```

Generated artifacts are written under `api/generated/` and are intentionally ignored by git. Regenerate them locally or in CI instead of committing them.

`openapi:clients` is the one-shot generation command for both currently supported clients:

- TypeScript operation/schema declarations: `api/generated/types/threads.d.ts`
- Python package for non-TypeScript integrations: `api/generated/python/threads-api-client`

The first-party caller runtime in `agent-tools/cli/` pairs the generated
TypeScript declarations with `openapi-fetch`. Its public interface is
deliberately smaller than the raw API:

```ts
const caller = createCaller({ baseUrl, token });
caller.listActions();
await caller.run('search_messages', { query: 'release status', limit: 10 });
```

`agent-tools/cli/src/actions.ts` is the single caller-action registry. It contains stable action
names, CLI commands, goal-oriented descriptions, input schemas, MCP-compatible safety
annotations, required future OAuth scopes, backing OpenAPI operation ids, and execution
logic. Output schemas are bundled directly from the OpenAPI component schemas and both
inputs and API results are validated at the `caller.run()` seam.

The CLI and hosted `/mcp` server are only adapters over that registry; neither owns
an endpoint list or request implementation. MCP maps `listActions()` directly to
`tools/list` and dispatches `tools/call` through `run()` rather than re-declaring
tools. See [`docs/mcp.md`](mcp.md) for the hosted transport contract.

`openapi:clients:check` regenerates both clients, verifies the expected artifacts exist, smoke-imports representative Python client classes/models, and runs `ruff` over the generated Python package. `openapi:check` includes this client-generation check so generator regressions fail with the normal OpenAPI validation path.

## Client contract for integrations

Generated clients should use the OpenAPI `servers` list as defaults and still make the base URL configurable per environment:

- local development: `http://localhost:8788`
- production: `https://threads.example.com/api`

For non-browser integrations, prefer user API-token auth with `Authorization: Bearer <token>` (`bearerAuth`). The `session` cookie scheme exists for browser sessions established by `POST /auth/login`. Admin-only operator endpoints (e.g. `DELETE /users/:id`, `GET /errors`) use the same session/bearer auth and are gated on the user's `is_admin` flag.

All documented JSON errors use the shared `{ "error": string }` envelope. Generated clients should treat documented 4xx/5xx responses as parsed `Error` models and branch on HTTP status codes. Configure clients to raise/fail on truly undocumented statuses when possible (for the generated Python client, `raise_on_unexpected_status=True`).

## Python client

The Python client command uses `openapi-python-client` in a local `api/.venv-openapi` virtualenv managed by `api/scripts/generate-python-client.sh`:

```bash
npm --prefix api run openapi:python-client
```

Python integrations should consume the generated client from `api/generated/python/threads-api-client` (or the equivalent CI artifact) rather than hand-writing duplicate request/response models.

Minimal Python-side shape:

```python
from threads_api_client import AuthenticatedClient

client = AuthenticatedClient(
    base_url="https://threads.example.com/api",
    token=threads_user_api_token,
    raise_on_unexpected_status=True,
)
```

## Endpoint change workflow

1. Change the Hono route/handler.
2. Update `api/openapi/threads.yaml` for the same path and method.
3. Replace placeholder schemas with precise request/response schemas when the route is part of the CLI or agent-facing surface.
4. Run `npm --prefix api run openapi:check`.
5. When an operation backs a caller action, run
   `npm --prefix agent-tools/cli run check` and
   update the action only if its goal-level interface should change.

CI runs both checks plus live CLI/caller and MCP adapter tests. A backing
`operationId` removal, generated request type change, invalid action input, or
response that violates its canonical output schema fails at the shared caller seam.

`api/src/__tests__/openapi-inventory.test.ts` fails if a registered HTTP route is missing from the OpenAPI document or if the OpenAPI document contains an orphan operation.

## WebSockets

HTTP upgrade endpoints (`GET /ws/:channelId`, `GET /ws/presence`) are represented in `api/openapi/threads.yaml`. The JSON payloads exchanged over those sockets — channel events, the `message.create`/`reaction.add` actions, and presence — live in `api/openapi/ws-events.yaml`, served at `GET /ws-events.json`. `npm run openapi:lint` and `npm run openapi:types` validate/generate both the REST contract and the realtime event contract.

Two caveats the schemas don't capture, which a bot author still needs (see the [`echo-bot` reference](../examples/echo-bot/README.md)):

- **Discriminators.** `openapi-typescript` rewrites each event's `type` to the schema name (e.g. `"MessageEvent"`), but the value on the wire is the OpenAPI `const` (`"message"`). Narrow on the wire value and re-map.
- **Protocol choreography** OpenAPI can't express: Bearer auth on the WS upgrade header, the app-level `{type:"ping"}`/`{type:"pong"}` keepalive (reversed on the presence socket), the mention/auto-respond decision rules, and the bot-loop circuit breaker.
