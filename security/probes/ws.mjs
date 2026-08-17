// Probe 3 — WebSocket / Durable Object action fuzzing.
//
// The WebSocket surface is the weakest-covered part of the trust boundary,
// because authentication and authorization split across two layers:
//
//   1. The API Worker authenticates the upgrade (GET /ws/:channelId), then
//      deliberately DROPS the Authorization and Cookie headers and re-encodes
//      the principal as URL SEARCH PARAMS on an internal request to the Durable
//      Object (addCredentialToSocketUrl / internalWebSocketRequest in
//      api/src/routes/basic.ts). ChatRoom trusts those params completely —
//      `url.searchParams.get('userId')!` IS the caller's identity.
//   2. Individual actions re-check authorization themselves. Notably
//      handleMessageCreate reads `channelId` FROM THE PAYLOAD, not from the
//      socket's channel, and relies on createMessage's membership check.
//
// So there are two structural questions worth attacking, and this probe asks
// both directly:
//   - Can a client smuggle its own userId/credential params through the upgrade
//     URL and have the DO believe them?
//   - Can a socket legitimately opened on channel A act on channel B?
//
// Oracles:
//   A. A non-member or anonymous client completes the upgrade.      HIGH.
//   B. An action succeeds against a channel the caller can't access. HIGH.
//   C. Injected identity params change who the DO thinks you are.    HIGH.
//   D. A malformed frame produces a 500-status action error, or
//      kills the connection.                                         MEDIUM.
//   E. An action succeeds after its credential was revoked.          HIGH.

import WebSocket from 'ws';
import { request, resolveWsUrl, BASE_URL } from '../lib/target.mjs';

const OPEN_TIMEOUT_MS = 15000;
const REPLY_WAIT_MS = 4000;

/**
 * Attempt an upgrade. Resolves { socket } when it opens, or { rejected, status }
 * when the server refuses — a refusal is the expected result for most cases
 * here, so it is a normal return value rather than an error.
 */
function connect(path, { cookie, bearer } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.Cookie = `session=${cookie}`;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let socket;
    try {
      socket = new WebSocket(resolveWsUrl(path), { headers, handshakeTimeout: OPEN_TIMEOUT_MS });
    } catch (err) {
      return done({ rejected: true, status: 0, error: err.message });
    }

    const received = [];
    socket.on('message', (data) => received.push(data.toString()));
    socket.on('open', () => done({ socket, received }));
    socket.on('unexpected-response', (_req, res) => {
      socket.terminate();
      done({ rejected: true, status: res.statusCode });
    });
    socket.on('error', (err) => done({ rejected: true, status: 0, error: err.message }));
    setTimeout(() => done({ rejected: true, status: 0, error: 'handshake timed out' }), OPEN_TIMEOUT_MS + 1000);
  });
}

/** Send a frame and collect whatever comes back within the reply window. */
function send(conn, payload) {
  const before = conn.received.length;
  conn.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return new Promise((resolve) => {
    setTimeout(() => resolve(conn.received.slice(before).map(parse)), REPLY_WAIT_MS);
  });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function close(conn) {
  try {
    conn?.socket?.close();
  } catch {
    /* already gone */
  }
}

/** Synthesise a response-shaped object so findings carry a usable repro. */
function wsContext(path, note) {
  return {
    status: null,
    text: note,
    request: { url: `${BASE_URL}${path}`.replace(/^http/, 'ws'), method: 'WS', body: null, authenticated: true },
  };
}

export async function run(ctx, report, rng) {
  const { channelId } = ctx.ids;
  if (!channelId) {
    report.skip('GET /ws/:channelId', 'no private channel fixture — the entire WebSocket probe was skipped');
    return;
  }

  // Precondition, checked rather than assumed: every oracle below means
  // "a NON-MEMBER got in", so it is only valid while the attacker is genuinely
  // not a member. An earlier probe that adds them (running as the admin, whose
  // POST /channels/:id/members legitimately succeeds) would turn all of this
  // into fabricated HIGH findings. Fail loudly as a suite error instead.
  const members = await request(`/channels/${channelId}/members`, { token: ctx.victim.token });
  if (members.status === 200 && members.text.includes(ctx.attacker.id)) {
    report.skip(
      'ws probe',
      `SUITE ERROR: the attacker is already a member of the victim's private channel, so no authorization ` +
      `oracle here can be trusted. Something in this run granted that membership — the WebSocket probe was ` +
      `skipped rather than report access it caused itself.`,
    );
    return;
  }

  // --- Oracle A: unauthorized upgrades ---------------------------------------
  const anon = await connect(`/ws/${channelId}`);
  if (anon.socket) {
    report.add({
      severity: 'high',
      probe: 'ws',
      title: 'WebSocket upgrade succeeds with no credentials',
      detail: `GET /ws/${channelId} completed the upgrade for a client sending no session cookie and no bearer token.`,
      route: 'GET /ws/:channelId',
      response: wsContext(`/ws/${channelId}`, 'upgrade completed anonymously'),
    });
    close(anon);
  }

  const nonMember = await connect(`/ws/${channelId}`, { cookie: ctx.attacker.token });
  if (nonMember.socket) {
    report.add({
      severity: 'high',
      probe: 'ws',
      title: 'Non-member completes a WebSocket upgrade to a private channel',
      detail:
        `GET /ws/${channelId} upgraded for a logged-in user who is not a member of that private channel. ` +
        `Every message broadcast to the channel is now delivered to them.`,
      route: 'GET /ws/:channelId',
      response: wsContext(`/ws/${channelId}`, 'upgrade completed for a non-member'),
    });
    close(nonMember);
  }

  // --- Oracle C: identity smuggling through the upgrade URL -------------------
  // The Worker rewrites these params with URLSearchParams.set() before handing
  // the request to the DO, which replaces any client-supplied copy. Asserting it
  // empirically is the point: if someone later adds a param the DO reads but the
  // Worker forgets to overwrite, this fires.
  const injected = new URLSearchParams({
    userId: ctx.ids.victimId,
    username: ctx.victim.user.username,
    role: 'admin',
    credentialKind: 'session',
    credentialId: 'forged-credential-id',
    credentialScopes: '',
    credentialExpiresAt: String(Number.MAX_SAFE_INTEGER),
  });
  const smuggled = await connect(`/ws/${channelId}?${injected}`, { cookie: ctx.attacker.token });
  if (smuggled.socket) {
    report.add({
      severity: 'high',
      probe: 'ws',
      title: 'Identity parameters smuggled through the WebSocket upgrade URL',
      detail:
        `A non-member upgraded to /ws/${channelId} by supplying userId/credentialId query params — the ` +
        `same params the API Worker uses to convey the authenticated principal to the ChatRoom Durable ` +
        `Object. The DO trusts these values as identity.`,
      route: 'GET /ws/:channelId',
      response: wsContext(`/ws/${channelId}?${injected}`, 'upgrade completed with injected identity params'),
    });
    close(smuggled);
  }

  // --- The attacker needs a socket of their own to act from ------------------
  // Non-admins may create public channels, so the attacker gets a legitimate
  // room. Everything after this tests whether that legitimate socket can reach
  // beyond its own channel.
  const ownChannel = await request('/channels', {
    method: 'POST',
    token: ctx.attacker.token,
    body: { name: `${ctx.run}-attacker-own`, description: 'security suite attacker channel' },
  });

  if (ownChannel.status < 200 || ownChannel.status >= 300) {
    report.skip('WS action fuzzing', `attacker could not create a channel to connect from (${ownChannel.status}) — cross-channel and malformed-frame checks were skipped`);
    return;
  }
  const attackerChannelId = ownChannel.json.id;
  ctx.cleanup.push({ label: 'attacker channel', path: `/channels/${attackerChannelId}`, method: 'DELETE' });

  const conn = await connect(`/ws/${attackerChannelId}`, { cookie: ctx.attacker.token });
  if (!conn.socket) {
    report.skip('WS action fuzzing', `attacker could not open a socket on their own channel (status ${conn.status}) — action fuzzing was skipped`);
    return;
  }

  try {
    // --- Oracle B: act on a channel this socket has no claim to --------------
    // handleMessageCreate takes channelId from the PAYLOAD, so the socket's own
    // channel is not a boundary — only createMessage's membership check is.
    const crossChannel = [
      { type: 'message.create', channelId, content: `${ctx.run} cross-channel injection`, actionId: 'x1' },
      { type: 'reaction.add', channelId, messageId: ctx.ids.messageId, emoji: '💀', actionId: 'x2' },
      { type: 'process.create', channelId, kind: 'injected', status: 'running', title: `${ctx.run} injected`, actionId: 'x3' },
      { type: 'message.process_status', messageId: ctx.ids.messageId, status: 'failed', actionId: 'x4' },
    ];

    for (const frame of crossChannel) {
      const replies = await send(conn, frame);
      const succeeded = replies.some((r) => r?.type && !/error/i.test(r.type) && r.actionId === frame.actionId);
      if (succeeded) {
        report.add({
          severity: 'high',
          probe: 'ws',
          title: `WebSocket action "${frame.type}" reached a channel the socket has no access to`,
          detail:
            `A socket opened on the attacker's own channel sent "${frame.type}" naming the victim's private ` +
            `channel in the payload, and the action succeeded. Actions take the target channel from the ` +
            `PAYLOAD, not from the socket's channel binding, so each action handler's own membership check is ` +
            `the only boundary — and this one does not have it. Note that message.create is correctly ` +
            `rejected here (createMessage calls ensureChannelMembership), which isolates the gap to this action.`,
          route: `WS ${frame.type}`,
          response: wsContext(`/ws/${attackerChannelId}`, JSON.stringify(replies).slice(0, 400)),
        });
      }
    }

    // Independent confirmation: read the victim's channel as the victim and look
    // for anything the attacker planted. A silent write is worse than a loud one,
    // so we never rely on the socket's own reply alone.
    const victimMessages = await request(`/channels/${channelId}/messages?limit=50`, { token: ctx.victim.token });
    if (victimMessages.status === 200 && victimMessages.text.includes('cross-channel injection')) {
      report.add({
        severity: 'high',
        probe: 'ws',
        title: 'Non-member wrote into a private channel over WebSocket',
        detail:
          `A message sent from the attacker's socket landed in the victim's private channel ${channelId}. ` +
          `Confirmed by reading the channel back as the victim — this is a real write, not just a permissive reply.`,
        route: 'WS message.create',
        response: victimMessages,
      });
    }

    // --- Oracle D: malformed frames -----------------------------------------
    const malformed = [
      { label: 'not JSON', frame: 'definitely not json' },
      { label: 'empty string', frame: '' },
      { label: 'JSON array', frame: '[1,2,3]' },
      { label: 'JSON null', frame: 'null' },
      { label: 'no type field', frame: JSON.stringify({ content: 'x' }) },
      { label: 'numeric type', frame: JSON.stringify({ type: 42 }) },
      { label: 'object type', frame: JSON.stringify({ type: { nested: true } }) },
      { label: 'unknown action', frame: JSON.stringify({ type: 'admin.escalate', actionId: 'm1' }) },
      { label: 'message.create with no channelId', frame: JSON.stringify({ type: 'message.create', content: 'x', actionId: 'm2' }) },
      { label: 'message.create with array channelId', frame: JSON.stringify({ type: 'message.create', channelId: ['a'], content: 'x', actionId: 'm3' }) },
      { label: 'message.create with object content', frame: JSON.stringify({ type: 'message.create', channelId: attackerChannelId, content: { a: 1 }, actionId: 'm4' }) },
      { label: 'typing_start with numeric threadId', frame: JSON.stringify({ type: 'typing_start', threadId: 99 }) },
      { label: '256KB frame', frame: JSON.stringify({ type: 'message.create', channelId: attackerChannelId, content: 'A'.repeat(256 * 1024), actionId: 'm5' }) },
      { label: 'deeply nested frame', frame: '{"type":"message.create","channelId":"' + attackerChannelId + '","metadata":' + '['.repeat(500) + ']'.repeat(500) + ',"actionId":"m6"}' },
      { label: 'prototype pollution keys', frame: JSON.stringify({ type: 'message.create', channelId: attackerChannelId, content: 'x', __proto__: { polluted: true }, actionId: 'm7' }) },
    ];

    for (const { label, frame } of rng.shuffle(malformed)) {
      if (conn.socket.readyState !== WebSocket.OPEN) {
        report.add({
          severity: 'medium',
          probe: 'ws',
          title: 'Malformed frame terminated the WebSocket connection',
          detail:
            `The socket was no longer open when sending "${label}". A frame that kills the connection is a ` +
            `cheap denial-of-service against any client sharing that Durable Object.`,
          route: 'WS frame handling',
          response: wsContext(`/ws/${attackerChannelId}`, `connection closed before "${label}"`),
        });
        break;
      }

      const replies = await send(conn, frame);
      const serverError = replies.find((r) => r?.status >= 500 || r?.error?.status >= 500);
      if (serverError) {
        report.add({
          severity: 'medium',
          probe: 'ws',
          title: 'Malformed WebSocket frame produces a server error',
          detail:
            `Frame "${label}" produced a 5xx action error. dispatchChatRoomAction catches unknown throws and ` +
            `reports 500; a malformed frame should be rejected as 400 instead, since bots retry on 5xx and ` +
            `will hammer the Durable Object.`,
          route: 'WS frame handling',
          response: wsContext(`/ws/${attackerChannelId}`, JSON.stringify(replies).slice(0, 400)),
          dedupeKey: 'ws|5xx-frame',
        });
      }
    }

    // --- Oracle E: acting after the credential is revoked --------------------
    await revokedCredentialCheck(ctx, report);
  } finally {
    close(conn);
  }
}

/**
 * assertCredentialActive() re-checks the credential on every non-ping action,
 * precisely so a long-lived socket cannot outlive its token. This confirms that
 * holds end to end: open a socket on a bearer token, revoke the token over REST,
 * then act.
 */
async function revokedCredentialCheck(ctx, report) {
  // Uses the BOT's token, not the attacker's: POST /users/me/api-tokens is
  // gated by requireAdminPrincipal, so a non-admin cannot mint one for itself.
  // The bot is a channel member, so its socket opens legitimately — which is
  // the realistic shape of this risk anyway (long-lived agent connections).
  const { channelId } = ctx.ids;
  const tokenValue = ctx.bot?.token;
  const tokenId = ctx.bot?.tokenId;
  if (!tokenValue || !tokenId) {
    report.skip('WS credential revocation', 'no bot API token fixture — the revocation check was skipped');
    return;
  }

  const conn = await connect(`/ws/${channelId}`, { bearer: tokenValue });
  if (!conn.socket) {
    report.skip('WS credential revocation', `bot bearer-token socket did not open (status ${conn.status})`);
    return;
  }

  try {
    const revoked = await request(`/users/${ctx.bot.id}/api-tokens/${tokenId}`, { method: 'DELETE', token: ctx.victim.token });
    if (revoked.status >= 300) {
      report.skip('WS credential revocation', `token revocation failed (status ${revoked.status})`);
      return;
    }

    const replies = await send(conn, {
      type: 'message.create',
      channelId,
      content: `${ctx.run} post-revocation write`,
      actionId: 'rev1',
    });
    const rejected = replies.some((r) => r?.status === 401 || /revoked|expired|unauthorized/i.test(JSON.stringify(r)));

    if (!rejected) {
      const landed = await request(`/channels/${channelId}/messages?limit=20`, { token: ctx.victim.token });
      if (landed.status === 200 && landed.text.includes('post-revocation write')) {
        report.add({
          severity: 'high',
          probe: 'ws',
          title: 'Revoked credential still writes over an open WebSocket',
          detail:
            `A bot API token was revoked over REST, but a socket opened with it still created a message. ` +
            `assertCredentialActive() is supposed to re-check the credential on every non-ping action ` +
            `(api/src/chat-room-actions.ts) precisely to prevent this. Revocation does not close the window ` +
            `on already-open sockets — a leaked token stays usable for as long as its holder keeps the ` +
            `connection alive, which is exactly how long-lived agent connections behave.`,
          route: 'WS message.create',
          response: landed,
        });
      }
    }
  } finally {
    close(conn);
  }
}
