// Digital pager server. No dependencies: node:http + node:crypto only.
//
//   /r/<branch>        customer page (what the static QR code opens)
//   /staff/<branch>    staff dashboard (PIN protected)
//   /qr/<branch>       printable QR code for the counter or tables

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore, normalizeOrderNumber, customerView, staffView } from './src/store.js';
import { createWebPush, loadOrCreateVapidKeys, isValidSubscription } from './src/webpush.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const env = process.env;
const settings = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  configFile: path.resolve(env.BRANCHES_FILE || path.join(ROOT, 'config', 'branches.json')),
  timeZone: env.TIME_ZONE || 'Asia/Amman',
  vapidSubject: env.VAPID_SUBJECT || 'mailto:owner@example.com',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  allowAnyPushEndpoint: env.PUSH_ALLOW_ANY_ENDPOINT === '1', // tests only
};

// ---------- Branches ----------

function loadBranches(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const branches = new Map();
  for (const [slug, b] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error(`Branch id "${slug}" must be lowercase letters, digits and dashes`);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new Error(`Branch "${slug}" needs a name`);
    if (typeof b.staffPin !== 'string' || b.staffPin.length < 4) throw new Error(`Branch "${slug}" needs a staffPin of at least 4 characters`);
    const prep = Number(b.defaultPrepMinutes ?? 12);
    if (!(prep >= 1 && prep <= 180)) throw new Error(`Branch "${slug}" defaultPrepMinutes must be 1–180`);
    branches.set(slug, {
      slug,
      name: b.name.trim(),
      staffPin: b.staffPin,
      defaultPrepMinutes: prep,
      pickupNote: typeof b.pickupNote === 'string' && b.pickupNote.trim() ? b.pickupNote.trim() : 'Pick it up at the counter.',
    });
  }
  if (!branches.size) throw new Error(`No branches defined in ${file}`);
  return branches;
}

const branches = loadBranches(settings.configFile);
const store = createStore({ file: path.join(settings.dataDir, 'orders.json'), timeZone: settings.timeZone });
const vapidKeys = loadOrCreateVapidKeys(path.join(settings.dataDir, 'vapid.json'));
const push = createWebPush({ ...vapidKeys, subject: settings.vapidSubject, allowAnyEndpoint: settings.allowAnyPushEndpoint });
if (settings.vapidSubject === 'mailto:owner@example.com') {
  console.warn('Set VAPID_SUBJECT to a real contact, e.g. mailto:you@yourdomain.com (push services use it to reach you).');
}

// ---------- Push ----------

async function notifyReady(branch, order) {
  const subs = [...order.subscriptions];
  if (!subs.length) {
    store.recordPush(order, { sent: 0, failed: 0 });
    return { sent: 0, failed: 0 };
  }
  const payload = {
    title: `Order ${order.number} is ready`,
    body: `${branch.pickupNote} ${branch.name}`,
    url: `/r/${branch.slug}?order=${encodeURIComponent(order.number)}`,
    tag: `order-${order.id}`,
  };
  const results = await Promise.all(subs.map((s) => push.send(s, payload)));
  let sent = 0;
  let failed = 0;
  results.forEach((r, i) => {
    if (r.ok) sent++;
    else failed++;
    if (r.gone) store.removeSubscription(order, subs[i].endpoint);
  });
  store.recordPush(order, { sent, failed });
  return { sent, failed };
}

// ---------- HTTP helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (settings.trustProxy) {
    const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Fixed-window rate limiter per IP and bucket.
const hits = new Map();
function rateLimited(req, bucket, max, windowMs = 60_000) {
  const key = `${bucket}|${clientIp(req)}`;
  const t = Date.now();
  const entry = hits.get(key);
  if (!entry || t - entry.start > windowMs) {
    hits.set(key, { start: t, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (t - v.start > 120_000) hits.delete(k);
}, 60_000).unref();

function pinMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function renderTemplate(file, branch) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  return html
    .replaceAll('{{BRANCH_NAME}}', escapeHtml(branch.name))
    .replaceAll('{{BRANCH_SLUG}}', escapeHtml(branch.slug))
    .replaceAll('{{PUBLIC_URL}}', escapeHtml(settings.publicUrl));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  res.end(html);
}

function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(decoded));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return false;
  if (path.extname(filePath) === '.html') return false; // pages go through their routes
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size };
  // The service worker must never be cached long, or phones keep running an old one.
  headers['Cache-Control'] = ext === '.png' ? 'public, max-age=86400' : 'no-cache';
  if (urlPath === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ---------- Routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

function withBranch(handler) {
  return (req, res, params, url) => {
    const branch = branches.get(params[0]);
    if (!branch) return sendError(res, 404, 'Unknown restaurant');
    return handler(req, res, { branch, params, url });
  };
}

function withStaff(handler) {
  return withBranch((req, res, ctx) => {
    if (!pinMatches(req.headers['x-staff-pin'], ctx.branch.staffPin)) {
      if (rateLimited(req, 'pin-fail', 10)) return sendError(res, 429, 'Too many wrong PINs. Wait a minute and try again.');
      return sendError(res, 401, 'Wrong staff PIN');
    }
    return handler(req, res, ctx);
  });
}

function orderNumberFrom(raw, res) {
  const number = normalizeOrderNumber(raw);
  if (!number) sendError(res, 400, 'Order numbers are up to 12 letters, digits or dashes');
  return number;
}

// Pages
route('GET', /^\/$/, (req, res) => {
  const items = [...branches.values()]
    .map(
      (b) =>
        `<li><strong>${escapeHtml(b.name)}</strong> — <a href="/r/${b.slug}">customer page</a> · <a href="/staff/${b.slug}">staff dashboard</a> · <a href="/qr/${b.slug}">printable QR</a></li>`,
    )
    .join('');
  sendHtml(
    res,
    200,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Digital pager</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}a{color:#1d4ed8}</style>` +
      `<h1>Digital pager</h1><ul>${items}</ul>`,
  );
});
route('GET', /^\/r\/([a-z0-9-]+)\/?$/, withBranch((req, res, { branch }) => sendHtml(res, 200, renderTemplate('customer.html', branch))));
route('GET', /^\/staff\/([a-z0-9-]+)\/?$/, withBranch((req, res, { branch }) => sendHtml(res, 200, renderTemplate('staff.html', branch))));
route('GET', /^\/qr\/([a-z0-9-]+)\/?$/, withBranch((req, res, { branch }) => sendHtml(res, 200, renderTemplate('qr.html', branch))));
route('GET', /^\/manifest\/([a-z0-9-]+)\.webmanifest$/, withBranch((req, res, { branch }) => {
  const manifest = {
    name: `${branch.name} – order tracker`,
    short_name: branch.name.slice(0, 12),
    start_url: `/r/${branch.slug}`,
    scope: '/',
    display: 'standalone',
    background_color: '#F2F4F8',
    theme_color: '#14213D',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  res.writeHead(200, { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(manifest));
}));
route('GET', /^\/healthz$/, (req, res) => sendJson(res, 200, { ok: true, orders: store.size() }));

// Customer API
route('GET', /^\/api\/push-key$/, (req, res) => sendJson(res, 200, { publicKey: push.publicKey }));

route('GET', /^\/api\/branches\/([a-z0-9-]+)$/, withBranch((req, res, { branch }) =>
  sendJson(res, 200, {
    slug: branch.slug,
    name: branch.name,
    defaultPrepMinutes: branch.defaultPrepMinutes,
    pickupNote: branch.pickupNote,
  }),
));

route('POST', /^\/api\/branches\/([a-z0-9-]+)\/track$/, withBranch(async (req, res, { branch }) => {
  if (rateLimited(req, 'track', 60)) return sendError(res, 429, 'Too many lookups. Wait a minute and try again.');
  const body = await readJson(req);
  const number = orderNumberFrom(body.number, res);
  if (!number) return;
  // Look up only: an order exists once staff add it (or mark it ready) on the dashboard.
  const order = store.find(branch.slug, number);
  if (!order) return sendError(res, 404, `We can't find order ${number}. Check the number on your receipt, or ask at the counter.`);
  sendJson(res, 200, customerView(order));
}));

route('GET', /^\/api\/branches\/([a-z0-9-]+)\/orders\/([^/]+)$/, withBranch((req, res, { branch, params }) => {
  const number = orderNumberFrom(params[1], res);
  if (!number) return;
  const order = store.find(branch.slug, number);
  if (!order) return sendError(res, 404, 'Order not found');
  sendJson(res, 200, customerView(order));
}));

route('POST', /^\/api\/branches\/([a-z0-9-]+)\/orders\/([^/]+)\/subscribe$/, withBranch(async (req, res, { branch, params }) => {
  if (rateLimited(req, 'subscribe', 30)) return sendError(res, 429, 'Too many requests. Wait a minute and try again.');
  const number = orderNumberFrom(params[1], res);
  if (!number) return;
  const body = await readJson(req);
  if (!isValidSubscription(body.subscription, { allowAny: settings.allowAnyPushEndpoint })) {
    return sendError(res, 400, 'Invalid push subscription');
  }
  const order = store.find(branch.slug, number);
  if (!order) return sendError(res, 404, 'Order not found');
  if (order.status === 'collected') return sendError(res, 409, 'This order was already picked up');
  const phones = store.addSubscription(order, body.subscription);
  sendJson(res, 200, { ok: true, phones });
}));

route('POST', /^\/api\/branches\/([a-z0-9-]+)\/orders\/([^/]+)\/unsubscribe$/, withBranch(async (req, res, { branch, params }) => {
  const number = orderNumberFrom(params[1], res);
  if (!number) return;
  const body = await readJson(req);
  const order = store.find(branch.slug, number);
  if (order && typeof body.endpoint === 'string') store.removeSubscription(order, body.endpoint);
  sendJson(res, 200, { ok: true });
}));

// Staff API (header X-Staff-Pin)
route('GET', /^\/api\/staff\/([a-z0-9-]+)\/orders$/, withStaff((req, res, { branch }) => {
  const t = Date.now();
  sendJson(res, 200, {
    branch: { name: branch.name, defaultPrepMinutes: branch.defaultPrepMinutes },
    serverNow: t,
    orders: store.listForStaff(branch.slug).map((o) => staffView(o, t)),
  });
}));

route('POST', /^\/api\/staff\/([a-z0-9-]+)\/orders$/, withStaff(async (req, res, { branch }) => {
  const body = await readJson(req);
  const number = orderNumberFrom(body.number, res);
  if (!number) return;
  const eta = Number(body.etaMinutes ?? branch.defaultPrepMinutes);
  if (!(eta >= 0 && eta <= 180)) return sendError(res, 400, 'ETA must be between 0 and 180 minutes');
  const order = store.upsertFromStaff(branch.slug, number, { etaMinutes: eta });
  sendJson(res, 200, staffView(order));
}));

route('POST', /^\/api\/staff\/([a-z0-9-]+)\/orders\/([^/]+)\/status$/, withStaff(async (req, res, { branch, params }) => {
  const number = orderNumberFrom(params[1], res);
  if (!number) return;
  const body = await readJson(req);
  if (!['preparing', 'ready', 'collected'].includes(body.status)) return sendError(res, 400, 'status must be preparing, ready or collected');
  const before = store.find(branch.slug, number);
  const wasReady = before?.status === 'ready';
  const order = store.setStatus(branch.slug, number, body.status, { defaultPrepMinutes: branch.defaultPrepMinutes });
  if (!order) return sendError(res, 404, `Order ${number} isn't on the list`);
  let pushResult = null;
  if (body.status === 'ready' && !wasReady) pushResult = await notifyReady(branch, order);
  sendJson(res, 200, { order: staffView(order), push: pushResult });
}));

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const r of routes) {
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      return await r.handler(req, res, m.slice(1), url);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname)) return;
    if (url.pathname.startsWith('/api/')) return sendError(res, 404, 'Not found');
    sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>This page doesn’t exist. Scan the QR code again.</p>');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendError(res, status, status === 500 ? 'Something went wrong on the server' : err.message);
    else res.end();
  }
});

setInterval(() => store.purge(), 10 * 60_000).unref();

function shutdown() {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(settings.port, settings.host, () => {
  const local = `http://localhost:${settings.port}`;
  console.log(`Digital pager running on ${local}`);
  for (const b of branches.values()) {
    console.log(`  ${b.name}: customer ${local}/r/${b.slug}  staff ${local}/staff/${b.slug}  QR ${local}/qr/${b.slug}`);
  }
});
