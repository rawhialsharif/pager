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
2. **Live status.** The page keeps a Server-Sent Events connection open, so status changes appear instantly. The countdown runs from the server's clock, so refreshing doesn't reset it.
3. **Notifications.** Tapping "Notify me" asks for permission, creates a push subscription in the browser, and sends it to the server, which attaches it to that order (up to 5 phones per order).
4. **Ready.** When staff tap **Mark ready**, the server encrypts a message for each phone and sends it to the phone's push service (Google's, for Chrome) with `Urgency: high`. The service worker (`public/sw.js`) shows the notification with sound and vibration. The staff screen shows how many phones were notified, or tells staff to call the number out if none were.
5. **Picked up.** Staff tap **Picked up**; the phones' subscriptions are deleted.

## iPhone behavior

Safari can't receive web push in a normal tab. On iPhones the page offers **Beep when it's ready** instead: it keeps the screen awake and beeps while open, and explains how to add the page to the Home Screen, which enables real notifications (iOS 16.4+). An Apple Wallet pass is the planned upgrade for locked-screen alerts on iPhone.

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

**Keep `data/vapid.json` secret and never lose it.** If the keys change, every phone's subscription stops working.

## Deploying

Any Node.js host with HTTPS and a persistent disk works (a small VPS, Render, Railway, Fly.io, AWS Lightsail or EC2). Set `PUBLIC_URL`, `VAPID_SUBJECT` and `TRUST_PROXY=1`, and make sure `DATA_DIR` survives restarts.

It runs as a single process: orders are kept in memory and saved to `data/orders.json`. To run several servers behind a load balancer, move the store (`src/store.js`) to a database and the live updates to something like Redis pub/sub.

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
