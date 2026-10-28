// Web Push sending with no dependencies, built on node:crypto.
//  - Payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188)
//  - Server identification: RFC 8292 (VAPID, ES256 JWT)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (str) => Buffer.from(str, 'base64url');

// Push services used by real browsers. The server only sends to these hosts, so a
// client can't make it POST to arbitrary URLs (for example internal addresses).
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'notify.windows.com', // Edge on Windows
  'push.apple.com', // Safari, iPhone home screen web apps
];

export function isAllowedPushEndpoint(endpoint, { allowAny = false } = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (allowAny) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isValidSubscription(sub, opts) {
  if (!sub || typeof sub !== 'object') return false;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  try {
    if (fromB64u(keys.p256dh).length !== 65) return false;
    if (fromB64u(keys.auth).length < 16) return false;
  } catch {
    return false;
  }
  return isAllowedPushEndpoint(endpoint, opts);
}

// ---------- VAPID keys ----------

export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: rawPublicKeyFromJwk(jwk), privateKey: jwk.d };
}

function rawPublicKeyFromJwk(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
}

function privateKeyObject(publicKey, privateKey) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be an uncompressed P-256 point');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
  });
}

// Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if set, otherwise from a file
// that is created on first run. Keep the same keys forever: changing them breaks every
// existing browser subscription.
export function loadOrCreateVapidKeys(file) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.publicKey && saved.privateKey) return saved;
  } catch {
    // fall through and create new keys
  }
  const keys = generateVapidKeys();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`Created new VAPID keys in ${file}`);
  return keys;
}

export function createVapidJwt({ audience, subject, keyObject, now = Date.now(), lifetimeSeconds = 12 * 3600 }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + lifetimeSeconds, sub: subject }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64u(signature)}`;
}

// ---------- Payload encryption (RFC 8291) ----------

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

// uaPublic: the browser's p256dh key (65 bytes). authSecret: the browser's auth secret (16 bytes).
// serverEcdh and salt are only passed in tests (to reproduce the RFC 8291 example);
// normally both are fresh and random for every message.
export function encryptPayload({ plaintext, uaPublic, authSecret, serverEcdh, salt, recordSize = 4096 }) {
  const ecdh = serverEcdh || crypto.createECDH('prime256v1');
  if (!serverEcdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const ikm = hkdf(sharedSecret, authSecret, Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]), 32);
  const contentSalt = salt || crypto.randomBytes(16);
  const cek = hkdf(ikm, contentSalt, CEK_INFO, 16);
  const nonce = hkdf(ikm, contentSalt, NONCE_INFO, 12);

  // A single record: plaintext followed by the 0x02 "last record" delimiter.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  if (padded.length + 16 > recordSize) throw new Error('Push payload too large');

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Header: salt (16) | record size (4, big endian) | key id length (1) | key id (server public key)
  const header = Buffer.alloc(21);
  contentSalt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// ---------- Sending ----------

export function createWebPush({ publicKey, privateKey, subject, allowAnyEndpoint = false, fetchImpl = fetch }) {
  if (!subject || !/^(mailto:|https:)/.test(subject)) {
    throw new Error('VAPID subject must be a mailto: or https: URL');
  }
  const keyObject = privateKeyObject(publicKey, privateKey);
  const jwtCache = new Map(); // push service origin -> { token, expiresAt }

  function authorization(audience) {
    const cached = jwtCache.get(audience);
    if (cached && cached.expiresAt - Date.now() > 3600_000) return cached.token;
    const lifetimeSeconds = 12 * 3600;
    const token = createVapidJwt({ audience, subject, keyObject, lifetimeSeconds });
    jwtCache.set(audience, { token, expiresAt: Date.now() + lifetimeSeconds * 1000 });
    return token;
  }

  // Returns { ok, status, gone }. gone = the browser unsubscribed; delete the subscription.
  async function send(subscription, payload, { ttlSeconds = 3600, urgency = 'high' } = {}) {
    if (!isValidSubscription(subscription, { allowAny: allowAnyEndpoint })) {
      return { ok: false, status: 0, gone: true, error: 'invalid subscription' };
    }
    const endpoint = new URL(subscription.endpoint);
    const body = encryptPayload({
      plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
      uaPublic: fromB64u(subscription.keys.p256dh),
      authSecret: fromB64u(subscription.keys.auth),
    });
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: String(ttlSeconds),
          // "high" asks the push service to wake the phone right away, even in battery-saving idle mode.
          Urgency: urgency,
          Authorization: `vapid t=${authorization(endpoint.origin)}, k=${publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) {
        const text = await res.text().catch(() => '');
        console.warn(`Push to ${endpoint.host} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return { ok, status: res.status, gone: res.status === 404 || res.status === 410 };
    } catch (err) {
      console.warn(`Push to ${endpoint.host} failed: ${err.message}`);
      return { ok: false, status: 0, gone: false, error: err.message };
    }
  }

  return { publicKey, send };
}
