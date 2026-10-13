import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAddMember } from '../routes/channels.js';
import { sendPushNotifications } from '../routes/push-send.js';
import type { Env, User } from '../types.js';

const pushFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let subscriberKeys: CryptoKeyPair;
let subscriberPublicKey: Uint8Array;
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

beforeAll(async () => {
  subscriberKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  subscriberPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', subscriberKeys.publicKey));
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  pushEnv.VAPID_PUBLIC_KEY = encode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
  pushEnv.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
});

afterEach(() => vi.unstubAllGlobals());

/** Decode the real RFC 8291 payload as the subscribed browser would. */
async function decryptPush(body: Uint8Array) {
  const senderPublicKey = body.slice(21, 21 + body[20]);
  const senderKey = await crypto.subtle.importKey('raw', senderPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, subscriberKeys.privateKey, 256);
  const encoder = new TextEncoder();
  async function hkdf(input: ArrayBuffer | Uint8Array, salt: Uint8Array, info: Uint8Array, size: number) {
    const key = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, size * 8);
  }
  const info = new Uint8Array([...encoder.encode('WebPush: info\0'), ...subscriberPublicKey, ...senderPublicKey]);
  const ikm = await hkdf(sharedSecret, authSecret, info, 32);
  const salt = body.slice(0, 16);
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + body[20])));
  expect(plaintext[plaintext.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1)));
}

const db = (env as unknown as Env).DB;
const actor = { id: 'member-push-actor', username: 'inviter', display_name: 'The Inviter', role: 'human' } as User;
const target = 'member-push-target';
const channelId = 'member-push-channel';
const broadcastMessage = vi.fn().mockResolvedValue(undefined);
const sendToUsers = vi.fn().mockResolvedValue(undefined);
const pushEnv = {
  ...env,
  CHAT_ROOM: { idFromName: (name: string) => name, get: () => ({ broadcastMessage }) },
  PRESENCE_ROOM: { idFromName: (name: string) => name, get: () => ({ sendToUsers, getActiveUserIds: async () => [] }) },
} as unknown as Env;

beforeEach(async () => {
  vi.clearAllMocks();
  pushFetch.mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal('fetch', pushFetch);
  await db.batch([
    ...[actor.id, target].map((id) => db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, '!', 'human')",
    ).bind(id, id)),
    db.prepare('UPDATE users SET role = ? WHERE id = ?').bind('human', target),
    db.prepare('INSERT OR IGNORE INTO channels (id, name, created_by) VALUES (?, ?, ?)').bind(channelId, 'private-test', actor.id),
    db.prepare('DELETE FROM channel_members WHERE channel_id = ?').bind(channelId),
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').bind(channelId, actor.id),
    db.prepare('DELETE FROM push_preferences WHERE user_id = ?').bind(target),
    db.prepare('DELETE FROM push_subscriptions WHERE user_id IN (?, ?)').bind(target, actor.id),
    ...[target, actor.id].map((id) => db.prepare(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)',
    ).bind(`sub-${id}`, id, `https://push.example/${id}`, encode(subscriberPublicKey), encode(authSecret))),
  ]);
});

async function add(member: Record<string, string> = { userId: target }, options: { environment?: Env; caller?: User } = {}) {
  const ctx = createExecutionContext();
  const response = await handleAddMember(new Request('https://test/channels/members', {
    method: 'POST', body: JSON.stringify(member),
  }), options.environment ?? pushEnv, options.caller ?? actor, channelId, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('channel membership push', () => {
  it('notifies only the added user, includes inviter/channel/deep link, and does not notify on retry', async () => {
    expect((await add({ username: target })).status).toBe(201);
    expect(pushFetch).toHaveBeenCalledOnce();
    const [endpoint, request] = pushFetch.mock.calls[0];
    expect(endpoint).toBe(`https://push.example/${target}`);
    expect(await decryptPush(request!.body as Uint8Array)).toEqual({
      type: 'member_added', title: '#private-test', body: 'The Inviter added you to #private-test',
      tag: `membership:${channelId}`, channelId, url: `/?channel=${channelId}`,
    });
    expect(sendToUsers).toHaveBeenCalledWith([target], expect.objectContaining({ type: 'member_added', channelId }));
    expect((await add()).status).toBe(200);
    expect(pushFetch).toHaveBeenCalledOnce();
    expect(sendToUsers).toHaveBeenCalledOnce();
    expect(broadcastMessage).toHaveBeenCalledOnce();
  });

  it('restores a departed member and sends a new notification once', async () => {
    await db.prepare("INSERT INTO channel_members (channel_id, user_id, left_at, hidden_at) VALUES (?, ?, '2026-10-01', 1)").bind(channelId, target).run();
    expect((await add()).status).toBe(201);
    expect(await db.prepare('SELECT left_at, hidden_at FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(channelId, target).first()).toEqual({ left_at: null, hidden_at: null });
    expect(pushFetch).toHaveBeenCalledOnce();
  });

  it('notifies once when two clients add the same user concurrently', async () => {
    const responses = await Promise.all([add(), add()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(pushFetch).toHaveBeenCalledOnce();
  });

  it('preserves ordinary message push delivery through the shared transport', async () => {
    await add();
    pushFetch.mockClear();
    await sendPushNotifications(pushEnv, {
      channelId, messageId: 'message-id', senderId: actor.id, senderName: actor.display_name!,
      content: 'Hello', threadId: null, mentions: [], messageType: 'human',
    });
    expect(pushFetch).toHaveBeenCalledOnce();
    expect(await decryptPush(pushFetch.mock.calls[0][1]!.body as Uint8Array)).toMatchObject({
      type: 'message', title: '#private-test', body: 'The Inviter: Hello',
      url: `/?channel=${channelId}&msg=message-id`,
    });
  });

  it('delivers this directed notification to mentions-only users', async () => {
    await db.prepare('INSERT INTO push_preferences (user_id, enabled, notify_mentions_only) VALUES (?, 1, 1)').bind(target).run();
    await add();
    expect(pushFetch).toHaveBeenCalledOnce();
  });

  it('respects disabled user push preferences', async () => {
    await db.prepare('INSERT INTO push_preferences (user_id, enabled) VALUES (?, 0)').bind(target).run();
    expect((await add()).status).toBe(201);
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it('preserves and respects a restored member’s muted channel preference', async () => {
    await db.prepare("INSERT INTO channel_members (channel_id, user_id, left_at, notifications) VALUES (?, ?, '2026-10-01', 'none')").bind(channelId, target).run();
    await add();
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it('does not push to bots, self-adds, or users without subscriptions', async () => {
    expect((await add({ userId: actor.id })).status).toBe(200);
    await db.prepare("UPDATE users SET role = 'bot' WHERE id = ?").bind(target).run();
    await add();
    expect(pushFetch).not.toHaveBeenCalled();
    await db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(channelId, target).run();
    await db.prepare("UPDATE users SET role = 'human' WHERE id = ?").bind(target).run();
    await db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(target).run();
    await add();
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it('still adds members without configured VAPID keys', async () => {
    expect((await add(undefined, { environment: { ...pushEnv, VAPID_PUBLIC_KEY: undefined } })).status).toBe(201);
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it('does not notify when an unauthorized caller tries to add someone', async () => {
    expect((await add(undefined, { caller: { ...actor, id: 'outsider' } })).status).toBe(403);
    expect(pushFetch).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(channelId, target).first()).toBeNull();
  });

  it('does not fail membership creation when delivery fails, and prunes expired subscriptions', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      pushFetch.mockResolvedValue(new Response(null, { status: 410 }));
      expect((await add()).status).toBe(201);
      expect(await db.prepare('SELECT id FROM push_subscriptions WHERE user_id = ?').bind(target).first()).toBeNull();
      expect(await db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(channelId, target).first()).not.toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
