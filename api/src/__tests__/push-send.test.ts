import { describe, expect, it } from 'vitest';
import { buildMessagePushPayload, filterByNotificationTier } from '../routes/push-send.js';

describe('buildMessagePushPayload', () => {
  it('includes a channel deep link for message notifications', () => {
    const payload = JSON.parse(buildMessagePushPayload({
      channelId: 'chan 1',
      messageId: 'msg/2',
      title: '#general',
      body: 'dan: hello',
    }));

    expect(payload).toMatchObject({
      type: 'message',
      title: '#general',
      body: 'dan: hello',
      tag: 'channel:chan 1',
      channelId: 'chan 1',
      messageId: 'msg/2',
      url: '/?channel=chan%201&msg=msg%2F2',
    });
  });
});

describe('filterByNotificationTier', () => {
  const members = [
    { user_id: 'u-all', notifications: 'all' },
    { user_id: 'u-mentions', notifications: 'mentions' },
    { user_id: 'u-mentions-hit', notifications: 'mentions' },
    { user_id: 'u-none', notifications: 'none' },
  ];

  it('keeps "all", drops "none", and gates "mentions" on being mentioned', () => {
    const result = filterByNotificationTier(members, new Set(['u-mentions-hit']));
    expect(result.map((m) => m.user_id)).toEqual(['u-all', 'u-mentions-hit']);
  });

  it('drops "mentions" members entirely when nobody is mentioned', () => {
    const result = filterByNotificationTier(members, new Set());
    expect(result.map((m) => m.user_id)).toEqual(['u-all']);
  });

  it('"none" wins even when mentioned', () => {
    const result = filterByNotificationTier(members, new Set(['u-none']));
    expect(result.map((m) => m.user_id)).toEqual(['u-all']);
  });
});
