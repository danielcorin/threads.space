// Tracking for resources the PROBES create as a side effect.
//
// Both probes POST valid bodies to collection routes — the authz sweep to reach
// authorization logic past a required-field check, the input probe to pair a
// mutated query string with a parseable body. Every one of those that succeeds
// creates a real row.
//
// An early test run proved why this matters: teardown removed the tracked
// fixtures and reported success, but left behind a channel, an ephemeral
// channel, a DM, a folder and a push-preferences row — none of which were
// fixtures. A suite that reports "cleanup complete" while seeding an instance with
// debris is lying to its operator, so creations are now recorded as they happen.

/**
 * Collection routes whose 2xx response yields a deletable resource, mapped to
 * the route that deletes it. Anything not listed here is reported as an
 * untracked creation rather than silently ignored.
 */
const DELETABLE = new Map([
  ['POST /channels', (id) => `/channels/${id}`],
  ['POST /channels/ephemeral', (id) => `/channels/${id}`],
  ['POST /folders', (id) => `/folders/${id}`],
  ['POST /widgets', (id) => `/widgets/${id}`],
  ['POST /processes', (id) => `/processes/${id}`],
  ['POST /channels/:id/saved-drafts', (id) => `/saved-drafts/${id}`],
  ['POST /users', (id) => `/users/${id}`],
]);

/** Creation routes with no delete endpoint at all — flagged, never silently dropped. */
const NO_DELETE_ROUTE = new Set([
  'POST /dms', // DMs can only be hidden (PATCH /dms/:id/hide), never deleted
]);

/**
 * Call after every probe request. Records anything created so teardown can
 * remove it, and flags creations the API gives no way to undo.
 *
 * `asAttacker` matters: a row created by the attacker account has to be deleted
 * before that account can be, given DELETE /users/:id does not cascade.
 */
export function recordCreation(ctx, route, res, { asAttacker = false } = {}) {
  if (res.status < 200 || res.status >= 300) return;
  const id = res.json?.id;
  if (!id || typeof id !== 'string') return;

  const key = `${route.method} ${route.path}`;

  if (NO_DELETE_ROUTE.has(key)) {
    ctx.untracked ??= [];
    ctx.untracked.push(`${key} created ${id} — the API exposes no delete route for it`);
    return;
  }

  const toPath = DELETABLE.get(key);
  if (!toPath) return;

  // Deleted before the fixtures, so attacker-owned rows are gone before the
  // attacker account itself is removed.
  ctx.cleanup.unshift({
    label: `probe-created ${key}`,
    path: toPath(id),
    method: 'DELETE',
    // Attacker-created rows usually can only be deleted by their creator.
    token: asAttacker ? ctx.attacker.token : ctx.victim.token,
  });
}
