# Deploy on Azure (free with Azure for Students)

This puts the pager on a small always-on Linux server in Azure, connected to your domain through a Cloudflare tunnel, with **auto-deploy from GitHub**: every minute the server checks this repo, and when there's a new commit on `main` it runs the tests and only then switches to it. A commit whose tests fail is skipped, and the working version keeps running.

The scripts work on any Ubuntu 22.04/24.04 server, so the same steps apply to AWS Lightsail or Oracle Cloud.

What you need: the Azure for Students subscription, your domain already active in Cloudflare, about 20 minutes.

## 1. Create the server

In the [Azure portal](https://portal.azure.com), create a **Virtual machine**:

| Setting | Choose |
|---|---|
| Subscription | Azure for Students |
| Resource group | Create new: `pager` |
| Name | `pager-vm` |
| Region | One near Jordan that offers the size below (the UAE or Europe) |
| Image | Ubuntu Server 24.04 LTS (x64) |
| Size | **B1s** (included in the 12-month free services; the portal marks free-eligible sizes) |
| Authentication | SSH public key, username `azureuser`. Download the private key when asked |
| Inbound ports | **SSH (22) only.** No web ports: the tunnel connects outward, so nothing else needs to be open |

On the other tabs:

| Tab | Setting | Choose |
|---|---|---|
| Disks | OS disk size | **64 GiB (P6)**: the free services cover two 64 GB P6 SSD disks |
| Disks | OS disk type | **Premium SSD** |
| Networking | Delete public IP and NIC when VM is deleted | On |
| Management | Auto-shutdown | **Off**. A pager has to stay on |

Then Review + create. When it offers the key pair, choose **Download private key and create resource**: it's the only time you can download it. Afterwards:

- **Set a budget alert** in Cost Management (for example $5, with an email). Azure for Students has no card attached, so it can't charge you, but the alert tells you early if something is using your credit.
- **Optional but recommended:** in the VM's Networking settings, limit the SSH rule to your own IP address.

## 2. Connect to it

From a terminal on your computer (PowerShell on Windows works too), using the key you downloaded and the VM's public IP address from its overview page:

```bash
ssh -i ~/Downloads/pager-vm_key.pem azureuser@<public-ip>
```

On Mac/Linux, if it complains the key is "too open", run `chmod 400 ~/Downloads/pager-vm_key.pem` first.

## 3. Install the pager

On the server:

```bash
git clone https://github.com/rawhialsharif/pager.git
sudo bash pager/deploy/azure/setup.sh order.yourdomain.com you@yourdomain.com
```

Use your real address and email. The script installs Node.js and cloudflared, sets the app up in `/opt/pager`, starts it, and turns on auto-deploy. It ends by checking that the app answers.

**Change the staff PIN** (the demo PIN is `1234`). Restaurant settings live outside the repo, so real PINs never end up on GitHub:

```bash
sudo nano /etc/pager/branches.json
sudo systemctl restart pager
```

## 4. Connect your domain

```bash
sudo bash /opt/pager/deploy/azure/tunnel.sh order.yourdomain.com
```

It prints a Cloudflare link. Open it on your own computer, sign in and click your domain; the server continues by itself. It creates a tunnel called `pager-server` and points your address at it. If the address pointed at your laptop's tunnel before, that record is replaced.

When it says **Live**, open `https://order.yourdomain.com/qr/demo-cafe` and print the QR code.

Then on your laptop: stop the local server and `cloudflared` (they're no longer used). You can delete the old laptop tunnel with `cloudflared tunnel delete pager`.

This server makes its own push keys, so phones need to tap **Notify me** again (and iPhones re-add the Home Screen app). That's intended: the old keys were exposed on GitHub earlier.

## Auto-deploy

Push to `main` and within about a minute the server:

1. Fetches the new commit.
2. Runs `npm test` on it in a separate folder.
3. If the tests pass, switches the live app to it and restarts (a second or two of downtime). If they fail, it keeps the current version running and skips that commit until a newer one arrives.

## Everyday commands (on the server)

| What | Command |
|---|---|
| Is it running? | `systemctl status pager` |
| App log (live) | `journalctl -u pager -f` |
| What did auto-deploy do? | `journalctl -u pager-update -n 50` |
| Deploy right now | `sudo systemctl start pager-update` |
| Tunnel log | `journalctl -u pager-tunnel -n 50` |
| Restart the app | `sudo systemctl restart pager` |
| Edit settings | `sudo nano /etc/pager/pager.env` then restart |

## Where things are

| Path | What |
|---|---|
| `/opt/pager` | The code (a git checkout of this repo, kept up to date by auto-deploy) |
| `/etc/pager/pager.env` | Settings: address, contact email, port |
| `/etc/pager/branches.json` | Restaurants and staff PINs |
| `/var/lib/pager/data` | Orders and push keys. Back up `vapid.json`; never commit it |
| `/etc/cloudflared/` | Tunnel config and credentials |

The app listens only on `127.0.0.1`, so the only way in from the internet is through the tunnel. It runs as its own `pager` user and can write only to its data folder.

Running `setup.sh` again is safe: it updates everything and keeps your data, PINs and tunnel.
