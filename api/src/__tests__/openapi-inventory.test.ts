import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { BASIC_ROUTE_INVENTORY } from '../routes/basic.js';
import { NON_BASIC_ROUTE_INVENTORY } from '../routes/non-basic.js';
import bundledSpec from '../openapi-spec.json';
import bundledWsEventsSpec from '../ws-events-spec.json';
import bundledAgentsTxt from '../agents-txt.json';

type Route = { method: string; path: string };

type OpenApiOperation = {
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  'x-route-boundary'?: 'core' | 'extension';
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const INTENTIONALLY_UNDOCUMENTED_ROUTES = new Set<string>();
const MODELED_ROUTE_KEYS = [
  'POST /auth/login',
  'POST /auth/mfa/complete',
  'POST /auth/mfa/cancel',
  'POST /auth/logout',
  'POST /auth/change-password',
  'GET /auth/email/confirm',
  'POST /users',
  'GET /users/me',
  'PATCH /users/me',
  'GET /users/me/security',
  'POST /users/me/mfa/enrollment',
  'POST /users/me/mfa/enrollment/confirm',
  'DELETE /users/me/mfa',
  'POST /users/me/email/change',
  'POST /users/me/email/verification/resend',
  'GET /users/me/frequent-emojis',
  'GET /users/me/webhooks',
  'POST /users/me/webhooks',
  'DELETE /users/me/webhooks/{id}',
  'POST /bots/self/capabilities',
  'GET /users/search',
  'GET /presence',
  'GET /uploads/{key}',
  'POST /uploads',
  'GET /link-previews',
  'GET /dms',
  'POST /dms',
  'PUT /dms/reorder',
  'PATCH /dms/{id}/hide',
  'GET /channels',
  'POST /channels',
  'GET /channels/browse',
  'GET /channels/{id}',
  'PATCH /channels/{id}',
  'DELETE /channels/{id}',
  'POST /channels/{id}/join',
  'POST /channels/{id}/leave',
  'GET /channels/{id}/members',
  'POST /channels/{id}/members',
  'DELETE /channels/{id}/members/{targetUserId}',
  'DELETE /channels/{id}/membership',
  'PATCH /channels/{id}/notifications',
  'GET /folders',
  'POST /folders',
  'PATCH /folders/{id}',
  'DELETE /folders/{id}',
  'POST /folders/{id}/channels',
  'DELETE /folders/{id}/channels/{channelId}',
  'PUT /folders/reorder',
  'GET /drafts',
  'GET /channels/{id}/draft',
  'PUT /channels/{id}/draft',
  'GET /messages/{id}/replies',
  'POST /messages/{id}/replies',
  'PUT /messages/{id}/thread-title',
  'POST /messages/{id}/reactions',
  'DELETE /messages/{id}/reactions/{emoji}',
  'GET /mentions',
  'GET /search',
  'GET /channels/{id}/pins',
  'POST /channels/{id}/pins',
  'DELETE /channels/{id}/pins/{messageId}',
  'GET /channels/{id}/board',
  'POST /channels/{id}/board',
  'PUT /channels/{id}/board',
  'GET /push/vapid-key',
  'POST /push/subscribe',
  'DELETE /push/subscribe',
  'GET /push/preferences',
  'PUT /push/preferences',
  'GET /sync-state',
  'GET /sync-state/{key}',
  'PUT /sync-state/{key}',
  'GET /channels/{id}/saved-drafts',
  'POST /channels/{id}/saved-drafts',
  'DELETE /saved-drafts/{id}',
  'PATCH /saved-drafts/{id}/schedule',
  'POST /channels/{id}/board/cards',
  'PUT /boards/cards/{cardId}',
  'DELETE /boards/cards/{cardId}',
  'GET /boards/cards/{cardId}/activity',
  'POST /users/{id}/reset-password',
  'DELETE /users/{id}/api-tokens/{tokenId}',
  'DELETE /users/{id}',
  'DELETE /users/{id}/mfa',
  'GET /workspace/security',
  'PATCH /workspace/security',
  'GET /errors',
  'POST /channels/ephemeral',
  'POST /channels/{id}/archive',
  'DELETE /channels/{id}/archive',
  'POST /channels/{id}/rename',
  'POST /channels/{id}/promote',
  'POST /channels/{id}/regenerate-name',
  'GET /widgets',
  'POST /widgets',
  'GET /widgets/{id}',
  'PUT /widgets/{id}',
  'DELETE /widgets/{id}',
  'GET /channels/{id}/widgets',
  'POST /channels/{id}/widgets',
  'DELETE /channels/{id}/widgets/{widgetId}',
  'GET /w/{id}',
  'GET /widgets/{id}/data/kv/{key}/all',
  'GET /widgets/{id}/data/kv/{key}',
  'PUT /widgets/{id}/data/kv/{key}',
  'DELETE /widgets/{id}/data/kv/{key}',
] as const;

function normalizeHonoPath(path: string): string {
  return path
    .replace(/:([A-Za-z0-9_]+)\{\.\+\}/g, '{$1}')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/\*/g, '/{proxyPath}');
}

function routeKey(route: Route): string {
  return `${route.method.toUpperCase()} ${normalizeHonoPath(route.path)}`;
}

function openApiRouteKeys(document: OpenApiDocument): string[] {
  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.keys(pathItem)
      .filter((method) => HTTP_METHODS.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

function openApiOperationsByRouteKey(document: OpenApiDocument): Map<string, OpenApiOperation> {
  return new Map(
    Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]),
    ),
  );
}

function containsPlaceholder(value: unknown): boolean {
  return JSON.stringify(value).includes('Placeholder');
}

describe('OpenAPI route inventory', () => {
  const source = readFileSync(fileURLToPath(new URL('../../openapi/threads.yaml', import.meta.url).href), 'utf8');
  const document = parse(source) as OpenApiDocument;

  it('represents every registered HTTP route and has no orphan path operations', () => {
    const registered = new Set(
      [...BASIC_ROUTE_INVENTORY, ...NON_BASIC_ROUTE_INVENTORY]
        .map(routeKey)
        .filter((key) => !INTENTIONALLY_UNDOCUMENTED_ROUTES.has(key)),
    );
    const documented = new Set(openApiRouteKeys(document));

    expect([...registered].filter((key) => !documented.has(key)).sort()).toEqual([]);
    expect([...documented].filter((key) => !registered.has(key)).sort()).toEqual([]);
  });

  it('classifies every operation with a core or extension route boundary matching the registration split', () => {
    const operations = openApiOperationsByRouteKey(document);
    const coreRoutes = new Set(BASIC_ROUTE_INVENTORY.map(routeKey));
    const extensionRoutes = new Set(NON_BASIC_ROUTE_INVENTORY.map(routeKey));

    for (const [key, operation] of operations) {
      const expected = coreRoutes.has(key) ? 'core' : extensionRoutes.has(key) ? 'extension' : undefined;
      expect(operation['x-route-boundary'], `${key} should declare its route boundary`).toBe(expected);
    }
  });

  it('keeps the bundled openapi-spec.json in sync with the yaml source', () => {
    // src/openapi-spec.json is served by GET /openapi.json (Workers can't read
    // the filesystem at runtime). Regenerate with: npm run openapi:bundle
    expect(bundledSpec).toEqual(document);
  });

  it('keeps the bundled ws-events-spec.json in sync with the yaml source', () => {
    // src/ws-events-spec.json is served by GET /ws-events.json (Workers can't read
    // the filesystem at runtime). Regenerate with: npm run openapi:bundle
    const wsSource = readFileSync(fileURLToPath(new URL('../../openapi/ws-events.yaml', import.meta.url).href), 'utf8');
    expect(bundledWsEventsSpec).toEqual(parse(wsSource));
  });

  it('keeps the bundled agents-txt.json in sync with the root agents.txt', () => {
    // src/agents-txt.json is served verbatim by GET /agents.txt (Workers can't read the
    // filesystem at runtime). Regenerate with: npm run openapi:bundle
    const agentsSource = readFileSync(fileURLToPath(new URL('../../../agents.txt', import.meta.url).href), 'utf8');
    expect(bundledAgentsTxt).toEqual(agentsSource);
  });

  it('keeps the modeled auth/user routes off placeholder schemas', () => {
    const operations = openApiOperationsByRouteKey(document);

    for (const key of MODELED_ROUTE_KEYS) {
      const operation = operations.get(key);
      expect(operation, `${key} should be documented`).toBeDefined();
      expect(operation?.description).not.toContain('Contract skeleton entry');
      expect(containsPlaceholder(operation), `${key} should not reference placeholder schemas`).toBe(false);
    }
  });
});
