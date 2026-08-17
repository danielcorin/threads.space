// RFC 8291 Web Push encryption + RFC 8292 VAPID, implemented with Web Crypto API.
// No npm dependencies — runs in Cloudflare Workers.

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

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function encodeUint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (value >>> 24) & 0xff;
  buf[1] = (value >>> 16) & 0xff;
  buf[2] = (value >>> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function _encodeUint16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (value >>> 8) & 0xff;
  buf[1] = value & 0xff;
  return buf;
}

const encoder = new TextEncoder();

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', key, ikm);
  return new Uint8Array(prk);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Single iteration (length <= 32 for our uses)
  const input = concat(info, new Uint8Array([1]));
  const output = await crypto.subtle.sign('HMAC', key, input);
  return new Uint8Array(output).slice(0, length);
}

async function createVapidJwt(
  audience: string,
  subject: string,
  privateKeyBytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: subject,
  };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import VAPID private key as ECDSA P-256
  // The private key is the raw 32-byte scalar; we need to construct a JWK
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
    y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
    d: base64UrlEncode(privateKeyBytes),
  };

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsignedToken));

  return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Derive the VAPID public key (uncompressed 65-byte point) from the raw 32-byte private key.
 */
async function _deriveVapidPublicKey(_privateKeyBytes: Uint8Array): Promise<Uint8Array> {
  // Generate a throwaway key to get the algorithm params, then import our private key
  // We need to use JWK with a dummy public key — but actually, we can derive it:
  // Import as JWK with the private scalar, then export to get the public coordinates.
  // However, Web Crypto needs x,y to import. So we derive from the VAPID public key param instead.
  // Actually, the caller already has the public key. Let's just pass it through.
  throw new Error('Not used — pass public key directly');
}

export async function sendPushNotification(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapidKeys: { publicKey: string; privateKey: string },
  vapidSubject: string,
): Promise<Response> {
  const payloadBytes = encoder.encode(payload);

  // Decode subscription keys
  const subscriberPublicKey = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);

  // Decode VAPID keys
  const vapidPublicKeyBytes = base64UrlDecode(vapidKeys.publicKey);
  const vapidPrivateKeyBytes = base64UrlDecode(vapidKeys.privateKey);

  // 1. Generate ephemeral ECDH key pair
  const ephemeralKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;

  // Export ephemeral public key as uncompressed point (65 bytes)
  const ephemeralPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey) as ArrayBuffer,
  );

  // 2. Import subscriber's p256dh as ECDH public key
  const subscriberKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. ECDH key agreement
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: subscriberKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0],
      ephemeralKeyPair.privateKey,
      256,
    ),
  );

  // 4. Key derivation (RFC 8291 Section 3.4)
  // IKM = HKDF-Extract(auth_secret, ecdh_secret)
  // Then derive CEK and nonce using HKDF with specific info strings

  // PRK for key info: HKDF(salt=auth_secret, ikm=shared_secret)
  // info = "WebPush: info\0" + subscriber_public_key + sender_public_key
  const keyInfoHeader = encoder.encode('WebPush: info\0');
  const keyInfo = concat(keyInfoHeader, subscriberPublicKey, ephemeralPublicKeyRaw);

  const ikm_prk = await hkdfExtract(authSecret, sharedSecret);
  const ikm = await hkdfExpand(ikm_prk, keyInfo, 32);

  // Generate 16-byte random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK for content encryption
  const contentPrk = await hkdfExtract(salt, ikm);

  // Content Encryption Key (16 bytes)
  const cekInfo = encoder.encode('Content-Encoding: aes128gcm\0');
  const contentEncryptionKey = await hkdfExpand(contentPrk, cekInfo, 16);

  // Nonce (12 bytes)
  const nonceInfo = encoder.encode('Content-Encoding: nonce\0');
  const nonce = await hkdfExpand(contentPrk, nonceInfo, 12);

  // 5. Pad and encrypt payload (RFC 8188)
  // Add padding delimiter (0x02) then zero-pad
  const paddedPayload = concat(payloadBytes, new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey(
    'raw',
    contentEncryptionKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      paddedPayload,
    ),
  );

  // 6. Build aes128gcm encrypted content coding (RFC 8188 Section 2)
  // Header: salt(16) + rs(4, big-endian uint32) + idlen(1) + keyid(idlen bytes)
  // keyid = ephemeral public key (65 bytes)
  const rs = encodeUint32BE(4096);
  const idlen = new Uint8Array([65]);
  const header = concat(salt, rs, idlen, ephemeralPublicKeyRaw);
  const body = concat(header, ciphertext);

  // 7. VAPID authorization
  const endpoint = new URL(subscription.endpoint);
  const audience = `${endpoint.protocol}//${endpoint.host}`;
  const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKeyBytes, vapidPublicKeyBytes);
  const vapidKeyEncoded = base64UrlEncode(vapidPublicKeyBytes);

  // 8. Send to push service
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.byteLength),
      Authorization: `vapid t=${jwt}, k=${vapidKeyEncoded}`,
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
}
