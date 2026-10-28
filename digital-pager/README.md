# Digital pager (web version)

Customers scan one static QR code, type the order number from their receipt, and see the order's status with an ETA countdown. When staff mark the order ready, the customer's phone gets a notification with sound, even with the screen locked (Android Chrome), and the page itself turns green and beeps if it's open.

No dependencies: just Node.js 20 or newer. Push encryption (RFC 8291), VAPID signing (RFC 8292) and the QR code generator are built in.

## Pages

| Page | Who | What it does |
|---|---|---|
| `/r/demo-cafe` | Customers (the QR code opens this) | Enter order number, see status and ETA, turn on notifications |
| `/staff/demo-cafe` | Staff, on a tablet or the cashier PC | Add orders with an ETA, mark ready (sends the notification), mark picked up |
| `/qr/demo-cafe` | Owner | Printable QR code poster for the counter or tables |

## Run it on your computer

```bash
node server.js
```

Then open http://localhost:3000/staff/demo-cafe (PIN `1234`) and http://localhost:3000/r/demo-cafe in another tab.

## Test on your Android phone

Notifications only work over **HTTPS**, so your phone can't use `http://192.168.x.x:3000`. The quickest way to get an HTTPS address is a free Cloudflare tunnel:

1. Install `cloudflared` ([downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
2. Start the server so it trusts the tunnel's forwarded headers:
   ```bash
   TRUST_PROXY=1 node server.js
   ```
   (Windows PowerShell: `$env:TRUST_PROXY="1"; node server.js`)
3. In a second terminal:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   It prints an address like `https://something-random.trycloudflare.com`.
4. On your computer, open `https://something-random.trycloudflare.com/qr/demo-cafe`. The QR code uses that address.
5. Scan it with the Android phone (Chrome), enter `47`, tap **Notify me when it's ready**, allow notifications, then lock the phone.
6. On the computer, open `.../staff/demo-cafe`, sign in with `1234`, type `47`, tap **Mark ready**. The phone should ring.

The tunnel address changes every time you restart `cloudflared`, so reprint/rescan the QR code each time. For a fixed address, deploy it (below).

## How it works

1. **Lookup.** The page sends the number to `POST /api/branches/<branch>/track`. If staff haven't added it yet, the order is created with the branch's default prep time (turn this off with `requireStaffToAddOrders`).
2. **Status updates.** While the page is on screen it checks the order every 3 seconds (every 5 once ready) with a tiny request that finishes in milliseconds. It stops checking while the phone is locked or the page is in the background, checks immediately when the customer comes back, and stops for good once the order is picked up. The countdown runs from the server's clock, so refreshing doesn't reset it.
3. **Notifications.** Tapping "Notify me" asks for permission, creates a push subscription in the browser, and sends it to the server, which attaches it to that order (up to 5 phones per order).
4. **Ready.** When staff tap **Mark ready**, the server encrypts a message for each phone and sends it to the phone's push service (Google's, for Chrome) with `Urgency: high`. The service worker (`public/sw.js`) shows the notification with sound and vibration. The staff screen shows how many phones were notified, or tells staff to call the number out if none were.
5. **Picked up.** Staff tap **Picked up**; the phones' subscriptions are deleted.

## iPhone

Safari only delivers web push to sites added to the Home Screen (iOS 16.4 or later). So on iPhone there are two modes:

- **In a Safari tab (what a scan opens):** the page offers **Beep when it's ready**. It keeps the screen awake and beeps when the order is ready, as long as the page stays open. It also shows a short guide for adding the page to the Home Screen.
- **As a Home Screen web app:** full notifications with sound, even with the screen locked, exactly like Android. No Apple Developer account is needed, and no server changes: the same code and push keys work for both.

### Test it on your iPhone

1. Start the server and tunnel as in "Test on your Android phone" above.
2. On the iPhone, scan the QR code (or open `https://<your-tunnel>/r/demo-cafe`) in Safari.
3. Tap the Share button, then **Add to Home Screen**. On iOS 26, keep **Open as Web App** on. Tap **Add**.
4. Open the new icon on the Home Screen. It has to be the icon, not the Safari tab.
5. Enter the order number again (Home Screen apps don't share Safari's storage), tap **Notify me when it's ready**, then **Allow**.
6. Lock the phone and mark the order ready on the staff dashboard.

If it doesn't ring:

- Check **Settings → Notifications → (your app name)**: notifications and sounds should be on.
- A Focus mode or silent mode can hide or mute the alert.
- The Home Screen app is tied to the address it was added from. Each new `cloudflared` address needs the app added again, so deploy to a fixed domain for real use.
- Set `VAPID_SUBJECT` to a real `mailto:` address. Apple rejects push requests whose subject isn't a `mailto:` or URL.

The server already follows Apple's push rules: tokens expire in under a day and are reused for hours rather than re-signed per message, `TTL` and `Urgency: high` are always sent, payloads are far under 4 KB, and the service worker shows every push it receives (Safari revokes permission from sites that don't). The "Notify me" tap asks for the subscription immediately, which Safari requires.

For lock-screen alerts without the Home Screen step, the planned upgrade is an Apple Wallet pass. That one does need an Apple Developer Program membership and a pass signing certificate.

## Settings

Restaurants (branches) live in `config/branches.json`:

```json
{
  "demo-cafe": {
    "name": "Demo Café",
    "staffPin": "1234",
    "defaultPrepMinutes": 12,
    "pickupNote": "Pick it up at the counter.",
    "requireStaffToAddOrders": false
  }
}
```

The key (`demo-cafe`) becomes the URL: `/r/demo-cafe`. Use lowercase letters, digits and dashes.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `PUBLIC_URL` | (from the browser) | Your real address, e.g. `https://pager.example.com`. Used in the QR code |
| `VAPID_SUBJECT` | `mailto:owner@example.com` | Contact for push services. Set it to your own `mailto:` |
| `TRUST_PROXY` | off | Set to `1` behind a tunnel or hosting proxy so rate limits see real client IPs |
| `TIME_ZONE` | `Asia/Amman` | Used to separate each day's order numbers |
| `DATA_DIR` | `./data` | Where orders and push keys are saved |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (generated) | Push keys. Generated into `data/vapid.json` on first run |

**Keep `data/vapid.json` secret and never lose it.** It holds the server's private push key: anyone who has it can send notifications to your customers' phones. Never commit the `data/` folder (the repo's `.gitignore` excludes it). If the keys change, every phone has to tap "Notify me" again.

To make new keys (for example, if the file was ever shared): stop the server, delete `data/vapid.json`, and start it again.

## Deploying

Any Node.js host with HTTPS and a persistent disk works (a small VPS, Render, Railway, Fly.io, AWS Lightsail or EC2). Set `PUBLIC_URL`, `VAPID_SUBJECT` and `TRUST_PROXY=1`, and make sure `DATA_DIR` survives restarts.

It runs as a single process: orders are kept in memory and saved to `data/orders.json`. To run several servers behind a load balancer, move the store (`src/store.js`) to a database and the live updates to something like Redis pub/sub.

## Troubleshooting

**`cloudflared` prints `ERR ... stream 273 canceled by remote with error code 0`.** A browser closed a request before it finished, usually because the customer left the page mid-request. Code 0 means a normal close, not a failure. Older versions of this project kept a live-updates connection open for each customer, which produced one of these lines every time someone locked their phone or switched orders. The page now uses short status checks, so you should rarely see it.

**The phone never asks for notification permission.** The page must be opened over `https://` (the tunnel or your real domain), not `http://` with an IP address.

**Notifications stopped after restarting.** The tunnel address changed (each `cloudflared` run gets a new one) or `data/vapid.json` was deleted. Reopen the page from the new address and tap "Notify me" again.

## Tests

```bash
npm test
```

- `test/webpush.test.js`: encryption matches the worked example in RFC 8291 byte for byte; VAPID tokens verify.
- `test/e2e.test.js`: starts the real server with a fake push service and runs the whole flow (track, subscribe, live updates, mark ready, decrypt the received push, unsubscribed phones removed, restart keeps data).

## Files

```
server.js            HTTP server and API
src/webpush.js       Push encryption + VAPID + sending
src/store.js         Orders (in memory + JSON file)
config/branches.json Restaurants, PINs, prep times
public/customer.html Customer page      public/js/customer.js
public/staff.html    Staff dashboard    public/js/staff.js
public/qr.html       QR poster          public/js/qr.js (QR generator)
public/sw.js         Service worker (shows the notification)
public/css/styles.css
```

## Known limits

- The staff PIN is a simple shared secret per branch. Fine for a pilot; add real accounts before selling to many restaurants.
- The page is English only. Arabic (right-to-left) is a natural next step; order numbers already accept Arabic digits.
- Fonts load from Google Fonts. Self-host them if you want the page to work with no outside requests.
