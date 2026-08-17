import { describe, it, expect } from 'vitest';

// We test the base64url helpers and the overall function signature/structure.
// Full end-to-end push encryption requires a real push service, so we validate
// the module loads and the encoding helpers work correctly.

// Re-implement the helpers here to test them (they're not exported from web-push.ts)
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe('web-push helpers', () => {
  it('base64url round-trips correctly', () => {
    const original = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 64, 32]);
    const encoded = base64UrlEncode(original);

    // Should not contain +, /, or =
    expect(encoded).not.toMatch(/[+/=]/);

    const decoded = base64UrlDecode(encoded);
    expect(decoded).toEqual(original);
  });

  it('base64url handles empty input', () => {
    const encoded = base64UrlEncode(new Uint8Array(0));
    expect(encoded).toBe('');
    const decoded = base64UrlDecode('');
    expect(decoded).toEqual(new Uint8Array(0));
  });

  it('base64url decodes known VAPID public key', () => {
    const vapidPublicKey = 'BA6n6rqLHmUaIgnp5JMo3erC-sfHdA9A5y_4_JsXjBxyG1f-UZM6E112vR49kvbAdzluqL5MgJzQTuA3qj7Pm1g';
    const bytes = base64UrlDecode(vapidPublicKey);
    // Uncompressed P-256 public key is 65 bytes (0x04 prefix + 32 byte x + 32 byte y)
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it('base64url decodes known VAPID private key', () => {
    const vapidPrivateKey = 'HBTUbA2kqY9DZzKtDaNHS_X7AVTv7iUQM8KaI0kk7s0';
    const bytes = base64UrlDecode(vapidPrivateKey);
    // P-256 private key is 32 bytes
    expect(bytes.length).toBe(32);
  });
});

describe('web-push module', () => {
  it('exports sendPushNotification function', async () => {
    const mod = await import('../lib/web-push.js');
    expect(typeof mod.sendPushNotification).toBe('function');
  });
});
