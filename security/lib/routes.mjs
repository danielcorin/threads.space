// Route enumeration + the destructive-route denylist.
//
// The route inventories in api/src/routes/{basic,non-basic}.ts are the
// authoritative list of every endpoint (they are already asserted against the
// real Hono registrations by src/__tests__/route-boundary-inventory.test.ts, so
// they cannot silently drift). We parse them out of the TypeScript source with a
// regex rather than importing them — same approach that test file uses — which
// keeps this suite dependency-free and runnable as plain node.
//
// The payoff: a route added to the API is automatically fuzzed. Coverage does
// not depend on anyone remembering to update this directory.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(HERE, '..', '..', 'api', 'src', 'routes');

const INVENTORY_FILES = [
  { file: 'basic.ts', symbol: 'CORE_ROUTE_INVENTORY', tier: 'basic' },
  { file: 'non-basic.ts', symbol: 'EXTENSION_ROUTE_INVENTORY', tier: 'extension' },
];

/**
 * Routes this suite must never call, with the reason. These are excluded from
 * BOTH probes and reported as uncovered at the end of every run — silently
 * skipping them would make the report read like full coverage when it isn't.
 *
 * The bar for inclusion is "a successful call destroys the target or our own
 * ability to keep testing", not "this looks scary".
 */
export const DENYLIST = new Map([
  ['DELETE /users/:id', 'Deletes a real user; the sweep would target the admin running the suite.'],
  ['POST /auth/logout', 'Revokes the session the suite is authenticating with.'],
  ['POST /auth/change-password', 'Would lock the suite (and you) out of the instance.'],
  ['POST /users/:id/reset-password', 'Rotates a real user password on the target instance.'],
  ['POST /processes/kill-all', 'Mass-terminates every running process on the instance.'],
  ['POST /processes/cleanup-by-bot', 'Bulk-deletes process rows belonging to a bot.'],
  ['DELETE /users/me/mfa', 'Disables MFA on the account under test.'],
  ['DELETE /users/:id/mfa', 'Disables MFA on another account.'],
  ['PATCH /workspace/security', 'Mutates instance-wide security policy (e.g. MFA enforcement) for every user.'],
  ['POST /transcribe', 'Bills a third-party speech-to-text provider per call.'],
  ['DELETE /users/me/api-tokens/:id', 'Revokes API tokens, including ones the suite or your agents depend on.'],
  ['DELETE /users/:id/api-tokens/:tokenId', 'Revokes another user\'s API tokens.'],
]);

export function routeKey(route) {
  return `${route.method} ${route.path}`;
}

/** Parse `{ method: 'GET', path: '/x' }` entries out of one inventory export. */
function parseInventory(source, symbol) {
  const start = source.indexOf(`export const ${symbol} = [`);
  if (start === -1) throw new Error(`Could not find ${symbol} — the route inventory moved or was renamed.`);
  const end = source.indexOf('] as const;', start);
  if (end === -1) throw new Error(`Could not find the end of ${symbol}.`);
  const block = source.slice(start, end);

  const routes = [];
  for (const m of block.matchAll(/\{\s*method:\s*'([A-Z]+)',\s*path:\s*'([^']+)'\s*\}/g)) {
    routes.push({ method: m[1], path: m[2] });
  }
  if (!routes.length) throw new Error(`${symbol} parsed to zero routes — the inventory format changed.`);
  return routes;
}

/**
 * Every route the API exposes, split into what we will exercise and what we
 * refuse to touch.
 */
export function loadRoutes() {
  const all = [];
  for (const { file, symbol, tier } of INVENTORY_FILES) {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    for (const route of parseInventory(source, symbol)) {
      all.push({ ...route, tier, key: routeKey(route) });
    }
  }

  const testable = all.filter((r) => !DENYLIST.has(r.key));
  const excluded = all
    .filter((r) => DENYLIST.has(r.key))
    .map((r) => ({ ...r, reason: DENYLIST.get(r.key) }));

  return { all, testable, excluded };
}

/**
 * Fill `:param` placeholders from a fixture map. Returns null when a parameter
 * has no fixture — the caller reports that route as uncovered rather than
 * substituting a fabricated id, which would only ever produce a meaningless 404.
 */
export function fillPath(path, fixtures) {
  const missing = [];
  // `:key{.+}` is Hono's regex-constrained param (used by /uploads and
  // /sync-state); strip the constraint before looking the name up.
  const filled = path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, (_, name) => {
    const value = fixtures[name];
    if (value === undefined || value === null) {
      missing.push(name);
      return `:${name}`;
    }
    return encodeURIComponent(value);
  });
  return missing.length ? { path: null, missing } : { path: filled, missing: [] };
}
