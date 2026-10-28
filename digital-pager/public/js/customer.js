// Customer page: enter order number -> live status + ETA -> alert when ready.

const branch = document.body.dataset.branch;
const branchName = document.querySelector('.venue').textContent.trim();
const $ = (id) => document.getElementById(id);
const els = {
  viewEnter: $('view-enter'),
  viewOrder: $('view-order'),
  form: $('enter-form'),
  input: $('order-input'),
  enterError: $('enter-error'),
  enterSubmit: $('enter-submit'),
  ticket: $('ticket'),
  number: $('ticket-number'),
  statusText: $('status-text'),
  etaMain: $('eta-main'),
  etaSub: $('eta-sub'),
  progress: $('progress'),
  bar: $('progress-bar'),
  readyMessage: $('ready-message'),
  pickupNote: $('pickup-note'),
  stopSound: $('stop-sound'),
  alerts: $('alerts'),
  notifyBtn: $('notify-btn'),
  notifyHelp: $('notify-help'),
  iosHowto: $('ios-howto'),
  changeOrder: $('change-order'),
};

const STORE_KEY = `pager:${branch}`;
const REMEMBER_FOR = 6 * 3600_000;

const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage blocked: the URL still remembers the order */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const platform = (() => {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { iOS, standalone, pushSupported };
})();

let order = null; // latest order from the server
let clockOffset = 0; // server clock minus phone clock
let events = null;
let tickTimer = null;
let alertsState = 'idle';
let keepOpenReason = null;
let audio = null;
let ringTimer = null;
let wakeLock = null;
let alertedFor = null;
let pickupNote = 'Pick it up at the counter.';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtTime = (ms) => timeFormat.format(new Date(ms));
const orderPath = (number) => `/api/branches/${branch}/orders/${encodeURIComponent(number)}`;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw Object.assign(new Error(body?.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

// ---------- Views ----------

function showEnter(message = '') {
  stopLive();
  stopRinging();
  order = null;
  document.body.dataset.status = 'none';
  document.title = `Track your order – ${branchName}`;
  els.viewOrder.hidden = true;
  els.viewEnter.hidden = false;
  els.enterError.textContent = message;
}

function showOrder() {
  els.viewEnter.hidden = true;
  els.viewOrder.hidden = false;
}

function render() {
  if (!order) return;
  const { status } = order;
  document.body.dataset.status = status;
  els.ticket.dataset.status = status;
  els.number.textContent = order.number;
  els.number.classList.toggle('is-long', order.number.length > 4);
  els.statusText.textContent = { preparing: 'Preparing', ready: 'Ready for pickup', collected: 'Picked up' }[status];
  els.readyMessage.hidden = status !== 'ready';
  els.alerts.hidden = status !== 'preparing';
  els.progress.hidden = status !== 'preparing';
  els.pickupNote.textContent = pickupNote;

  els.etaMain.hidden = status === 'ready'; // the big headline below says it
  if (status === 'ready') {
    els.etaSub.textContent = `Ready since ${fmtTime(order.readyAt)}`;
    document.title = `Ready – order ${order.number}`;
  } else if (status === 'collected') {
    els.etaMain.textContent = 'Enjoy your meal';
    els.etaSub.textContent = `Picked up at ${fmtTime(order.collectedAt)}`;
    document.title = `Order ${order.number} – ${branchName}`;
  } else {
    renderCountdown();
    document.title = `Order ${order.number} – ${branchName}`;
  }
}

function renderCountdown() {
  if (!order || order.status !== 'preparing') return;
  const now = Date.now() + clockOffset;
  const remaining = order.etaAt - now;
  const total = order.etaAt - order.createdAt;
  els.bar.style.width = total > 0 ? `${Math.min(100, Math.max(0, (1 - remaining / total) * 100))}%` : '100%';
  if (remaining > 60_000) {
    els.etaMain.textContent = `About ${Math.ceil(remaining / 60_000)} min`;
    els.etaSub.textContent = `Estimated ready by ${fmtTime(order.etaAt)}`;
  } else if (remaining > 0) {
    els.etaMain.textContent = 'Less than a minute';
    els.etaSub.textContent = `Estimated ready by ${fmtTime(order.etaAt)}`;
  } else {
    els.etaMain.textContent = 'Almost ready';
    els.etaSub.textContent = 'Taking a little longer than estimated.';
  }
}

function applyOrder(data) {
  const previous = order;
  order = data;
  clockOffset = data.serverNow - Date.now();
  render();
  if (data.status === 'ready') onReady();
  else stopRinging();
  if (previous && previous.status !== data.status && data.status === 'collected') releaseWakeLock();
}

// ---------- Tracking ----------

async function track(raw, { quiet = false } = {}) {
  const number = String(raw || '').trim();
  if (!number) {
    els.enterError.textContent = 'Enter the order number from your receipt.';
    els.input.focus();
    return;
  }
  els.enterError.textContent = '';
  els.enterSubmit.disabled = true;
  els.enterSubmit.textContent = 'Finding your order…';
  try {
    const data = await api(`/api/branches/${branch}/track`, { method: 'POST', body: JSON.stringify({ number }) });
    applyOrder(data);
    storage.set(STORE_KEY, { number: data.number, savedAt: Date.now() });
    const url = new URL(location.href);
    url.searchParams.set('order', data.number);
    history.replaceState(null, '', url);
    showOrder();
    startLive();
    restoreAlertsState();
  } catch (err) {
    if (quiet) showEnter();
    else els.enterError.textContent = err.status ? err.message : 'Couldn’t reach the restaurant. Check your connection and try again.';
  } finally {
    els.enterSubmit.disabled = false;
    els.enterSubmit.textContent = 'Track order';
  }
}

async function refresh() {
  if (!order) return;
  try {
    applyOrder(await api(orderPath(order.number)));
  } catch {
    /* offline for a moment; the live connection will catch up */
  }
}

function startLive() {
  stopLive();
  events = new EventSource(`${orderPath(order.number)}/events`);
  events.onmessage = (e) => {
    try {
      applyOrder(JSON.parse(e.data));
    } catch {
      /* ignore malformed message */
    }
  };
  tickTimer = setInterval(renderCountdown, 1000);
}

function stopLive() {
  events?.close();
  events = null;
  clearInterval(tickTimer);
  tickTimer = null;
}

// ---------- Alerts: notifications, or a beeping page as the fallback ----------

const COPY = {
  idle: () => ({ button: 'Notify me when it’s ready', help: 'We’ll send a notification with sound, even if your screen is locked.' }),
  working: () => ({ button: 'Turning on notifications…', help: '', disabled: true }),
  on: () => ({
    button: 'Notifications on',
    help: `You can lock your phone now. We’ll notify you when order ${order?.number ?? ''} is ready.`,
    disabled: true,
  }),
  denied: () => ({
    button: 'Beep when it’s ready',
    help: 'Notifications are blocked for this site. Keep this page open and it will beep, or allow notifications in your browser’s site settings.',
  }),
  unsupported: () => ({
    button: 'Beep when it’s ready',
    help: platform.iOS
      ? 'On iPhone, Safari can only alert you while this page is open. Keep it open, or add it to your Home Screen for alerts with your screen locked.'
      : 'This browser can’t show notifications. Keep this page open and it will beep when your order is ready.',
  }),
  'keep-open-on': () => ({
    button: 'Beep is on',
    help:
      (keepOpenReason === 'denied' ? 'Notifications are blocked for this site, so keep this page open.' : 'Keep this page open.') +
      (wakeLock ? ' Your screen will stay on, and it will beep when your order is ready.' : ' Leave your screen on, and it will beep when your order is ready.'),
    disabled: true,
  }),
  error: () => ({
    button: 'Try again',
    help: 'Couldn’t turn on notifications. Check your connection and try again. This page will still beep while it’s open.',
  }),
};

function setAlertsState(state) {
  alertsState = state;
  const c = COPY[state]();
  els.alerts.dataset.state = state;
  els.notifyBtn.textContent = c.button;
  els.notifyBtn.disabled = Boolean(c.disabled);
  els.notifyHelp.textContent = c.help;
  els.notifyHelp.hidden = !c.help;
  els.iosHowto.hidden = !(platform.iOS && !platform.standalone && !platform.pushSupported && (state === 'unsupported' || state === 'keep-open-on'));
}

async function restoreAlertsState() {
  if (keepOpenReason) return setAlertsState('keep-open-on');
  if (!platform.pushSupported) return setAlertsState('unsupported');
  if (Notification.permission === 'denied') return setAlertsState('denied');
  if (Notification.permission === 'granted') {
    // Allowed before (for an earlier order): attach this order without asking again.
    try {
      setAlertsState('working');
      await subscribeThisOrder();
      return setAlertsState('on');
    } catch (err) {
      console.warn('Re-subscribe failed', err);
      return setAlertsState('error');
    }
  }
  setAlertsState('idle');
}

function base64UrlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}

async function subscribeThisOrder() {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push-key');
  const serverKey = base64UrlToBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, serverKey)) {
    await subscription.unsubscribe(); // server keys changed since this phone subscribed
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  }
  await api(`${orderPath(order.number)}/subscribe`, { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
}

async function enablePush() {
  setAlertsState('working');
  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    permission = Notification.permission;
  }
  if (permission === 'denied') return enableKeepOpen('denied');
  if (permission !== 'granted') return setAlertsState('idle'); // dismissed the prompt
  try {
    await subscribeThisOrder();
    setAlertsState('on');
  } catch (err) {
    console.warn('Subscribe failed', err);
    setAlertsState('error');
  }
}

async function enableKeepOpen(reason = 'unsupported') {
  keepOpenReason = reason;
  await requestWakeLock();
  setAlertsState('keep-open-on');
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// Browsers only allow sound after a tap, so every button tap "unlocks" audio for later.
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audio) audio = new Ctx();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.02);
  } catch {
    audio = null;
  }
}

function chime() {
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume();
  const t0 = audio.currentTime + 0.03;
  [
    [1046.5, 0],
    [1318.5, 0.18],
    [1046.5, 0.36],
    [1318.5, 0.54],
  ].forEach(([freq, dt]) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + dt);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + dt);
    osc.stop(t0 + dt + 0.18);
  });
}

function ring() {
  stopRinging();
  let count = 0;
  const once = () => {
    chime();
    navigator.vibrate?.([300, 120, 300, 120, 300]);
    if (++count >= 8) stopRinging();
  };
  once();
  ringTimer = setInterval(once, 3500);
  els.stopSound.hidden = !audio;
}

function stopRinging() {
  if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
    navigator.vibrate?.(0);
  }
  els.stopSound.hidden = true;
}

function onReady() {
  const key = `${order.number}|${order.readyAt}`;
  if (alertedFor === key) return;
  alertedFor = key;
  ring();
}

// ---------- Events ----------

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  track(els.input.value);
});

els.input.addEventListener('input', () => {
  els.enterError.textContent = '';
});

els.notifyBtn.addEventListener('click', () => {
  unlockAudio();
  if (alertsState === 'idle' || alertsState === 'error') enablePush();
  else if (alertsState === 'denied') enableKeepOpen('denied');
  else if (alertsState === 'unsupported') enableKeepOpen('unsupported');
});

els.stopSound.addEventListener('click', stopRinging);

els.changeOrder.addEventListener('click', async () => {
  const old = order;
  if (old && alertsState === 'on' && platform.pushSupported) {
    // Stop alerts for the old order on this phone.
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await api(`${orderPath(old.number)}/unsubscribe`, { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
    } catch {
      /* not critical */
    }
  }
  storage.remove(STORE_KEY);
  const url = new URL(location.href);
  url.searchParams.delete('order');
  history.replaceState(null, '', url);
  keepOpenReason = null;
  releaseWakeLock();
  els.input.value = '';
  showEnter();
  els.input.focus();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !order) return;
  refresh();
  if (!events || events.readyState === EventSource.CLOSED) startLive();
  if (keepOpenReason && order.status === 'preparing') requestWakeLock();
});

if (platform.pushSupported) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'order-ready') refresh();
  });
}

// ---------- Start ----------

async function init() {
  if (platform.pushSupported) navigator.serviceWorker.register('/sw.js').catch(() => {});
  api(`/api/branches/${branch}`)
    .then((b) => {
      pickupNote = b.pickupNote || pickupNote;
      render();
    })
    .catch(() => {});

  const fromUrl = new URL(location.href).searchParams.get('order');
  const saved = storage.get(STORE_KEY);
  const candidate = fromUrl || (saved && Date.now() - saved.savedAt < REMEMBER_FOR ? saved.number : null);
  if (candidate) {
    els.input.value = candidate;
    await track(candidate, { quiet: true });
  } else {
    showEnter();
    els.input.focus({ preventScroll: true });
  }
}

init();
