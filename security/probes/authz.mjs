// Probe 1 — authorization sweep (the IDOR hunt).
//
// Threads enforces authorization per handler, by hand: ~38 call sites of
// requireChannelMembership / authenticateForChannel across ~140 routes. That
// pattern fails open — a new handler that forgets the check is silently
// readable by anyone. This probe replays EVERY route in the inventory against a
// resource owned by someone else and asserts nobody gets in.
//
// Oracles:
//   A. An authenticated-only route answers 2xx with no credentials.
//      -> authentication bypass. HIGH.
//   B. A logged-in non-member gets 2xx on a path containing a victim-owned id.
//      -> broken object-level authorization (IDOR). HIGH.
//   C. A non-member gets 403/404 but the body leaks victim data anyway.
//      -> information disclosure through the error path. MEDIUM.
//
// Reads run before writes so a destructive authorization bug (say, an
// unguarded DELETE) cannot wipe the fixtures other checks depend on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request, mapLimit } from '../lib/target.mjs';
import { fillPath } from '../lib/routes.mjs';
import { fixturesForRoute } from '../lib/fixtures.mjs';
import { validBodyFor } from '../lib/bodies.mjs';
import { recordCreation } from '../lib/cleanup.mjs';

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'src', 'routes');

/**
 * Routes where a non-member 2xx is the DESIGNED behaviour, with the source that
 * proves it. Two shapes qualify:
 *
 *   - workspace-wide resources (the widget library is deliberately visible to
 *     every authenticated user)
 *   - caller-scoped keyspaces, where the SQL itself carries `user_id = ?`, so a
 *     "successful" write only ever touches the caller's own row
 *
 * These are reported as notes, never suppressed silently. Each entry cites the
 * line that justifies it — if the design changes, the citation goes stale and
 * the exemption is visible in review rather than buried.
 */
const SHARED_BY_DESIGN = new Map([
  ['GET /widgets', 'Widgets are a workspace-wide library — handleListWidgets returns every widget to any authenticated user (api/src/routes/widgets.ts:7).'],
  ['GET /widgets/:id', 'Same workspace-wide widget library (api/src/routes/widgets.ts:14).'],
  ['GET /w/:id', 'Widget runtime for the shared library (api/src/routes/non-basic.ts).'],
  ['GET /widgets/:id/data/kv/:key', 'widget_kv rows are keyed by user_id — a caller only ever reads their own namespace (api/src/routes/widget-data.ts:19).'],
  ['PUT /widgets/:id/data/kv/:key', 'widget_kv writes are scoped to the caller\'s user_id (api/src/routes/widget-data.ts).'],
  ['DELETE /widgets/:id/data/kv/:key', 'widget_kv deletes are scoped to the caller\'s user_id (api/src/routes/widget-data.ts).'],
  ['GET /sync-state/:key{.+}', 'sync_state keys are namespaced `<user.id>:<key>` server-side (api/src/routes/sync-state.ts:7).'],
  ['PUT /sync-state/:key{.+}', 'sync_state keys are namespaced `<user.id>:<key>` server-side (api/src/routes/sync-state.ts:7).'],
  ['GET /channels/:id/draft', 'Drafts are per-user rows selected by user_id (api/src/routes/drafts.ts:30).'],
  ['PUT /channels/:id/draft', 'Drafts are per-user rows written against the caller\'s user_id (api/src/routes/drafts.ts).'],
  ['POST /channels/:id/leave', 'DELETE FROM channel_members WHERE channel_id = ? AND user_id = ? — a no-op for a non-member (api/src/routes/channels.ts:505).'],
  ['DELETE /folders/:id/channels/:channelId', 'DELETE scoped by user_id — a no-op against another user\'s folder (api/src/routes/folders.ts:136).'],
]);

/**
 * Which routes are registered on the public app vs behind authenticateRoutes.
 * Parsed from source (`app.get(...)` vs `authed.get(...)`) so the classification
 * tracks the code instead of a hand-kept list that silently rots.
 */
function loadPublicRoutes() {
  const publicKeys = new Set();
  for (const file of ['basic.ts', 'non-basic.ts']) {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    for (const m of source.matchAll(/\bapp\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      publicKeys.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return publicKeys;
}

/** Query strings for routes whose behaviour is driven by search params. */
function probeQuery(route) {
  if (route.path === '/search') return '?query=fuzz';
  if (route.path === '/link-previews') return '?url=https://example.com';
  return '';
}

/**
 * Does the response body leak the victim's private data? The fixtures are
 * labelled with the run id, so any echo of it to a non-member is a leak we can
 * attribute with certainty rather than guess at.
 */
function leaksVictimData(text, ctx) {
  if (!text) return null;
  if (text.includes(ctx.run)) return `response echoes the run-labelled private fixture ("${ctx.run}")`;
  if (ctx.ids.messageId && text.includes(ctx.ids.messageId)) return 'response contains the victim\'s private message id';
  return null;
}

export async function run(ctx, report) {
  const publicKeys = loadPublicRoutes();
  const targets = [];

  for (const route of ctx.routes) {
    const fixtures = fixturesForRoute(route, ctx.ids);
    const { path, missing } = fillPath(route.path, fixtures);
    if (!path) {
      report.skip(route, `no fixture for :${missing.join(', :')} — could not build a request against a victim-owned resource`);
      continue;
    }
    // Only paths that actually carry a victim-owned id can demonstrate an IDOR;
    // for the rest (GET /channels, GET /inbox) a 200 for the attacker is just
    // the attacker reading their own empty account, which is correct behaviour.
    const referencesVictimResource = /:/.test(route.path)
      && Object.values(fixturesForRoute(route, ctx.ids)).some((v) => v && path.includes(encodeURIComponent(v)));

    targets.push({
      route,
      path: path + probeQuery(route),
      // A valid body so the request reaches the authorization logic instead of
      // bouncing off a required-field check.
      body: route.method === 'GET' ? undefined : validBodyFor(route, ctx),
      isPublic: publicKeys.has(route.key),
      referencesVictimResource,
    });
  }

  // Reads first, then mutations (see header).
  const reads = targets.filter((t) => t.route.method === 'GET');
  const writes = targets.filter((t) => t.route.method !== 'GET');

  for (const wave of [reads, writes]) {
    await mapLimit(wave, async (t) => {
      const opts = { method: t.route.method, body: t.body };

      // --- Oracle A: no credentials at all ---
      if (!t.isPublic) {
        const anon = await request(t.path, opts);
        if (anon.status >= 200 && anon.status < 300) {
          report.add({
            severity: 'high',
            probe: 'authz',
            title: 'Authenticated route answers an unauthenticated request',
            detail: `${t.route.key} is registered behind authenticateRoutes, but returned ${anon.status} with no session cookie and no bearer token.`,
            route: t.route.key,
            response: anon,
          });
        } else if (anon.status !== 401 && anon.status !== 403 && anon.status !== 0) {
          // Not a vulnerability by itself, but a route that 404s or 400s before
          // authenticating has evaluated attacker-controlled input pre-auth.
          report.note(`${t.route.key} returns ${anon.status} (not 401/403) to an unauthenticated caller — it processes input before rejecting.`);
        }
      }

      // --- Oracles B & C: authenticated non-member ---
      const attacker = await request(t.path, { ...opts, token: ctx.attacker.token });

      // A 5xx anywhere in the sweep is free signal for the input probe's oracle:
      // the handler faulted rather than deciding. Worth reporting wherever seen.
      if (attacker.status >= 500) {
        report.add({
          severity: 'medium',
          probe: 'authz',
          title: 'Handler faults instead of authorizing',
          detail:
            `${t.route.key} returned ${attacker.status} to a non-member. An authorization decision should be ` +
            `403/404, not a server error — and a 5xx here means attacker-controlled input reached logic that threw.`,
          route: t.route.key,
          response: attacker,
          dedupeKey: `authz|5xx|${t.route.key}`,
        });
      }

      // The attacker's valid-body POSTs create real rows; track them for teardown.
      recordCreation(ctx, t.route, attacker, { asAttacker: true });

      const exemption = SHARED_BY_DESIGN.get(t.route.key);
      if (t.referencesVictimResource && attacker.status >= 200 && attacker.status < 300 && exemption) {
        report.note(`${t.route.key} answered a non-member with ${attacker.status} — expected: ${exemption}`);
      } else if (t.referencesVictimResource && attacker.status >= 200 && attacker.status < 300) {
        report.add({
          severity: 'high',
          probe: 'authz',
          title: 'Non-member reached another user\'s resource',
          detail:
            `${t.route.key} returned ${attacker.status} for a logged-in user who is NOT a member of the target ` +
            `private channel and does not own the resource. Expected 403 or 404.`,
          route: t.route.key,
          response: attacker,
        });
      } else if (t.referencesVictimResource) {
        const leak = leaksVictimData(attacker.text, ctx);
        if (leak) {
          report.add({
            severity: 'medium',
            probe: 'authz',
            title: 'Rejection response leaks private data',
            detail: `${t.route.key} correctly returned ${attacker.status} to a non-member, but ${leak}.`,
            route: t.route.key,
            response: attacker,
          });
        }
      }
    });
  }

  // A 2xx only proves the handler answered. This proves the attacker actually
  // changed something the victim can see.
  await confirmVictimVisibleImpact(ctx, report);

  // --- Credential-shaped checks that no single route covers ------------------
  await forgedCredentialChecks(ctx, report);
}

/**
 * Read the victim's private channel back AS THE VICTIM and look for anything
 * the attacker left behind.
 *
 * This is the difference between "the endpoint returned 200" and "a user who
 * was never in this channel has written into it". Several handlers legitimately
 * return 200 while scoping their SQL to the caller's own rows, so a status code
 * alone over-reports; persisted, victim-visible state does not.
 */
async function confirmVictimVisibleImpact(ctx, report) {
  const { channelId, messageId } = ctx.ids;
  const attackerId = ctx.attacker.id;
  const attackerName = ctx.attacker.username;
  const traces = (text) => text.includes(attackerId) || text.includes(attackerName);

  const checks = [
    { path: `/channels/${channelId}/members`, what: 'the private channel\'s member list' },
    { path: `/channels/${channelId}/messages?limit=100`, what: 'the private channel\'s message list' },
    messageId ? { path: `/messages/${messageId}`, what: 'the private message itself' } : null,
  ].filter(Boolean);

  const hits = [];
  let evidence = null;
  for (const check of checks) {
    const res = await request(check.path, { token: ctx.victim.token });
    if (res.status === 200 && traces(res.text)) {
      hits.push(`${check.what} (${check.path})`);
      evidence ??= res;
    }
  }

  if (!hits.length) return;

  // One bug, however many reads reveal it. Reporting each read separately would
  // inflate the count and bury the single root cause.
  report.add({
    severity: 'high',
    probe: 'authz',
    title: 'Non-member state is persisted and visible inside a private channel',
    detail:
      `Reading back AS THE VICTIM, the attacker account (${attackerName}) appears in: ${hits.join('; ')}. ` +
      `The attacker was never a member of this private channel, so this is a persisted cross-account write, ` +
      `not just a permissive status code. The reaction handlers are the likely source: handleAddReaction and ` +
      `handleRemoveReaction resolve a message by id and never call requireChannelMembership, unlike ` +
      `handleGetMessage which does (api/src/routes/reactions.ts:5 vs api/src/routes/messages.ts:306).`,
    route: 'POST /messages/:id/reactions',
    response: evidence,
  });
}

/**
 * Authentication is only as strong as its rejection of malformed credentials.
 * These are the shapes an attacker actually sends: a bearer token where a
 * session is expected, SQL metacharacters in the token, a revoked-looking id.
 */
async function forgedCredentialChecks(ctx, report) {
  const probePath = '/users/me';
  const forged = [
    { label: 'empty bearer', init: { bearer: ' ' } },
    { label: 'SQL metacharacters in bearer', init: { bearer: "' OR 1=1 --" } },
    { label: 'SQL metacharacters in session cookie', init: { token: "' OR 1=1 --" } },
    { label: 'the victim\'s user id used as a token', init: { bearer: ctx.ids.victimId } },
    { label: 'null byte in session cookie', init: { token: '%00' } },
    { label: 'very long bearer token', init: { bearer: 'A'.repeat(8192) } },
  ];

  await mapLimit(forged, async (f) => {
    const res = await request(probePath, f.init);
    if (res.status >= 200 && res.status < 300) {
      report.add({
        severity: 'high',
        probe: 'authz',
        title: 'Forged credential accepted',
        detail: `GET ${probePath} returned ${res.status} for ${f.label}.`,
        route: `GET ${probePath}`,
        response: res,
      });
    } else if (res.status >= 500) {
      report.add({
        severity: 'medium',
        probe: 'authz',
        title: 'Malformed credential crashes authentication',
        detail:
          `GET ${probePath} returned ${res.status} for ${f.label}. Authentication should reject bad ` +
          `credentials with 401, not fault — a 5xx here is a denial-of-service lever against login.`,
        route: `GET ${probePath}`,
        response: res,
      });
    }
  });
}
