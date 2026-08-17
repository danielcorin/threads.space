// Principals and the victim-owned resources the probes aim at.
//
// The authz sweep needs a resource that genuinely belongs to someone else, so
// this builds:
//
//   victim    the configured admin (SECURITY_USERNAME). Owns a PRIVATE channel
//             and everything inside it. Private matters — public channels are
//             browsable by design, so a 200 there proves nothing.
//   attacker  a throwaway non-admin human user, created for the run and deleted
//             afterwards. Never joins the victim's channel. Any 2xx it gets on a
//             victim-owned resource is a real finding.
//   anonymous no credentials at all.
//
// Fixture creation is best-effort: a resource that fails to create is reported
// as uncovered rather than silently skipped, so the run's coverage is honest.

import { request } from './target.mjs';

/** Unique per run so concurrent or abandoned runs never collide, and stray rows are obviously fuzz debris. */
export function runLabel() {
  return `sec-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function create(label, path, options, pick, out) {
  const res = await request(path, options);
  if (res.status >= 200 && res.status < 300) {
    const value = pick(res.json);
    if (value !== undefined && value !== null) return value;
    out.push({ label, reason: `created but the response had no usable id (status ${res.status})` });
    return null;
  }
  out.push({ label, reason: `${options.method ?? 'GET'} ${path} -> ${res.status || res.error} ${res.text.slice(0, 160)}` });
  return null;
}

/**
 * Build principals + victim-owned fixtures. Returns the context every probe
 * runs against, plus `unavailable`: fixtures we could not create.
 */
export async function setup(run, victimToken) {
  const unavailable = [];
  const cleanup = [];

  const me = await request('/users/me', { token: victimToken });
  if (me.status !== 200) throw new Error(`GET /users/me as the victim failed: ${me.status} ${me.text.slice(0, 200)}`);
  const victim = me.json;

  // Admin status is not exposed on GET /users/me, so it is established by
  // attempting the admin-gated action below rather than checked up front.

  // --- attacker -------------------------------------------------------------
  const attackerName = `${run}-attacker`;
  const attackerPassword = `Fz-${run}-${Math.random().toString(36).slice(2)}`;
  const attackerId = await create('attacker user', '/users', {
    method: 'POST',
    token: victimToken,
    body: {
      username: attackerName,
      password: attackerPassword,
      email: `${attackerName}@fuzz.invalid`,
      displayName: 'security suite attacker',
      role: 'human',
    },
  }, (j) => j?.id, unavailable);

  if (!attackerId) {
    const reason = unavailable.at(-1)?.reason ?? 'unknown';
    const hint = /40[13]/.test(reason)
      ? `POST /users is admin-gated, so "${victim.username}" is almost certainly not an admin on this instance. ` +
        `Point SECURITY_USERNAME at an admin account — the suite needs one to create the attacker and a private channel.`
      : 'Check that the account can reach POST /users.';
    throw new Error(`Could not create the attacker account, so no authorization check would be meaningful.\n  Reason: ${reason}\n  ${hint}`);
  }
  // Controlled, targeted teardown of a user WE created — distinct from the
  // sweep, which denylists DELETE /users/:id so it can never hit a real account.
  cleanup.push({ label: 'attacker user', path: `/users/${attackerId}`, method: 'DELETE' });

  const { login } = await import('./target.mjs');
  const attackerToken = await login(attackerName, attackerPassword);

  // --- victim-owned resources ----------------------------------------------
  const channelId = await create('private channel', '/channels', {
    method: 'POST',
    token: victimToken,
    body: { name: `${run}-private`, description: 'security suite fixture', isPrivate: true },
  }, (j) => j?.id, unavailable);

  // Deleting the channel cascades its messages, reactions, threads, pins,
  // boards, drafts and attachments — so this one entry covers most fixtures.
  if (channelId) cleanup.unshift({ label: 'private channel', path: `/channels/${channelId}`, method: 'DELETE' });

  const messageId = channelId && await create('message', `/channels/${channelId}/messages`, {
    method: 'POST',
    token: victimToken,
    body: { content: `${run} fixture message` },
  }, (j) => j?.id, unavailable);

  const savedDraftId = channelId && await create('saved draft', `/channels/${channelId}/saved-drafts`, {
    method: 'POST',
    token: victimToken,
    body: { content: `${run} fixture draft` },
  }, (j) => j?.id, unavailable);

  const boardOk = channelId && await create('kanban board', `/channels/${channelId}/board`, {
    method: 'POST', token: victimToken, body: {},
  }, (j) => j?.id ?? 'created', unavailable);

  const cardId = boardOk && await create('kanban card', `/channels/${channelId}/board/cards`, {
    method: 'POST', token: victimToken, body: { title: `${run} fixture card` },
  }, (j) => j?.id, unavailable);

  const folderId = await create('folder', '/folders', {
    method: 'POST', token: victimToken, body: { name: `${run}-folder` },
  }, (j) => j?.id, unavailable);
  if (folderId) cleanup.push({ label: 'folder', path: `/folders/${folderId}`, method: 'DELETE' });

  const widgetId = await create('widget', '/widgets', {
    method: 'POST',
    token: victimToken,
    body: { name: `${run}-widget`, code: 'export default () => null;' },
  }, (j) => j?.id, unavailable);
  if (widgetId) cleanup.push({ label: 'widget', path: `/widgets/${widgetId}`, method: 'DELETE' });

  // --- bot principal --------------------------------------------------------
  // POST /processes is gated on requireBot(), so a human admin can never create
  // a process fixture and the four /processes/:id routes would go untested.
  // Agents are a first-class concept here, so the bot surface is worth covering.
  const botName = `${run}-bot`;
  const botId = await create('bot user', '/users', {
    method: 'POST',
    token: victimToken,
    body: { username: botName, password: `Fz-${run}-bot`, displayName: 'security suite bot', role: 'bot' },
  }, (j) => j?.id, unavailable);

  let botToken = null;
  let botTokenId = null;
  if (botId) {
    cleanup.push({ label: 'bot user', path: `/users/${botId}`, method: 'DELETE' });
    const minted = await create('bot api token', `/users/${botId}/api-tokens`, {
      method: 'POST', token: victimToken, body: { name: `${run}-bot-token` },
    }, (j) => (j?.token ? { token: j.token, id: j.id } : null), unavailable);
    botToken = minted?.token ?? null;
    botTokenId = minted?.id ?? null;
    if (channelId) {
      await request(`/channels/${channelId}/members`, {
        method: 'POST', token: victimToken, body: { userId: botId },
      });
    }
  }

  const processId = botToken && channelId && messageId && await create('process', '/processes', {
    method: 'POST',
    bearer: botToken,
    body: { channel_id: channelId, message_id: messageId, status: 'running' },
  }, (j) => j?.id, unavailable);
  if (processId) cleanup.push({ label: 'process', path: `/processes/${processId}`, method: 'DELETE' });

  const tokenId = await create('api token', '/users/me/api-tokens', {
    method: 'POST', token: victimToken, body: { name: `${run}-token` },
  }, (j) => j?.id, unavailable);
  // Not cleaned up via the sweep-denylisted revoke route; done explicitly below.
  if (tokenId) cleanup.push({ label: 'api token', path: `/users/me/api-tokens/${tokenId}`, method: 'DELETE' });

  return {
    run,
    victim: { user: victim, token: victimToken },
    attacker: { id: attackerId, username: attackerName, token: attackerToken },
    bot: { id: botId, token: botToken, tokenId: botTokenId },
    ids: { channelId, messageId, savedDraftId, cardId, folderId, widgetId, processId, tokenId, attackerId, victimId: victim.id },
    unavailable,
    cleanup,
  };
}

/**
 * Resolve `:param` placeholders for ONE route. The inventory reuses `:id`
 * across resource families (/channels/:id, /folders/:id, /widgets/:id ...), so
 * the value depends on the route's prefix — a global param map would point
 * /widgets/:id at a channel id and turn every result into a meaningless 404.
 */
export function fixturesForRoute(route, ids) {
  const p = route.path;
  const common = { targetUserId: ids.attackerId, widgetId: ids.widgetId, channelId: ids.channelId };

  if (p.startsWith('/channels/')) return { ...common, id: ids.channelId, messageId: ids.messageId };
  if (p.startsWith('/messages/')) return { ...common, id: ids.messageId, emoji: '👍' };
  if (p.startsWith('/folders/')) return { ...common, id: ids.folderId };
  if (p.startsWith('/widgets/') || p.startsWith('/w/')) return { ...common, id: ids.widgetId, key: 'fuzz-key' };
  if (p.startsWith('/processes/')) return { ...common, id: ids.processId };
  if (p.startsWith('/saved-drafts/')) return { ...common, id: ids.savedDraftId };
  if (p.startsWith('/boards/cards/')) return { ...common, cardId: ids.cardId };
  if (p.startsWith('/users/me/api-tokens')) return { ...common, id: ids.tokenId };
  if (p.startsWith('/users/')) return { ...common, id: ids.victimId, tokenId: ids.tokenId };
  if (p.startsWith('/dms/')) return { ...common, id: ids.channelId };
  if (p.startsWith('/ws/')) return { ...common, channelId: ids.channelId };
  if (p.startsWith('/sync-state/')) return { ...common, key: 'fuzz-sync-key' };
  if (p.startsWith('/uploads/')) return { ...common, key: 'nonexistent-fuzz-object' };
  return common;
}

/**
 * Best-effort teardown. Never throws — a failed cleanup must not mask findings.
 *
 * Returns both what was left behind AND any 5xx the cleanup provoked. Teardown
 * exercises admin delete paths that the sweep denylists as too destructive to
 * call blindly, so it is the only place those routes get hit — a server error
 * here is real signal, not noise to swallow.
 */
export async function teardown(ctx) {
  const leftovers = [];
  const serverErrors = [];
  for (const item of ctx.cleanup) {
    try {
      const res = await request(item.path, { method: item.method, token: item.token ?? ctx.victim.token });
      if (res.status >= 500) serverErrors.push({ label: item.label, method: item.method, path: item.path, response: res });
      // 404 means the row is already gone — usually cascaded away with its
      // parent channel. That is cleanup succeeding, so reporting it as a
      // leftover would send the operator hunting for something that isn't there.
      if (res.status >= 400 && res.status !== 404) {
        leftovers.push(`${item.label} (${item.path} -> ${res.status})`);
      }
    } catch (err) {
      leftovers.push(`${item.label} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { leftovers, serverErrors };
}
