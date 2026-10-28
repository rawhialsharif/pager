// Order storage: in memory, saved to a JSON file so a restart doesn't lose today's orders.
// Swap this module for a real database (Postgres, DynamoDB, ...) when you outgrow it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3600_000;
const MAX_PHONES_PER_ORDER = 5;
const SHOW_COLLECTED_FOR = 20 * 60_000; // staff list keeps picked-up orders visible this long
const ORDER_LIFETIME = 20 * HOUR; // forget orders after this, whatever their status
const CROSS_MIDNIGHT_WINDOW = 6 * HOUR; // an 11:55 PM order is still found at 12:05 AM

export const ORDER_NUMBER_PATTERN = /^[A-Z0-9-]{1,12}$/;

// "#047 " -> "47", "a12" -> "A12". Returns null if it isn't a usable order number.
export function normalizeOrderNumber(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  // Map Arabic-Indic and Eastern Arabic-Indic digits to ASCII so "٤٧" works too.
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (/^\d+$/.test(s)) s = String(Number.parseInt(s, 10)); // receipts often zero-pad
  return ORDER_NUMBER_PATTERN.test(s) ? s : null;
}

export function createStore({ file, timeZone = 'Asia/Amman', now = () => Date.now() }) {
  const orders = new Map(); // key -> order
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = (ms) => dayFormat.format(new Date(ms));
  const keyOf = (branch, day, number) => `${branch}|${day}|${number}`;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const o of saved.orders || []) orders.set(keyOf(o.branch, o.day, o.number), o);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${file}: ${err.message}`);
    }
  }

  let saveTimer = null;
  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ orders: [...orders.values()] }));
        fs.renameSync(tmp, file);
      } catch (err) {
        console.warn(`Could not save orders: ${err.message}`);
      }
    }, 250);
    saveTimer.unref?.();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ orders: [...orders.values()] }));
  }

  function find(branch, number) {
    const t = now();
    const today = orders.get(keyOf(branch, dayOf(t), number));
    if (today) return today;
    const yesterday = orders.get(keyOf(branch, dayOf(t - 24 * HOUR), number));
    if (yesterday && yesterday.status !== 'collected' && t - yesterday.createdAt < CROSS_MIDNIGHT_WINDOW) return yesterday;
    return null;
  }

  function create(branch, number, { etaMinutes, status = 'preparing', source }) {
    const t = now();
    const order = {
      id: crypto.randomUUID(),
      branch,
      day: dayOf(t),
      number,
      status,
      source, // 'customer' (created by looking it up) or 'staff'
      createdAt: t,
      etaAt: t + etaMinutes * 60_000,
      readyAt: status === 'ready' ? t : null,
      collectedAt: null,
      updatedAt: t,
      subscriptions: [],
      lastPush: null,
    };
    orders.set(keyOf(branch, order.day, number), order);
    save();
    return order;
  }

  function touch(order) {
    order.updatedAt = now();
    save();
    return order;
  }

  return {
    // Only staff create orders. Customers can look up an existing order, never add one.
    find,

    // Staff added an order (or changed its ETA).
    // Returns { order, reused } on success, or { conflict } if the number is still active.
    addFromStaff(branch, number, { etaMinutes }) {
      const existing = find(branch, number);
      if (existing && existing.status !== 'collected') return { conflict: existing };
      // A picked-up number can be used again: it becomes a brand-new order (new id,
      // fresh times, no phones attached) replacing the old one.
      return { order: create(branch, number, { etaMinutes, source: 'staff' }), reused: Boolean(existing) };
    },

    // status: 'preparing' | 'ready' | 'collected'
    setStatus(branch, number, status, { defaultPrepMinutes }) {
      let order = find(branch, number);
      if (!order) {
        if (status !== 'ready') return null;
        // Marked ready before the customer looked it up: they'll see "ready" right away.
        order = create(branch, number, { etaMinutes: 0, status: 'ready', source: 'staff' });
        return order;
      }
      const t = now();
      order.status = status;
      if (status === 'ready') order.readyAt = t;
      if (status === 'collected') {
        order.collectedAt = t;
        order.subscriptions = []; // nothing more to send; don't keep browser endpoints around
      }
      if (status === 'preparing') {
        order.readyAt = null;
        order.collectedAt = null;
        if (order.etaAt < t) order.etaAt = t + Math.max(2, Math.round(defaultPrepMinutes / 4)) * 60_000;
      }
      return touch(order);
    },

    addSubscription(order, subscription) {
      const clean = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
      order.subscriptions = order.subscriptions.filter((s) => s.endpoint !== clean.endpoint);
      order.subscriptions.push(clean);
      if (order.subscriptions.length > MAX_PHONES_PER_ORDER) order.subscriptions.shift();
      touch(order);
      return order.subscriptions.length;
    },

    removeSubscription(order, endpoint) {
      const before = order.subscriptions.length;
      order.subscriptions = order.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (order.subscriptions.length !== before) touch(order);
    },

    recordPush(order, result) {
      order.lastPush = { at: now(), ...result };
      touch(order);
    },

    listForStaff(branch) {
      const t = now();
      return [...orders.values()]
        .filter((o) => o.branch === branch && t - o.createdAt < ORDER_LIFETIME)
        .filter((o) => o.status !== 'collected' || t - o.collectedAt < SHOW_COLLECTED_FOR)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    purge() {
      const t = now();
      let removed = 0;
      for (const [key, o] of orders) {
        const expired = t - o.createdAt > ORDER_LIFETIME || (o.status === 'collected' && t - o.collectedAt > 3 * HOUR);
        if (expired) {
          orders.delete(key);
          removed++;
        }
      }
      if (removed) save();
      return removed;
    },

    flush,
    size: () => orders.size,
  };
}

export function customerView(order, t = Date.now()) {
  return {
    number: order.number,
    status: order.status,
    createdAt: order.createdAt,
    etaAt: order.etaAt,
    readyAt: order.readyAt,
    collectedAt: order.collectedAt,
    serverNow: t,
  };
}

export function staffView(order, t = Date.now()) {
  return {
    ...customerView(order, t),
    source: order.source,
    phones: order.subscriptions.length,
    lastPush: order.lastPush,
  };
}
