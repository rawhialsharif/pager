"""
iPhone sound check: python3 tools/iphone-sound-check.py   (needs: pip install playwright; takes ~3 minutes)
Runs the real customer page in Chromium made to behave like Safari on an iPhone, and checks
that it rings when the order is marked ready. Emulated:
  - iPhone user agent, touch, and no Push API (as in a normal Safari tab)
  - Safari's media rule: an <audio> element may play with sound only if play() was once
    called on it during a tap (rule "webkit"), or, in the "strict" variant, only if that
    tap-time play was unmuted (so the page's muted warm-up does NOT count)
  - navigator.audioSession (iOS 17+), navigator.wakeLock, Safari's "interrupted" AudioContext
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = tempfile.mkdtemp(prefix='pager-iphone-check-')
PORT = 3130
B = f'http://localhost:{PORT}'
IPHONE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 '
             '(KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1')

INIT = r"""
(() => {
  const rule = %RULE%;
  delete window.PushManager;
  window.__log = { play: [], pause: 0, ended: 0, session: [], wake: 0, resumes: 0, osc: 0, errors: [] };
  window.__fakeCtxState = null;

  // Safari's per-element media rule
  const allowedEls = new WeakSet();
  // "During a tap" = while a real (trusted) tap or key event is being handled, like Safari.
  // (Not navigator.userActivation: the test tool's own page checks would count as taps.)
  let inTap = false;
  ['click', 'touchend', 'keydown', 'pointerup', 'mouseup'].forEach((type) => window.addEventListener(type, (e) => {
    if (e.isTrusted) { inTap = true; setTimeout(() => { inTap = false; }, 0); }
  }, true));
  window.__log_ended = 0;
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__el = this;
    const gesture = inTap;
    if (!this.__counted) { this.__counted = true; this.addEventListener('ended', () => window.__log.ended++); }
    const blesses = gesture && (rule === 'webkit' || !this.muted);
    if (blesses) allowedEls.add(this);
    const allowed = allowedEls.has(this) || this.muted;
    window.__log.play.push({ t: Date.now(), muted: this.muted, gesture, allowed });
    if (!allowed) return Promise.reject(new DOMException('needs a tap', 'NotAllowedError'));
    return origPlay.call(this);
  };
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () { window.__log.pause++; return origPause.call(this); };

  // iOS 17+ audio session
  let sessionType = 'auto';
  Object.defineProperty(navigator, 'audioSession', { value: {
    get type() { return sessionType; },
    set type(v) { sessionType = v; window.__log.session.push(v); },
  }});

  // Screen wake lock
  Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
    window.__log.wake++;
    return { released: false, release: async () => {}, addEventListener() {} };
  }}});

  // Web Audio, with Safari's "interrupted" state on demand
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) { super(...a); window.__ctx = this; }
    get state() { return window.__fakeCtxState || super.state; }
    resume() { window.__log.resumes++; window.__fakeCtxState = null; return super.resume(); }
    createOscillator() {
      const o = super.createOscillator(); const start = o.start.bind(o);
      o.start = (...a) => { window.__log.osc++; return start(...a); }; return o;
    }
  };
  window.addEventListener('error', (e) => window.__log.errors.push(String(e.message)));
})();
"""


def staff(path, body=None):
    req = urllib.request.Request(f'{B}/api/staff/demo-cafe{path}', data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json', 'X-Staff-Pin': '1234'},
                                 method='POST' if body else 'GET')
    return json.load(urllib.request.urlopen(req))


def add_order(n):
    staff('/orders', {'number': n, 'etaMinutes': 10})


def mark(n, status):
    staff(f'/orders/{n}/status', {'status': status})


results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))


def new_iphone(browser, rule='webkit'):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, user_agent=IPHONE_UA)
    ctx.add_init_script(INIT.replace('%RULE%', json.dumps(rule)))
    page = ctx.new_page()
    page.on('pageerror', lambda e: results.append(('no page errors', False, str(e))))
    return ctx, page


def log(page):
    return page.evaluate('window.__log')


def el_state(page):
    return page.evaluate("""() => { const e = window.__el; return e ? { paused: e.paused, muted: e.muted, t: e.currentTime,
        ready: e.readyState, src: e.currentSrc } : null }""")


def track(page, n):
    page.goto(f'{B}/r/demo-cafe')
    page.fill('#order-input', n)
    page.click('#enter-submit')
    page.wait_for_selector('#view-order:not([hidden])')


def wait_ready(page):
    page.wait_for_function("document.body.dataset.status === 'ready'", timeout=8000)


def plays_after(page, t0, with_sound=True):
    return [p for p in log(page)['play'] if p['t'] >= t0 and p['allowed'] and (not with_sound or not p['muted'])]


env = dict(os.environ, PORT=str(PORT), HOST='127.0.0.1', DATA_DIR=DATA,
           VAPID_SUBJECT='mailto:test@example.com')
srv = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{PORT}/healthz'); break
    except Exception:
        time.sleep(0.1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--autoplay-policy=user-gesture-required'])

        # ---- 1. The normal case: track, tap "Beep when it's ready", wait, order is marked ready
        print('\n1. Track, tap "Beep when it\'s ready", wait 75 s, staff marks ready')
        add_order('11'); ctx, page = new_iphone(browser)
        track(page, '11')
        check('iPhone Safari tab is offered "Beep when it\'s ready"', page.inner_text('#notify-btn') == 'Beep when it’s ready')
        page.click('#notify-btn'); page.wait_for_timeout(500)
        L = log(page)
        warmups = [x for x in L['play'] if x['gesture']]
        check('warm-up during the tap is muted (no sound on tap)', warmups and all(x['muted'] for x in warmups), f'{len(warmups)} warm-up(s)')
        check('screen kept on (wake lock requested)', L['wake'] >= 1)
        check('"Play a test sound" is shown', page.is_visible('#test-sound'))
        es = el_state(page)
        check('alert sound loaded from the server', es and es['ready'] >= 2 and es['src'].endswith('/sounds/ready.wav'), f"readyState {es and es['ready']}")
        check('element is paused and unmuted after warm-up', es and es['paused'] and not es['muted'])
        page.wait_for_timeout(75_000)
        t0 = int(time.time() * 1000); mark('11', 'ready'); wait_ready(page)
        page.wait_for_timeout(400)
        es = el_state(page)
        check('rings: <audio> plays with sound after the wait', plays_after(page, t0) and es and not es['paused'] and not es['muted'] and es['t'] > 0,
              f"playing={es and not es['paused']} t={es and round(es['t'], 2)}")
        check('silent-switch override on while ringing (audioSession = playback)', log(page)['session'][-1:] == ['playback'])
        check('"Stop the sound" is shown', page.is_visible('#stop-sound'))
        page.wait_for_timeout(7600)
        n = len(plays_after(page, t0))
        check('keeps ringing (3 beeps in ~8 s)', n >= 3, f'{n} beeps')
        page.click('#ticket')  # tapping elsewhere while ringing
        page.wait_for_timeout(3700)
        check('tapping the page while ringing does not stop it', len(plays_after(page, t0)) >= n + 1)
        page.click('#stop-sound'); page.wait_for_timeout(300); t_stop = int(time.time() * 1000)
        es = el_state(page)
        check('"Stop the sound" stops it immediately', es['paused'] and log(page)['session'][-1] == 'auto')
        page.wait_for_timeout(4000)
        check('no beeps after stopping', not plays_after(page, t_stop))
        ctx.close()

        # ---- 2. Never taps the beep button: Track was the only tap
        print('\n2. Only taps "Track order", never the beep button')
        add_order('12'); ctx, page = new_iphone(browser)
        track(page, '12'); page.wait_for_timeout(6500)
        t0 = int(time.time() * 1000); mark('12', 'ready'); wait_ready(page); page.wait_for_timeout(400)
        es = el_state(page)
        check('rings anyway', plays_after(page, t0) and not es['paused'] and not es['muted'])
        e0 = log(page)['ended']
        page.wait_for_timeout(8 * 3500 + 1000)
        L = log(page); n = len(plays_after(page, t0))
        check('full ring: 8 beeps, each plays to the end (none cut off)', n == 8 and L['ended'] - e0 >= 8, f"{n} beeps, {L['ended'] - e0} finished")
        check('after the ring: silent-switch override off, stop button hidden', L['session'][-1] == 'auto' and not page.is_visible('#stop-sound'))
        ctx.close()

        # ---- 3. Page reopened from its link: no tap since it loaded
        print('\n3. Page reopened or refreshed, no tap since')
        add_order('13'); ctx, page = new_iphone(browser)
        page.goto(f'{B}/r/demo-cafe?order=13'); page.wait_for_selector('#view-order:not([hidden])'); page.wait_for_timeout(1500)
        t0 = int(time.time() * 1000); mark('13', 'ready'); wait_ready(page); page.wait_for_timeout(500)
        no_sound = not plays_after(page, t0) and page.evaluate('!window.__ctx || window.__ctx.state !== "running"')
        check('EXPECTED LIMIT: no sound without any tap (Safari blocks it); screen still turns green', no_sound and page.evaluate("document.body.dataset.status") == 'ready')
        ctx.close()
        add_order('14'); ctx, page = new_iphone(browser)
        page.goto(f'{B}/r/demo-cafe?order=14'); page.wait_for_selector('#view-order:not([hidden])')
        page.click('.ticket-number'); page.wait_for_timeout(6500)
        t0 = int(time.time() * 1000); mark('14', 'ready'); wait_ready(page); page.wait_for_timeout(400)
        check('one tap anywhere on the page is enough to ring', plays_after(page, t0) and not el_state(page)['paused'])
        ctx.close()

        # ---- 4. Stricter media rule: muted warm-up doesn't count -> Web Audio backup
        print('\n4. If Safari did not count the muted warm-up: Web Audio backup')
        add_order('15'); ctx, page = new_iphone(browser, rule='strict')
        track(page, '15'); page.click('#notify-btn'); page.wait_for_timeout(6500)
        ctx_running = page.evaluate('window.__ctx && window.__ctx.state')
        osc0 = log(page)['osc']
        t0 = int(time.time() * 1000); mark('15', 'ready'); wait_ready(page); page.wait_for_timeout(400)
        L = log(page)
        check('<audio> refused (as this rule says)', not plays_after(page, t0))
        check('Web Audio backup beeps instead', L['osc'] - osc0 >= 4 and ctx_running == 'running', f"{L['osc'] - osc0} tones, context {ctx_running}")
        ctx.close()

        # ---- 5. Safari pauses Web Audio by itself ("interrupted")
        print('\n5. Safari marks the sound engine "interrupted" while waiting')
        add_order('16'); ctx, page = new_iphone(browser, rule='strict')
        track(page, '16'); page.click('#notify-btn'); page.wait_for_timeout(6500)
        page.evaluate("window.__fakeCtxState = 'interrupted'")
        r0 = log(page)['resumes']; osc0 = log(page)['osc']
        mark('16', 'ready'); wait_ready(page); page.wait_for_timeout(400)
        L = log(page)
        check('resumes the sound engine before beeping', L['resumes'] > r0 and L['osc'] - osc0 >= 4, f"resume calls +{L['resumes'] - r0}")
        ctx.close()

        # ---- 6. Test-sound button, including as the very first tap
        print('\n6. "Play a test sound"')
        add_order('17'); ctx, page = new_iphone(browser)
        page.goto(f'{B}/r/demo-cafe?order=17'); page.wait_for_selector('#view-order:not([hidden])')
        page.click('#notify-btn'); page.wait_for_timeout(1200)  # enter keep-open mode
        t0 = int(time.time() * 1000); page.click('#test-sound'); page.wait_for_timeout(350)
        es = el_state(page)
        check('plays one beep with sound', plays_after(page, t0) and not es['muted'] and es['t'] > 0)
        page.wait_for_timeout(1200)
        check('only one beep (not a ring), and it played to the end', len(plays_after(page, t0)) == 1 and el_state(page)['paused'] and log(page)['ended'] >= 1)
        ctx.close()
        add_order('18'); ctx, page = new_iphone(browser)
        page.goto(f'{B}/r/demo-cafe?order=18'); page.wait_for_selector('#view-order:not([hidden])')
        page.evaluate("document.getElementById('test-sound').hidden = false")  # first tap of the session
        t0 = int(time.time() * 1000); page.click('#test-sound'); page.wait_for_timeout(350)
        es = el_state(page)
        check('works as the first tap too (warm-up doesn\'t cut it off)', plays_after(page, t0) and not es['paused'] and not es['muted'])
        ctx.close()

        browser.close()
finally:
    srv.terminate(); srv.communicate(timeout=5)
    shutil.rmtree(DATA, ignore_errors=True)

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
for f in fails:
    print('FAILED:', f[0], f[2])
sys.exit(1 if fails else 0)
