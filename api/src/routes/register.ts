import type { MiddlewareHandler } from 'hono';
import { authenticatePrincipal } from '../auth.js';
import { errorResponse } from '../utils.js';
import { registerBasicAuthenticatedRoutes, registerBasicPublicRoutes } from './basic.js';
import { registerNonBasicAuthenticatedRoutes, registerNonBasicPublicRoutes } from './non-basic.js';
import type { HonoEnv, ThreadsApp } from './types.js';

export type { HonoEnv, ThreadsApp } from './types.js';
export { registerBasicAuthenticatedRoutes, registerBasicPublicRoutes } from './basic.js';
export { registerNonBasicAuthenticatedRoutes, registerNonBasicPublicRoutes } from './non-basic.js';

export type ApiRouteSet = 'core' | 'basic' | 'current';

function includesExtensionRoutes(routeSet: ApiRouteSet): boolean {
  return routeSet === 'current';
}

export function registerPublicRoutes(app: ThreadsApp, routeSet: ApiRouteSet = 'current'): void {
  registerBasicPublicRoutes(app);
  if (includesExtensionRoutes(routeSet)) {
    registerNonBasicPublicRoutes(app);
  }
}

export function registerAuthenticatedRoutes(authed: ThreadsApp, routeSet: ApiRouteSet = 'current'): void {
  registerBasicAuthenticatedRoutes(authed);
  if (includesExtensionRoutes(routeSet)) {
    registerNonBasicAuthenticatedRoutes(authed);
  }
}

export const authenticateRoutes: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const requiredScope = c.req.method === 'GET' || c.req.method === 'HEAD'
    ? 'threads:read'
    : 'threads:write';
  const principal = await authenticatePrincipal(c.req.raw, c.env, requiredScope);
  if (!principal) return errorResponse('Unauthorized', 401);
  c.set('principal', principal);
  c.set('user', principal.user);
  await next();
};
