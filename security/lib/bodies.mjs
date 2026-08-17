// Minimal VALID request bodies, per route.
//
// Both probes need these, for opposite reasons:
//
//   authz  — a body good enough to get past the handler's required-field check
//            and reach the authorization logic. Without it,
//            POST /channels/:id/members returns 400 "userId required" and the
//            sweep learns nothing about whether the route is guarded.
//   input  — a valid baseline to pair with a mutated QUERY STRING, so that the
//            finding reads "this query param broke it" rather than re-discovering
//            the empty-body crash and mislabelling it.
//
// Longest-match-wins on the route path. Anything unmatched gets `{}`, which is
// still valid JSON and still gets past request.json().

/**
 * `memberUserId` decides whose membership a /members body grants, and getting it
 * wrong silently destroys the suite's credibility.
 *
 * The authz sweep runs AS the attacker and must name the attacker: "can a
 * non-member add themselves to a private channel?" is the whole test. The input
 * probe runs as the VICTIM ADMIN, where that same body succeeds legitimately —
 * and once the attacker is a member, every later authorization oracle sees real
 * access and reports it as a breach. That produced four fabricated HIGH findings
 * (non-member WebSocket upgrade, identity smuggling, cross-channel writes) at
 * one seed and none at another, which is exactly how a fuzzer loses trust.
 *
 * So the input probe names the BOT instead: already a member, so the body stays
 * valid and mutates nothing the oracles depend on.
 */
export function validBodyFor(route, ctx, { memberUserId } = {}) {
  const p = route.path;
  const label = `${ctx.run} probe`;
  const member = memberUserId ?? ctx.attacker.id;

  if (p.endsWith('/messages') || p.endsWith('/replies')) return { content: label };
  if (p.endsWith('/members')) return { userId: member };
  if (p.endsWith('/reactions')) return { emoji: '👀' };
  if (p.endsWith('/pins')) return { messageId: ctx.ids.messageId };
  if (p.endsWith('/board/cards')) return { title: label };
  if (p.endsWith('/saved-drafts')) return { content: label };
  if (p.endsWith('/draft')) return { content: label };
  if (p.endsWith('/widgets')) return { widgetId: ctx.ids.widgetId };
  if (p.endsWith('/rename')) return { name: `${ctx.run}-renamed` };
  if (p.endsWith('/thread-title')) return { title: label };
  if (p.endsWith('/notifications')) return { level: 'all' };
  if (p.endsWith('/folders')) return { name: `${ctx.run}-folder` };
  if (p === '/channels') return { name: `${ctx.run}-chan`, description: label };
  if (p === '/dms') return { userId: member };
  if (p === '/dms/reorder') return { order: [] };
  if (p === '/folders/reorder') return { folders: [] };
  if (p === '/processes') return { channel_id: ctx.ids.channelId, message_id: ctx.ids.messageId, status: 'running' };
  if (p === '/auth/login') return { username: ctx.attacker.username, password: 'wrong-password-on-purpose' };
  if (p === '/uploads') return {};
  if (p.startsWith('/boards/cards/')) return { title: label };
  if (p.includes('/data/kv/')) return { value: label };
  if (p.startsWith('/sync-state/')) return { value: label };
  if (p.startsWith('/push/')) return { endpoint: 'https://example.invalid/push', keys: { p256dh: 'x', auth: 'y' } };
  if (route.method === 'PATCH' && p === '/channels/:id') return { description: label };

  return {};
}
