// Shared helpers for seeding users into local D1. Mirrors API logic that cannot
// be imported directly from this Node script.

const PBKDF2_ITERATIONS = 100_000; // must match api/src/auth.ts

const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
const encoder = new TextEncoder();

export async function credentialId(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

export async function credentialVerifier(instanceSecret, kind, token) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(instanceSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key, encoder.encode(`threads:credential:${kind}:v1\0${token}`),
  );
  return toHex(new Uint8Array(signature));
}

// Mirror api/src/auth.ts hashPassword: PBKDF2-SHA256, 16-byte salt, "saltHex:hashHex".
export async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(plain), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

// Mirror api/src/utils.ts generateId: timestamp-prefixed base36.
export function generateId() {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16);
  return `${timestamp}${random}`;
}

// SQL single-quote escaping for `wrangler d1 execute --command` statements.
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Upsert an admin user by username (refresh identity, credentials + admin flag).
// CLI-created addresses are unverified unless the caller explicitly attests
// that ownership was already confirmed.
export async function adminUpsertSql(username, password, display, email, emailVerified = false) {
  const originalEmail = String(email).trim();
  if (originalEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(originalEmail)) {
    throw new Error('A valid admin email is required');
  }
  const normalizedEmail = originalEmail.toLowerCase();
  const verifiedAt = emailVerified ? 'unixepoch()' : 'NULL';
  return `INSERT INTO users (id, username, password_hash, email, email_normalized, email_verified_at, display_name, role, is_admin)
VALUES (${q(generateId())}, ${q(username)}, ${q(await hashPassword(password))}, ${q(originalEmail)}, ${q(normalizedEmail)}, ${verifiedAt}, ${q(display)}, 'human', 1)
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, email = excluded.email, email_normalized = excluded.email_normalized, email_verified_at = excluded.email_verified_at, display_name = excluded.display_name, is_admin = 1`;
}
