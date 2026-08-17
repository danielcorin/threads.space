import type { Env } from '../types.js';

export class AuthEmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthEmailDeliveryError';
  }
}

function instanceLabel(env: Env): string {
  const configuredOrigin = env.APP_ORIGIN?.split(',')[0]?.trim();
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin).hostname;
    } catch {
      // Fall through to the generic product label.
    }
  }
  return 'Threads';
}

export function appOrigin(env: Env, requestUrl: string): string {
  const configuredOrigin = env.APP_ORIGIN?.split(',')[0]?.trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // Fall back to the request origin when configuration is malformed.
    }
  }
  return new URL(requestUrl).origin;
}

export async function sendEmailVerification(
  env: Env,
  to: string,
  confirmationUrl: string,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new AuthEmailDeliveryError('Email delivery is not configured');
  }

  const from = env.AUTH_EMAIL_FROM || env.FEEDBACK_EMAIL_FROM || 'onboarding@resend.dev';
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Threads <${from}>`,
        to: [to],
        subject: `Confirm your email for ${instanceLabel(env)}`,
        text: `Confirm this email address for your Threads account:\n\n${confirmationUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email.`,
      }),
    });
  } catch {
    throw new AuthEmailDeliveryError('Could not send verification email');
  }

  if (!response.ok) {
    console.error('Auth email delivery failed:', response.status);
    throw new AuthEmailDeliveryError('Could not send verification email');
  }
}
