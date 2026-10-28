// Staff dashboard: add orders with an ETA, mark them ready (sends the notification), mark picked up.

const branch = document.body.dataset.branch;
const $ = (id) => document.getElementById(id);
const els = {
  gate: $('pin-gate'),
  pinInput: $('pin-input'),
  pinError: $('pin-error'),
  dashboard: $('dashboard'),
  connection: $('connection'),
  lock: $('lock'),
  composer: $('composer'),
  numberInput: $('number-input'),
  chips: $('eta-chips'),
  composerError: $('composer-error'),
  addOrder: $('add-order'),
  markReady: $('mark-ready'),
  toast: $('toast'),
  lists: { preparing: $('list-preparing'), ready: $('list-ready'), collected: $('list-collected') },
  counts: { preparing: $('count-preparing'), ready: $('count-ready'), collected: $('count-collected') },
};

const PIN_KEY = `pager-staff-pin:${branch}`;
const ETA_CHOICES = [5, 10, 15, 20, 30];
let pin = null;
let pollTimer = null;
let clockOffset = 0;
let lastOrders = [];
let failures = 0;

const session = {
  get() {
    try {
      return sessionStorage.getItem(PIN_KEY);
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem(PIN_KEY, v);
    } catch {
      /* ignore */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(PIN_KEY);
    } catch {
      /* ignore */
    }
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Staff-Pin': pin ?? '', ...(options.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw Object.assign(new Error(body?.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

// ---------- Sign in ----------

function showGate(message = '') {
  stopPolling();
  els.dashboard.hidden = true;
  els.gate.hidden = false;
  els.pinError.textContent = message;
  els.pinInput.value = '';
  els.pinInput.focus();
}

async function signIn(candidate) {
  pin = candidate;
  try {
    const data = await api(`/api/staff/${branch}/orders`);
    session.set(pin);
    els.gate.hidden = true;
    els.dashboard.hidden = false;
    buildChips(data.branch.defaultPrepMinutes);
    applyList(data);
    startPolling();
    els.numberInput.focus();
  } catch (err) {
    pin = null;
    session.clear();
    showGate(err.status === 401 || err.status === 429 ? err.message : 'Couldn’t reach the server. Check the connection and try again.');
  }
}

els.gate.addEventListener('submit', (e) => {
  e.preventDefault();
  signIn(els.pinInput.value.trim());
});

els.lock.addEventListener('click', () => {
  pin = null;
  session.clear();
  showGate();
});

// ---------- ETA chips ----------

function buildChips(defaultMinutes) {
  const choices = [...new Set([...ETA_CHOICES, defaultMinutes])].sort((a, b) => a - b);
  els.chips.replaceChildren(
    ...choices.map((m) => {
      const label = document.createElement('label');
      label.className = 'chip';
      label.innerHTML = `<input type="radio" name="eta" value="${m}"${m === defaultMinutes ? ' checked' : ''}><span>${m} min</span>`;
      return label;
    }),
  );
}

const selectedEta = () => Number(els.chips.querySelector('input:checked')?.value ?? 10);

// ---------- Actions ----------

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4000);
}

function phonesText(n) {
  return n === 1 ? '1 phone' : `${n} phones`;
}

async function setStatus(number, status) {
  const data = await api(`/api/staff/${branch}/orders/${encodeURIComponent(number)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
  if (status === 'ready' && data.push) {
    const { sent, failed } = data.push;
    if (sent === 0 && failed === 0) toast(`Order ${number} is ready. No phones are following it, so call it out.`);
    else if (failed === 0) toast(`Order ${number} is ready. Notified ${phonesText(sent)}.`);
    else toast(`Order ${number} is ready. Notified ${phonesText(sent)}, ${failed} failed. Call it out to be safe.`);
  }
  if (status === 'collected') toast(`Order ${number} picked up.`);
  await poll();
}

async function runComposer(action) {
  const number = els.numberInput.value.trim();
  els.composerError.textContent = '';
  if (!number) {
    els.composerError.textContent = 'Type the order number from the receipt first.';
    els.numberInput.focus();
    return;
  }
  const buttons = [els.addOrder, els.markReady];
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (action === 'add') {
      const order = await api(`/api/staff/${branch}/orders`, { method: 'POST', body: JSON.stringify({ number, etaMinutes: selectedEta() }) });
      toast(`Order ${order.number} added, ready in about ${selectedEta()} min.`);
      await poll();
    } else {
      await setStatus(number, 'ready');
    }
    els.numberInput.value = '';
  } catch (err) {
    if (err.status === 401) return showGate('Your PIN changed or expired. Sign in again.');
    els.composerError.textContent = err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    els.numberInput.focus();
  }
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  runComposer('add');
});
els.markReady.addEventListener('click', () => runComposer('ready'));

// Order card buttons (event delegation)
els.dashboard.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  button.disabled = true;
  try {
    await setStatus(button.dataset.number, button.dataset.action);
  } catch (err) {
    if (err.status === 401) return showGate('Your PIN changed or expired. Sign in again.');
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

// ---------- List ----------

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function preparingText(left) {
  if (left > 30_000) return { text: `${Math.ceil(left / 60_000)} min left`, late: false };
  if (left > -60_000) return { text: 'Due now', late: false };
  return { text: `${Math.round(-left / 60_000)} min late`, late: true };
}

function readyText(elapsed) {
  return elapsed < 60_000 ? 'Ready just now' : `Ready ${Math.round(elapsed / 60_000)} min ago`;
}

function slip(order) {
  const now = Date.now() + clockOffset;
  const li = document.createElement('li');
  li.className = 'slip';
  li.dataset.status = order.status;

  const number = document.createElement('span');
  number.className = 'slip-number';
  number.textContent = order.number;

  const time = document.createElement('span');
  time.className = 'slip-time';
  const phones = document.createElement('span');
  phones.className = 'slip-phones';

  const actions = document.createElement('div');
  actions.className = 'slip-actions';
  const button = (label, action, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.dataset.action = action;
    b.dataset.number = order.number;
    return b;
  };

  if (order.status === 'preparing') {
    const { text, late } = preparingText(order.etaAt - now);
    time.textContent = text;
    time.classList.toggle('is-late', late);
    actions.append(button('Mark ready', 'ready', 'btn-ready'));
  } else if (order.status === 'ready') {
    time.textContent = readyText(now - order.readyAt);
    actions.append(button('Picked up', 'collected', 'btn-primary'), button('Undo', 'preparing', 'btn-quiet'));
  } else {
    time.textContent = `Picked up ${timeFormat.format(order.collectedAt)}`;
    actions.append(button('Undo', 'ready', 'btn-quiet'));
  }

  if (order.status !== 'collected') {
    phones.textContent = order.phones ? `${phonesText(order.phones)} notified when ready` : 'No phone following';
    if (order.status === 'ready') phones.textContent = order.phones ? `${phonesText(order.phones)} following` : 'No phone following, call it out';
    phones.classList.toggle('is-none', !order.phones && order.status === 'ready');
  } else {
    phones.textContent = '';
  }

  li.append(number, time, phones, actions);
  return li;
}

function renderList() {
  const groups = { preparing: [], ready: [], collected: [] };
  for (const o of lastOrders) groups[o.status]?.push(o);
  groups.collected.reverse(); // most recent first
  for (const [status, list] of Object.entries(groups)) {
    const ul = els.lists[status];
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'lane-empty';
      empty.textContent = { preparing: 'No orders in the kitchen.', ready: 'Nothing waiting for pickup.', collected: 'Nothing picked up recently.' }[status];
      ul.replaceChildren(empty);
    } else {
      ul.replaceChildren(...list.map(slip));
    }
    els.counts[status].textContent = list.length ? String(list.length) : '';
  }
}

function applyList(data) {
  clockOffset = data.serverNow - Date.now();
  lastOrders = data.orders;
  renderList();
}

async function poll() {
  try {
    applyList(await api(`/api/staff/${branch}/orders`));
    failures = 0;
    els.connection.textContent = 'Live';
    els.connection.dataset.ok = 'true';
  } catch (err) {
    if (err.status === 401) return showGate('Your PIN changed or expired. Sign in again.');
    failures++;
    if (failures >= 2) {
      els.connection.textContent = 'Offline, retrying…';
      els.connection.dataset.ok = 'false';
    }
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 3000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Start ----------

const saved = session.get();
if (saved) signIn(saved);
else showGate();
