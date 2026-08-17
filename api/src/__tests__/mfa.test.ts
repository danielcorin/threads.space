import { describe, expect, it } from 'vitest';
import {
  decryptMfaSecret,
  encodeBase32,
  encryptMfaSecret,
  generateTotpCode,
  matchTotpStep,
  mfaProvisioningIssuer,
  totpProvisioningUri,
} from '../lib/mfa.js';
import type { Env } from '../types.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const MFA_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

describe('TOTP', () => {
  it('encodes the RFC 6238 shared secret as Base32', () => {
    expect(encodeBase32(new TextEncoder().encode('12345678901234567890'))).toBe(RFC_SECRET);
  });

  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ])('matches the six-digit form of the RFC vector at %i', async (time, expected) => {
    expect(await generateTotpCode(RFC_SECRET, Math.floor(time / 30))).toBe(expected);
  });

  it('accepts one adjacent time step and rejects a replayed step', async () => {
    const now = 1_700_000_000;
    const step = Math.floor(now / 30) - 1;
    const code = await generateTotpCode(RFC_SECRET, step);
    expect(await matchTotpStep(RFC_SECRET, code, { now })).toBe(step);
    expect(await matchTotpStep(RFC_SECRET, code, { now, lastUsedStep: step })).toBeNull();
  });

  it('constructs a standards-compatible provisioning URI', () => {
    const uri = new URL(totpProvisioningUri(RFC_SECRET, 'Example Workspace', 'dan@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Example Workspace:dan@example.com');
    expect(uri.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(uri.searchParams.get('issuer')).toBe('Example Workspace');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('uses the full instance hostname as the authenticator issuer', () => {
    expect(mfaProvisioningIssuer({
      APP_ORIGIN: 'https://test-instance.example',
    } as Env)).toBe('test-instance.example');
  });
});

describe('MFA secret encryption', () => {
  const env = { MFA_ENCRYPTION_KEY: MFA_KEY } as Env;

  it('round-trips with AES-GCM bound to the user id', async () => {
    const encrypted = await encryptMfaSecret(env, 'user-a', RFC_SECRET);
    expect(encrypted.ciphertext).not.toContain(RFC_SECRET);
    expect(await decryptMfaSecret(env, 'user-a', encrypted)).toBe(RFC_SECRET);
    await expect(decryptMfaSecret(env, 'user-b', encrypted)).rejects.toThrow();
  });

  it('rejects the wrong instance key', async () => {
    const encrypted = await encryptMfaSecret(env, 'user-a', RFC_SECRET);
    const wrongEnv = {
      MFA_ENCRYPTION_KEY: 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk',
    } as Env;
    await expect(decryptMfaSecret(wrongEnv, 'user-a', encrypted)).rejects.toThrow();
  });
});
