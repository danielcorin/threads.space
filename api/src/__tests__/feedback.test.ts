import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailFeedback, type FeedbackImageAttachment } from '../lib/feedback.js';
import type { Env } from '../types.js';

function image(overrides: Partial<FeedbackImageAttachment> = {}): FeedbackImageAttachment {
  return {
    filename: 'screenshot.png',
    contentType: 'image/png',
    sizeBytes: 8,
    r2Key: 'user/attachment/screenshot.png',
    ...overrides,
  };
}

function feedbackEnv(get: (key: string) => Promise<unknown>): Env {
  return {
    RESEND_API_KEY: 'test-key',
    FEEDBACK_EMAIL_FROM: 'feedback@example.com',
    FEEDBACK_EMAIL_TO: 'operator@example.com',
    APP_ORIGIN: 'https://test-instance.example',
    UPLOADS: { get },
  } as unknown as Env;
}

function r2Object(content: string): unknown {
  const bytes = new TextEncoder().encode(content);
  return {
    arrayBuffer: async () => bytes.buffer,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('emailFeedback', () => {

  it('does not send without an instance-owned destination', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = feedbackEnv(async () => r2Object('unused'));
    delete env.FEEDBACK_EMAIL_TO;

    await emailFeedback(env, 'Someone', 'Hello');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches an image from R2 to the Resend payload', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => (
      new Response(JSON.stringify({ id: 'email-id' }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const get = vi.fn(async () => r2Object('png-data'));

    await emailFeedback(feedbackEnv(get), 'Daniel', 'The layout is broken', [image()]);

    expect(get).toHaveBeenCalledWith('user/attachment/screenshot.png');
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1]!;
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      to: ['operator@example.com'],
      subject: '[test-instance.example] New feedback from Daniel',
      text: 'The layout is broken',
      attachments: [{
        filename: 'screenshot.png',
        content: btoa('png-data'),
      }],
    });
  });

  it('sends image-only feedback with a useful text fallback', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await emailFeedback(feedbackEnv(async () => r2Object('image')), 'Daniel', '', [image({ sizeBytes: 5 })]);

    const init = fetchMock.mock.calls[0][1]!;
    const payload = JSON.parse(init.body as string);
    expect(payload.text).toBe('Image feedback attached.');
    expect(payload.attachments).toHaveLength(1);
  });

  it('still sends the feedback email when an image is missing from R2', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 200 }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    await emailFeedback(feedbackEnv(async () => null), 'Daniel', 'See the missing image', [image()]);

    const init = fetchMock.mock.calls[0][1]!;
    const payload = JSON.parse(init.body as string);
    expect(payload.attachments).toBeUndefined();
    expect(payload.text).toContain('1 image attachment was omitted from this email.');
    expect(consoleError).toHaveBeenCalledWith(
      'Feedback image missing from R2:',
      'user/attachment/screenshot.png',
    );
  });
});
