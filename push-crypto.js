/**
 * Lumina Web Push crypto utilities — RFC 8291 (aes128gcm) + VAPID (RFC 8292)
 *
 * Single source of truth used by:
 *   - worker.js          (Cloudflare Worker, imported as local ES module)
 *   - supabase-super-api.ts  (Deno Edge Function, imported via raw GitHub URL)
 *
 * All functions rely only on the Web Crypto API (crypto.subtle), available
 * in both Cloudflare Workers and Deno runtimes without any polyfill.
 */

export function base64UrlToUint8Array(b64) {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from([...bin].map(c => c.charCodeAt(0)));
}

export function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** Builds a VAPID JWT (ES256) for the given push endpoint origin. */
export async function buildVapidJwt(audience, privateKeyB64, publicKeyB64, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64UrlEncode(JSON.stringify({ aud: audience, exp: now + 3600, sub: subject }));

  const pubBytes = base64UrlToUint8Array(publicKeyB64); // 65 bytes uncompressed
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: privateKeyB64,
    x: base64UrlEncode(pubBytes.slice(1, 33)),
    y: base64UrlEncode(pubBytes.slice(33, 65)),
  };
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(`${header}.${claims}`)
  );
  return `${header}.${claims}.${base64UrlEncode(new Uint8Array(sigBytes))}`;
}

/**
 * RFC 8291 compliant Web Push payload encryption (aes128gcm).
 * @param {string} payload  - JSON string to encrypt
 * @param {{ p256dh: string, auth: string }} keys - subscriber keys (base64url)
 * @returns {Promise<Uint8Array>} encrypted body ready for the push endpoint
 */
export async function encryptPayload(payload, keys) {
  const p256dh = base64UrlToUint8Array(keys.p256dh); // subscriber public key (65 bytes)
  const auth   = base64UrlToUint8Array(keys.auth);   // auth secret (16 bytes)

  // Generate ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const asPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey)
  ); // 65 bytes uncompressed

  // Import subscriber's public key for ECDH
  const uaPublicKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH shared secret
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, ephemeral.privateKey, 256)
  );

  // IKM = HKDF(salt=auth, IKM=ecdhSecret, info="WebPush: info\x00" || ua_public || as_public)
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\x00'),
    p256dh,
    asPublicRaw
  );
  const ecdhKey = await crypto.subtle.importKey('raw', ecdhSecret, 'HKDF', false, ['deriveBits']);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: auth, info: keyInfo },
      ecdhKey, 256
    )
  );

  // Random 16-byte salt for the content encryption header
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\x00", 16 bytes)
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\x00') },
      ikmKey, 128
    )
  );

  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce\x00", 12 bytes)
  const ikmKey2 = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\x00') },
      ikmKey2, 96
    )
  );

  // Encrypt plaintext || 0x02 (padding delimiter per RFC 8291)
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      concat(new TextEncoder().encode(payload), new Uint8Array([2]))
    )
  );

  // aes128gcm header: salt(16) + rs(4 BE uint32) + idlen(1) + as_public(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, ciphertext.length, false);

  return concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/**
 * Sends a Web Push notification to a single subscription.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {{ title: string, body: string, url: string }} payloadObj
 */
export async function sendWebPush(subscription, payloadObj, vapidPublicKey, vapidPrivateKey, subject) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await buildVapidJwt(audience, vapidPrivateKey, vapidPublicKey, subject);
  const encrypted = await encryptPayload(JSON.stringify(payloadObj), subscription.keys);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidPublicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Urgency': 'high',
    },
    body: encrypted,
  });

  if (!res.ok && res.status !== 201) {
    throw new Error(`Push endpoint ${res.status}: ${await res.text()}`);
  }
}
