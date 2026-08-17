export const MAX_EMAIL_LENGTH = 254;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type ParsedEmail = {
  email: string;
  normalized: string;
};

/**
 * Validate an email address and return both its display/delivery form and the
 * canonical lookup value. Do not add provider-specific transformations here:
 * lowercasing is the only normalization used across account-security flows.
 */
export function parseEmail(value: unknown): ParsedEmail | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return { email, normalized: email.toLowerCase() };
}
