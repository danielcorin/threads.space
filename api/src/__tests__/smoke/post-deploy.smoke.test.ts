// Post-deploy smoke suite. Drives the REAL authenticated API of a deployed
// instance end-to-end — channel → message → reaction → thread reply → attachment
// → teardown — to prove a fresh deploy actually works, not just that /health
// is up. Runs against SMOKE_BASE_URL (see smoke-helpers.ts); NEVER against a
// production instance (assertNonProduction guard).
//
// This file is intentionally NOT picked up by `vitest run` (the default config
// only globs src/__tests__/*.test.ts, single-level). Run it with the dedicated
// config: `npm run test:smoke` with SMOKE_BASE_URL and login credentials.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNonProduction, authed, authedJson, login, waitForCommit, BASE_URL } from './smoke-helpers.js';

// On a deployed instance the combined worker serves the SvelteKit client at the
// root and mounts the REST API under /api/* (client/worker/combined.ts). Real
// clients call /api/channels etc., so the smoke suite does too — exercising the
// combined-worker routing, not just the bare API. (login and /health are
// root-level prefixes, handled in smoke-helpers.ts without /api.)
const api = (path: string) => `/api${path}`;

// A label unique to this run so concurrent/leftover data never collides and any
// stray rows are obviously smoke debris. Channel `name` is UNIQUE in the schema.
const RUN = `smoke-${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`;

let token: string;
// Resources to tear down. Deleting the channel cascades its messages,
// reactions, threads, and attachments, so tracking the channel is enough — but
// we collect everything for a best-effort cleanup even on partial failure.
const createdChannelIds: string[] = [];

let channelId: string;
let messageId: string;
let replyId: string;

beforeAll(async () => {
  // Prod guard first (refuses to mutate a production instance).
  let health = await assertNonProduction();
  // When the deploy passes the SHA it just rolled out, wait for /health to report
  // it before mutating — otherwise smoke can hit a PoP still serving the old
  // version mid-rollout (which previously hung login and timed out the hook).
  const expected = process.env.SMOKE_EXPECTED_COMMIT;
  if (expected) health = await waitForCommit(expected);
  console.log(`[smoke] target ${BASE_URL} — env=${health.environment} commit=${health.commit} migration=${health.latestMigration}`);
  token = await login();
});

afterAll(async () => {
  // Best-effort teardown; never throw out of cleanup. Delete channels (cascade
  // handles the rest) so a passing OR failing run leaves no smoke debris behind.
  for (const id of createdChannelIds) {
    try {
      await authed(token, api(`/channels/${id}`), { method: 'DELETE' });
    } catch {
      // ignore — surfaced below by the verification step if it matters
    }
  }
});

describe(`post-deploy smoke (${RUN})`, () => {
  it('creates a public channel', async () => {
    const channel = await authedJson<{ id: string; name: string }>(token, api('/channels'), {
      method: 'POST',
      body: JSON.stringify({ name: `${RUN}-chan`, description: 'post-deploy smoke test', isPrivate: false }),
    });
    expect(channel.id).toBeTruthy();
    channelId = channel.id;
    createdChannelIds.push(channelId);
  });

  it('sends a message', async () => {
    const msg = await authedJson<{ id: string; content: string }>(token, api(`/channels/${channelId}/messages`), {
      method: 'POST',
      body: JSON.stringify({ content: 'hello from smoke', idempotencyKey: `${RUN}-m1` }),
    });
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBe('hello from smoke');
    messageId = msg.id;
  });

  it('is idempotent on message resend (same key returns the same message)', async () => {
    const res = await authed(token, api(`/channels/${channelId}/messages`), {
      method: 'POST',
      body: JSON.stringify({ content: 'hello from smoke', idempotencyKey: `${RUN}-m1` }),
    });
    expect(res.ok).toBe(true);
    const again = (await res.json()) as { id: string };
    expect(again.id).toBe(messageId);
  });

  it('adds and removes a reaction', async () => {
    const add = await authed(token, api(`/messages/${messageId}/reactions`), {
      method: 'POST',
      body: JSON.stringify({ emoji: 'thumbsup' }),
    });
    expect(add.ok).toBe(true);

    const remove = await authed(token, api(`/messages/${messageId}/reactions/thumbsup`), { method: 'DELETE' });
    expect(remove.ok).toBe(true);
  });

  it('replies in a thread', async () => {
    const reply = await authedJson<{ id: string; threadId: string }>(token, api(`/messages/${messageId}/replies`), {
      method: 'POST',
      body: JSON.stringify({ content: 'threaded reply from smoke' }),
    });
    expect(reply.id).toBeTruthy();
    // Reply chains to the parent message.
    expect(reply.threadId).toBe(messageId);
    replyId = reply.id;
  });

  it('sets and reads a prose thread title through the reply id', async () => {
    const title = `Smoke thread: ${RUN}`;
    const updated = await authedJson<{
      applied: boolean;
      thread_id: string;
      thread_title: string;
      thread_title_updated_at: number;
    }>(token, api(`/messages/${replyId}/thread-title`), {
      method: 'PUT',
      body: JSON.stringify({ title }),
    });
    expect(updated.applied).toBe(true);
    expect(updated.thread_id).toBe(messageId);
    expect(updated.thread_title).toBe(title);
    expect(updated.thread_title_updated_at).toBeGreaterThan(0);

    const root = await authedJson<{
      thread_title: string;
      threadTitle: string;
      thread_title_updated_at: number;
    }>(token, api(`/messages/${messageId}`));
    expect(root.thread_title).toBe(title);
    expect(root.threadTitle).toBe(title);
    expect(root.thread_title_updated_at).toBe(updated.thread_title_updated_at);
  });

  it('uploads an attachment and sends a message that references it', async () => {
    const form = new FormData();
    form.append('file', new Blob(['smoke attachment contents'], { type: 'text/plain' }), `${RUN}.txt`);
    // FormData body — authed() omits the JSON Content-Type so the runtime sets
    // the multipart boundary.
    const upRes = await authed(token, api('/uploads'), { method: 'POST', body: form });
    expect(upRes.ok).toBe(true);
    const upload = (await upRes.json()) as { id: string; filename: string };
    expect(upload.id).toBeTruthy();

    const msg = await authedJson<{ id: string; attachments: Array<{ id: string; filename: string }> }>(
      token,
      api(`/channels/${channelId}/messages`),
      {
        method: 'POST',
        body: JSON.stringify({ content: 'message with attachment', attachmentIds: [upload.id] }),
      },
    );
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].id).toBe(upload.id);
  });

  it('deletes a message (thread reply)', async () => {
    const res = await authed(token, api(`/messages/${replyId}`), { method: 'DELETE' });
    expect(res.ok).toBe(true);
  });

  it('tears down the channel and confirms it is gone', async () => {
    const del = await authed(token, api(`/channels/${channelId}`), { method: 'DELETE' });
    expect(del.ok).toBe(true);
    // Drop from the cleanup list — already deleted.
    createdChannelIds.length = 0;

    const list = await authedJson<Array<{ id: string }>>(token, api('/channels'));
    expect(list.some((ch) => ch.id === channelId)).toBe(false);
  });
});
