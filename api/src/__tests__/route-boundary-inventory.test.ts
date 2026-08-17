import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASIC_API_GROUPS, NON_BASIC_API_GROUPS } from '../core/kernel.js';
import { BASIC_ROUTE_INVENTORY } from '../routes/basic.js';
import { NON_BASIC_ROUTE_INVENTORY } from '../routes/non-basic.js';
import { registerAuthenticatedRoutes, registerPublicRoutes } from '../routes/register.js';
import type { ThreadsApp } from '../routes/types.js';

type RouteInventory = readonly { method: string; path: string }[];
type BoundaryGroup = readonly { name: string; routes: readonly string[] }[];

function registeredRoutes(moduleUrl: string): RouteInventory {
  const source = readFileSync(fileURLToPath(moduleUrl), 'utf8');
  return [...source.matchAll(/(?:app|authed)\.(get|post|put|patch|delete)\('([^']+)'/g)].map((match) => ({
    method: match[1].toUpperCase(),
    path: match[2],
  }));
}

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function recordRegisteredRoutes(register: (app: ThreadsApp) => void): RouteInventory {
  const routes: { method: string; path: string }[] = [];
  const app = {
    get: (path: string) => routes.push({ method: 'GET', path }),
    post: (path: string) => routes.push({ method: 'POST', path }),
    put: (path: string) => routes.push({ method: 'PUT', path }),
    patch: (path: string) => routes.push({ method: 'PATCH', path }),
    delete: (path: string) => routes.push({ method: 'DELETE', path }),
  };
  register(app as unknown as ThreadsApp);
  return routes;
}

function routeMatchesPattern(routePath: string, pattern: string): boolean {
  const routeSegments = routePath.split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const routeSegment = routeSegments[index];

    if (patternSegment === '*') return true;
    if (routeSegment === undefined) return false;
    if (patternSegment.startsWith(':')) continue;
    if (patternSegment !== routeSegment) return false;
  }

  return routeSegments.length === patternSegments.length;
}

function routesWithoutBoundaryGroup(inventory: RouteInventory, groups: BoundaryGroup): string[] {
  return inventory
    .filter((route) => !groups.some((group) => group.routes.some((pattern) => routeMatchesPattern(route.path, pattern))))
    .map(routeKey);
}

describe('route boundary inventory', () => {
  it('keeps basic route registration classified in the basic inventory', () => {
    const registered = registeredRoutes(new URL('../routes/basic.ts', import.meta.url).href).map(routeKey);
    const inventoried = BASIC_ROUTE_INVENTORY.map(routeKey);
    expect(inventoried).toEqual(registered);
  });

  it('keeps non-basic route registration classified in the non-basic inventory', () => {
    const registered = registeredRoutes(new URL('../routes/non-basic.ts', import.meta.url).href).map(routeKey);
    const inventoried = NON_BASIC_ROUTE_INVENTORY.map(routeKey);
    expect(inventoried).toEqual(registered);
  });

  it('keeps basic and non-basic registrations disjoint at method/path granularity', () => {
    const basic = new Set(BASIC_ROUTE_INVENTORY.map(routeKey));
    const nonBasic = new Set(NON_BASIC_ROUTE_INVENTORY.map(routeKey));
    const overlap = [...basic].filter((route) => nonBasic.has(route));
    expect(overlap).toEqual([]);
  });

  it('can register only the core backend route set', () => {
    const publicRoutes = recordRegisteredRoutes((app) => registerPublicRoutes(app, 'core'));
    const authenticatedRoutes = recordRegisteredRoutes((app) => registerAuthenticatedRoutes(app, 'core'));

    expect([...publicRoutes, ...authenticatedRoutes].map(routeKey)).toEqual(BASIC_ROUTE_INVENTORY.map(routeKey));
  });

  it('keeps basic as a backwards-compatible alias for the core backend route set', () => {
    const publicRoutes = recordRegisteredRoutes((app) => registerPublicRoutes(app, 'basic'));
    const authenticatedRoutes = recordRegisteredRoutes((app) => registerAuthenticatedRoutes(app, 'basic'));

    expect([...publicRoutes, ...authenticatedRoutes].map(routeKey)).toEqual(BASIC_ROUTE_INVENTORY.map(routeKey));
  });

  it('keeps current route registration as basic plus non-basic by default', () => {
    const publicRoutes = recordRegisteredRoutes(registerPublicRoutes);
    const authenticatedRoutes = recordRegisteredRoutes(registerAuthenticatedRoutes);
    const registered = new Set([...publicRoutes, ...authenticatedRoutes].map(routeKey));

    expect(registered).toEqual(new Set([
      ...BASIC_ROUTE_INVENTORY.map(routeKey),
      ...NON_BASIC_ROUTE_INVENTORY.map(routeKey),
    ]));
  });

  it('keeps every basic route represented by a named basic API group', () => {
    expect(routesWithoutBoundaryGroup(BASIC_ROUTE_INVENTORY, BASIC_API_GROUPS)).toEqual([]);
  });

  it('keeps every non-basic route represented by a named non-basic API group', () => {
    expect(routesWithoutBoundaryGroup(NON_BASIC_ROUTE_INVENTORY, NON_BASIC_API_GROUPS)).toEqual([]);
  });
});
