// Lumina API Worker v3
// Proxies Anthropic API requests + Web Push notifications

const ALLOWED_ORIGIN = 'https://gmennonna.github.io';

const ALLOWED_ORIGINS = new Set([
  'https://gmennonna.github.io',
]);

function corsHeaders(origin) {
  const o = ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── VAPID helpers ──
function base64UrlToUint8Array(b64) {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from([...bin].map(c => c.charCodeAt(0)));
}

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function buildVapidJwt(audience, privateKeyB64, publicKeyB64, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims  = base64UrlEncode(JSON.stringify({ aud: audience, exp: now + 3600, sub: subject }));

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
  const sigInput = new TextEncoder().encode(`${header}.${claims}`);
  const sigBytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, sigInput);
  return `${header}.${claims}.${base64UrlEncode(new Uint8Array(sigBytes))}`;
}

// RFC 8291 compliant Web Push encryption (aes128gcm)
async function encryptPayload(payload, keys) {
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

  // IKM = HKDF(salt=auth, IKM=ecdhSecret, info="WebPush: info\x00" || ua_public || as_public, 32 bytes)
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

  // Random 16-byte salt for content encryption header
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt=salt, IKM=ikm, info="Content-Encoding: aes128gcm\x00", 16 bytes)
  // NONCE = HKDF(salt=salt, IKM=ikm, info="Content-Encoding: nonce\x00", 12 bytes)
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\x00') },
      ikmKey, 128
    )
  );
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

async function sendWebPush(subscription, payloadObj, vapidPublicKey, vapidPrivateKey, subject) {
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/') {
      return new Response('Lumina API Worker v3 OK', { headers: corsHeaders(origin) });
    }

    // ── POST /api/anthropic ──
    if (url.pathname === '/api/anthropic' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // ── POST /api/push ──
    // Body: { subscription: {...}, title: string, body: string, url?: string }
    if (url.pathname === '/api/push' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }); }

      const { subscription, title, body: msgBody, url: msgUrl } = body;
      if (!subscription?.endpoint || !subscription?.keys) {
        return new Response(JSON.stringify({ error: 'Missing subscription' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
      }

      try {
        await sendWebPush(
          subscription,
          { title, body: msgBody, url: msgUrl || '/lumina/' },
          env.VAPID_PUBLIC_KEY,
          env.VAPID_PRIVATE_KEY,
          'mailto:g.mennonna@gmail.com'
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
};
