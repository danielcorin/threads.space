import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAppEvent } from '../lib/observability.js';
import type { Env } from '../types.js';

describe('application observability events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a structured Cloudflare Workers Logs event', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = {
      ENVIRONMENT: 'production',
    } as Env;

    logAppEvent(env, 'threads.message.sent', {
      outcome: 'created',
      actor_id: 'usr_123',
      channel_id: 'chan_456',
      attachment_count: 0,
      optional_field: undefined,
    });

    expect(consoleLog).toHaveBeenCalledOnce();
    expect(consoleLog).toHaveBeenCalledWith({
      outcome: 'created',
      actor_id: 'usr_123',
      channel_id: 'chan_456',
      attachment_count: 0,
      event: 'threads.message.sent',
      event_schema: 'threads.app_event.v1',
      service: 'threads-api',
      environment: 'production',
    });
  });

  it('protects schema fields from being overwritten by callers', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = {
      ENVIRONMENT: '',
    } as Env;

    logAppEvent(env, 'threads.auth.logout', {
      event: 'malicious.override',
      service: 'other-service',
      outcome: 'no_session',
    });

    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'threads.auth.logout',
      service: 'threads-api',
      environment: 'development',
      outcome: 'no_session',
    }));
  });
});
