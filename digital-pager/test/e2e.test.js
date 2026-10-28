// End-to-end: runs the real server against a fake push service and checks the whole flow:
// track order -> subscribe -> live updates -> staff marks ready -> encrypted, signed push arrives.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '4321';
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

let server;
let base;
let pushService;
let pushBase;
const received = []; // requests the fake push service got
let tmp;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: path.join(tmp, 'data'),
      BRANCHES_FILE: path.join(tmp, 'branches.json'),
      VAPID_SUBJECT: 'mailto:test@example.com',
      PUSH_ALLOW_ANY_ENDPOINT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
  server = null;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-test-'));
  fs.writeFileSync(
    path.join(tmp, 'branches.json'),
    JSON.stringify({
      'test-cafe': { name: 'Test Café', staffPin: PIN, defaultPrepMinutes: 12, pickupNote: 'Collect at window 2.' },
      'other-cafe': { name: 'Other Café', staffPin: '9999', defaultPrepMinutes: 8 },
    }),
  );

  pushService = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.includes('gone') ? 410 : 201);
      res.end();
    });
  });
  const pushPort = await freePort();
  await new Promise((r) => pushService.listen(pushPort, '127.0.0.1', r));
  pushBase = `http://127.0.0.1:${pushPort}`;

  await startServer();
});

after(async () => {
  await stopServer();
  pushService?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (url, body, headers = {}) =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json);
const get = (url, headers = {}) => fetch(`${base}${url}`, { headers }).then(json);
const staff = { 'X-Staff-Pin': PIN };

function fakeBrowser(pathName) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { endpoint: `${pushBase}${pathName}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
  };
}

// What the browser does on receipt (RFC 8291 decryption), written independently of src/webpush.js.
function decryptPush(body, browser) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const serverPublic = body.subarray(21, 21 + idLen);
  const payload = body.subarray(21 + idLen);
  const hk = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const shared = browser.ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), serverPublic]);
  const ikm = hk(shared, browser.auth, keyInfo, 32);
  const cek = hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}

function verifyVapid(headers, expectedAudience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization);
  assert.ok(m, 'VAPID Authorization header');
  const [h, c, s] = m[1].split('.');
  const pub = fromB64u(m[2]);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64u(s)), 'JWT signature');
  const claims = JSON.parse(fromB64u(c));
  assert.equal(claims.aud, expectedAudience);
  assert.equal(claims.sub, 'mailto:test@example.com');
  return m[2];
}

test('pages render with the branch name', async () => {
  for (const p of ['/r/test-cafe', '/staff/test-cafe', '/qr/test-cafe']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), /Test Café/);
  }
  assert.equal((await fetch(`${base}/r/nope`)).status, 404);
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const manifest = await get('/manifest/test-cafe.webmanifest');
  assert.equal(manifest.body.start_url, '/r/test-cafe');
});

test('static files cannot escape the public folder', async () => {
  for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/js/..%2f..%2fserver.js', '/customer.html']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test('customers cannot create orders: unknown numbers are "not found"', async () => {
  for (const number of ['46', '999', 'A12']) {
    const res = await post('/api/branches/test-cafe/track', { number });
    assert.equal(res.status, 404, number);
    assert.match(res.body.error, new RegExp(`can't find order ${number}`));
  }
  // ...and looking them up didn't create them
  assert.equal((await get('/api/branches/test-cafe/orders/46')).status, 404);
  const list = await get('/api/staff/test-cafe/orders', staff);
  assert.ok(!list.body.orders.some((o) => ['46', '999', 'A12'].includes(o.number)), 'nothing appears on the staff list');
  // A customer can't subscribe to an order that doesn't exist either
  assert.equal((await post('/api/branches/test-cafe/orders/46/subscribe', { subscription: fakeBrowser('/push/x').subscription })).status, 404);
});

test('full flow: staff adds order, customer tracks and subscribes, staff marks ready, push arrives', async () => {
  const t0 = Date.now();
  const added = await post('/api/staff/test-cafe/orders', { number: '47', etaMinutes: 12 }, staff);
  assert.equal(added.status, 200);

  const tracked = await post('/api/branches/test-cafe/track', { number: ' #047 ' });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.number, '47');
  assert.equal(tracked.body.status, 'preparing');
  const etaMinutes = (tracked.body.etaAt - tracked.body.createdAt) / 60_000;
  assert.equal(etaMinutes, 12);
  assert.ok(tracked.body.createdAt >= t0 - 1000);

  // Same order typed differently is the same order
  assert.equal((await post('/api/branches/test-cafe/track', { number: '47' })).body.createdAt, tracked.body.createdAt);
  // Arabic-Indic digits work too
  assert.equal((await post('/api/branches/test-cafe/track', { number: '٤٧' })).body.number, '47');

  // Bad subscriptions are rejected
  assert.equal((await post('/api/branches/test-cafe/orders/47/subscribe', { subscription: { endpoint: 'x' } })).status, 400);

  const phone = fakeBrowser('/push/phone-1');
  const sub = await post('/api/branches/test-cafe/orders/47/subscribe', { subscription: phone.subscription });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.phones, 1);

  // What the page checks every few seconds
  assert.equal((await get('/api/branches/test-cafe/orders/47')).body.status, 'preparing');

  // Staff needs the PIN
  assert.equal((await get('/api/staff/test-cafe/orders')).status, 401);
  assert.equal((await get('/api/staff/test-cafe/orders', { 'X-Staff-Pin': '0000' })).status, 401);
  const list = await get('/api/staff/test-cafe/orders', staff);
  assert.equal(list.status, 200);
  assert.equal(list.body.orders.find((o) => o.number === '47').phones, 1);

  // Mark ready
  const before = received.length;
  const ready = await post('/api/staff/test-cafe/orders/47/status', { status: 'ready' }, staff);
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body.push, { sent: 1, failed: 0 });
  assert.equal(received.length, before + 1);

  const req = received.at(-1);
  assert.equal(req.path, '/push/phone-1');
  assert.equal(req.headers['content-encoding'], 'aes128gcm');
  assert.equal(req.headers.urgency, 'high');
  assert.equal(req.headers.ttl, '3600');
  const k = verifyVapid(req.headers, pushBase);
  assert.equal(k, (await get('/api/push-key')).body.publicKey);

  const message = decryptPush(req.body, phone);
  assert.equal(message.title, 'Order 47 is ready');
  assert.equal(message.body, 'Collect at window 2. Test Café');
  assert.equal(message.url, '/r/test-cafe?order=47');

  if (process.env.CAPTURE_DIR) {
    fs.writeFileSync(
      path.join(process.env.CAPTURE_DIR, 'push-capture.json'),
      JSON.stringify({ body: b64u(req.body), uaPrivate: b64u(phone.ecdh.getPrivateKey()), auth: b64u(phone.auth), authorization: req.headers.authorization }),
    );
  }

  // An open page sees it on its next check
  const polled = await get('/api/branches/test-cafe/orders/47');
  assert.equal(polled.body.status, 'ready');
  assert.ok(polled.body.readyAt >= t0);

  // Marking ready twice doesn't notify twice
  await post('/api/staff/test-cafe/orders/47/status', { status: 'ready' }, staff);
  assert.equal(received.length, before + 1);
});

test('unsubscribed phones are removed; undo and re-ready notifies again', async () => {
  await post('/api/staff/test-cafe/orders', { number: '48', etaMinutes: 10 }, staff);
  const good = fakeBrowser('/push/phone-2');
  const gone = fakeBrowser('/push/gone-phone');
  await post('/api/branches/test-cafe/orders/48/subscribe', { subscription: good.subscription });
  await post('/api/branches/test-cafe/orders/48/subscribe', { subscription: gone.subscription });

  const first = await post('/api/staff/test-cafe/orders/48/status', { status: 'ready' }, staff);
  assert.deepEqual(first.body.push, { sent: 1, failed: 1 });
  assert.equal(first.body.order.phones, 1, 'the 410 subscription is dropped');

  const undo = await post('/api/staff/test-cafe/orders/48/status', { status: 'preparing' }, staff);
  assert.equal(undo.body.order.status, 'preparing');
  assert.ok(undo.body.order.etaAt > Date.now(), 'undo gives a fresh ETA');

  const again = await post('/api/staff/test-cafe/orders/48/status', { status: 'ready' }, staff);
  assert.deepEqual(again.body.push, { sent: 1, failed: 0 });

  const picked = await post('/api/staff/test-cafe/orders/48/status', { status: 'collected' }, staff);
  assert.equal(picked.body.order.status, 'collected');
  assert.equal(picked.body.order.phones, 0, 'subscriptions are deleted after pickup');
  assert.equal((await post('/api/branches/test-cafe/orders/48/subscribe', { subscription: good.subscription })).status, 409);
});

test('staff can add orders with an ETA, or mark ready before the customer looks', async () => {
  const added = await post('/api/staff/test-cafe/orders', { number: '50', etaMinutes: 5 }, staff);
  assert.equal(added.status, 200);
  assert.equal((added.body.etaAt - added.body.createdAt) / 60_000, 5);
  const seen = await post('/api/branches/test-cafe/track', { number: '50' });
  assert.equal(seen.body.etaAt, added.body.etaAt, 'customer sees the staff ETA');

  const early = await post('/api/staff/test-cafe/orders/51/status', { status: 'ready' }, staff);
  assert.equal(early.status, 200);
  assert.equal((await post('/api/branches/test-cafe/track', { number: '51' })).body.status, 'ready');

  assert.equal((await post('/api/staff/test-cafe/orders', { number: '52', etaMinutes: 999 }, staff)).status, 400);
  assert.equal((await post('/api/staff/test-cafe/orders', { number: 'bad number!' }, staff)).status, 400);
});

test('each restaurant has its own orders and its own PIN', async () => {
  await post('/api/staff/test-cafe/orders', { number: '7', etaMinutes: 8 }, staff);
  assert.equal((await post('/api/branches/test-cafe/track', { number: '7' })).status, 200);
  assert.equal((await post('/api/branches/other-cafe/track', { number: '7' })).status, 404, "another restaurant's order 7 is separate");
  assert.equal((await post('/api/staff/other-cafe/orders', { number: '7' }, staff)).status, 401, "test-cafe's PIN doesn't open other-cafe");
  assert.equal((await post('/api/staff/other-cafe/orders', { number: '7' }, { 'X-Staff-Pin': '9999' })).status, 200);
});

test('status checks never hold a connection open, and a busy café on one Wi-Fi is not rate limited', async () => {
  // The old live-updates stream is gone: nothing is left open for a tunnel to cancel.
  assert.equal((await fetch(`${base}/api/branches/test-cafe/orders/47/events`)).status, 404);

  // 40 phones behind the same café Wi-Fi (same IP), each checking 5 times.
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 200 }, () => fetch(`${base}/api/branches/test-cafe/orders/47`).then((r) => r.status)));
  assert.ok(results.every((s) => s === 200), 'every status check succeeds');
  assert.ok(Date.now() - started < 5000, 'and they finish quickly');
});

test('orders and keys survive a restart', async () => {
  const key = (await get('/api/push-key')).body.publicKey;
  await stopServer();
  await startServer();
  assert.equal((await get('/api/push-key')).body.publicKey, key);
  const order = await get('/api/branches/test-cafe/orders/50');
  assert.equal(order.status, 200);
  assert.equal(order.body.status, 'preparing');
});
