import { describe, expect, it } from 'vitest';
import { resolveBotRecipients, validateWebhookUrl } from '../lib/webhooks.js';
import type { Env } from '../types.js';

function envWithBotMembers(userIds: string[]): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: userIds.map((id) => ({ id })) }),
        }),
      }),
    },
  } as unknown as Env;
}

describe('validateWebhookUrl', () => {
  it('allows https URLs on public hostnames and strips fragments', () => {
    expect(validateWebhookUrl('https://hooks.example.com/threads#secret')).toEqual({
      ok: true,
      url: 'https://hooks.example.com/threads',
    });
  });

  it('rejects local, private, credentialed, and non-https URLs', () => {
    expect(validateWebhookUrl('http://hooks.example.com/threads').ok).toBe(false);
    expect(validateWebhookUrl('https://localhost/threads').ok).toBe(false);
    expect(validateWebhookUrl('https://127.0.0.1/threads').ok).toBe(false);
    expect(validateWebhookUrl('https://10.0.0.1/threads').ok).toBe(false);
    expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validateWebhookUrl('https://user:pass@hooks.example.com/threads').ok).toBe(false);
  });

  it('allows http localhost only when the local-dev escape hatch is enabled', () => {
    expect(validateWebhookUrl('http://localhost:9099/threads', { allowInsecure: true })).toEqual({
      ok: true,
      url: 'http://localhost:9099/threads',
    });
    expect(validateWebhookUrl('http://user:pass@localhost:9099/threads', { allowInsecure: true }).ok).toBe(false);
  });
});

describe('resolveBotRecipients', () => {
  it('includes channel bots for human senders except the acting user', async () => {
    await expect(resolveBotRecipients(envWithBotMembers(['bot-a', 'bot-b']), 'ch1', {
      senderId: 'human-1',
      senderRole: 'human',
    })).resolves.toEqual(['bot-a', 'bot-b']);
  });

  it('keeps bot senders scoped to mentioned bots and excludes self echo', async () => {
    await expect(resolveBotRecipients(envWithBotMembers(['bot-a', 'bot-b', 'bot-c']), 'ch1', {
      senderId: 'bot-a',
      senderRole: 'bot',
      mentionedUserIds: ['bot-a', 'bot-c'],
    })).resolves.toEqual(['bot-c']);
  });

  it('returns no bot recipients when the circuit breaker is tripped', async () => {
    await expect(resolveBotRecipients(envWithBotMembers(['bot-a']), 'ch1', {
      senderId: 'human-1',
      senderRole: 'human',
      breakerTripped: true,
    })).resolves.toEqual([]);
  });
});
