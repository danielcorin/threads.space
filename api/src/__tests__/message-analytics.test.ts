import { describe, expect, it } from 'vitest';
import {
  byteSizeBucket,
  contentLengthBucket,
  hmacSha256Base64Url,
  hmacSha256Hex,
  recordMessageSent,
} from '../lib/message-analytics.js';
import type { Env } from '../types.js';

describe('message analytics', () => {
  it('emits only hashed ids, enums, and numeric buckets', async () => {
    let datapoint: AnalyticsEngineDataPoint | undefined;
    const env = {
      ANALYTICS_HASH_SECRET: 'test-hmac-secret',
      MESSAGE_ANALYTICS: {
        writeDataPoint(event?: AnalyticsEngineDataPoint) {
          datapoint = event;
        },
      },
    } as unknown as Env;

    await recordMessageSent(env, {
      userId: 'usr_sensitive_123',
      actorRole: 'human',
      messageType: 'human',
      channel: { is_dm: 0, is_private: 1, is_ephemeral: 0 },
      threadId: 'msg_sensitive_parent',
      contentLength: 'do not export this message'.length,
      attachmentCount: 2,
      attachmentBytes: 125_000,
    });

    const instanceHash = await hmacSha256Hex('test-hmac-secret', 'instance:threads');
    const instanceIndexHash = await hmacSha256Base64Url('test-hmac-secret', 'instance:threads');
    const userIndexHash = await hmacSha256Base64Url('test-hmac-secret', 'user:usr_sensitive_123');

    expect(datapoint).toEqual({
      indexes: [`${instanceIndexHash}:${userIndexHash}`],
      blobs: [
        'v1',
        instanceHash,
        'human',
        'human',
        'private',
        'thread_reply',
        'has_attachments',
      ],
      doubles: [1, 100, 2, 1024 * 1024, 0, 0, 0, 0],
    });

    const raw = JSON.stringify(datapoint);
    expect(raw).not.toContain('usr_sensitive_123');
    expect(raw).not.toContain('msg_sensitive_parent');
    expect(raw).not.toContain('do not export this message');
  });

  it('skips emission unless the binding and an instance secret are configured', async () => {
    let calls = 0;
    const env = {
      MESSAGE_ANALYTICS: {
        writeDataPoint() {
          calls += 1;
        },
      },
    } as unknown as Env;

    await recordMessageSent(env, {
      userId: 'u1',
      actorRole: 'bot',
      messageType: 'response',
      channel: { is_dm: 1 },
      contentLength: 0,
      attachmentCount: 0,
      attachmentBytes: 0,
    });

    expect(calls).toBe(0);
  });

  it('builds instance-scoped user indexes from separate hashes', async () => {
    const secret = 'test-hmac-secret';
    const instanceHash = await hmacSha256Base64Url(secret, 'instance:threads');
    const userHash = await hmacSha256Base64Url(secret, 'user:user-1');
    const index = `${instanceHash}:${userHash}`;
    expect(index).toMatch(/^[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/);
    expect(index.length).toBeLessThanOrEqual(96);
  });

  it('buckets lengths and byte sizes instead of preserving exact values', () => {
    expect(contentLengthBucket(21)).toBe(100);
    expect(contentLengthBucket(501)).toBe(2000);
    expect(byteSizeBucket(1025)).toBe(10 * 1024);
    expect(byteSizeBucket(125_000)).toBe(1024 * 1024);
  });
});
