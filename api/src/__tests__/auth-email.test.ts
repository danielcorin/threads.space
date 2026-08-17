import { afterEach, describe, expect, it, vi } from 'vitest';
import { appOrigin, AuthEmailDeliveryError, sendEmailVerification } from '../lib/auth-email.js';
import type { Env } from '../types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account verification email', () => {
  it('sends an instance-labeled confirmation through Resend', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      RESEND_API_KEY: 'test-key',
      AUTH_EMAIL_FROM: 'accounts@example.com',
      APP_ORIGIN: 'https://acme.example',
    } as Env;

    await sendEmailVerification(env, 'owner@example.com', 'https://acme.example/auth/email/confirm?token=abc');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'Threads <accounts@example.com>',
      to: ['owner@example.com'],
      subject: 'Confirm your email for acme.example',
    });
    expect(JSON.parse(init.body as string).text).toContain('https://acme.example/auth/email/confirm?token=abc');
  });

  it('fails closed when email delivery is not configured', async () => {
    await expect(sendEmailVerification({} as Env, 'owner@example.com', 'https://example.com/confirm'))
      .rejects.toEqual(expect.objectContaining<AuthEmailDeliveryError>({
        name: 'AuthEmailDeliveryError',
        message: 'Email delivery is not configured',
      }));
  });

  it('uses the configured application origin and safely falls back to the request origin', () => {
    expect(appOrigin({ APP_ORIGIN: 'https://instance.example, https://other.example' } as Env, 'https://worker.example/path'))
      .toBe('https://instance.example');
    expect(appOrigin({ APP_ORIGIN: 'not a url' } as Env, 'https://worker.example/path'))
      .toBe('https://worker.example');
  });
});
