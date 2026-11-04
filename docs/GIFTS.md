# Gift links

A gift link gives a friend one free Openjutsu Prime clip (Light, 480P, 5 seconds), rendered **in your browser, on your account**. Your Comfy key never leaves your browser and is never part of the link.

## Giving a gift

1. Open any project in your own copy of the app (`npm run dev`, on this machine).
2. Click the small gift icon next to **Share**.
3. Click **Create link** and send the link to a friend.

A link works once and lasts 24 hours. Creating one turns gifting on. Gifting turns itself off when no links are left.

**Keep a tab of the app open while a link is out.** That tab is what renders the gift. When a request arrives, it shows *"Gift has been accepted, adding to queue..."*, renders the clip, and sends it back. If no tab is open, your friend sees *"Gifter host is off, try another time."* and the link is not used up.

The gift icon turns lime while gifting is on. The window lists your links: waiting, delivered, or open again after a failed render. Revoke any of them there.

## What your friend does

The link opens the app (comfy-cinematic.ai.studio by default) straight into a project called **Openjutsu Prime**, and checks the link with your relay while it does. Once your relay confirms it, the project shows **FREE 1** and pins the gift's settings (Light, 480P, 5s). Your friend adds a clip and characters, optionally writes a prompt, and clicks **Generate clip**. They don't need an account. A link that can't be used still opens the project, with a comment saying why.

The gift is for Openjutsu Prime only. Picking another model works as in any project, on your friend's own account; picking Openjutsu Prime again brings the gift back.

Their tile fills like any render, with the FREE 1 badge, their place in your queue, and your live progress. When it is done, the clip lands on their canvas.

A render that fails gives the link back, so they can try again, up to three requests per link.

## How it works

```
friend's browser ──https──▶ Cloudflare quick tunnel ──▶ relay (127.0.0.1:3100)
                                                            ▲
your browser tab ──checks in every 4s── /api/gifting/inbox ─┘
       └── renders through your own /api/video, then hands the clip back
```

- **The relay** (`lib/gift-relay.ts`) is a small server inside your app, on its own port. It holds link hashes, the queue and status. It never sees a Comfy key, and it only serves `/gift/link`, `/gift/jobs`, `/gift/jobs/:id` and `/gift/jobs/:id/video`.
- **The tunnel** (`lib/gift-tunnel.ts`) is a Cloudflare quick tunnel (`cloudflared`), started with the relay and stopped with it. It exposes the relay only; your app on :3000 stays private.
- **Your tab** (`components/gift-host.tsx`) picks requests up and renders them with your account, as you would.
- **The routes your tab uses** (`/api/gifting/*`) answer only this machine. They refuse anything that came through the tunnel, any non-loopback host name, and other websites open in your browser.
- **The link** is `…/openjutsu-prime#gift=TOKEN&host=RELAY`. The part after `#` is never sent to any server, so ai.studio never sees the token. Only the token's SHA-256 is stored, in `.data/gift-links.json`.
- **The finished clip** goes to your friend straight from the relay. It is also put on [litterbox](https://litterbox.catbox.moe) for 24 hours as a fallback. Gifting stays on until your friend has collected the clip, or for at most 15 minutes.

## Setup

Install `cloudflared` once:

```
winget install Cloudflare.cloudflared
```

That is all. Nothing needs to be configured. These optional settings go in `.env.local`:

| Variable | Default | |
| --- | --- | --- |
| `GIFT_RELAY_PORT` | `3100` | The relay's port. |
| `GIFT_TUNNEL` | on | `off` starts no tunnel; links then work only on this machine. |
| `GIFT_RELAY_URL` | | A fixed public address for the relay, if you run your own tunnel. Turns the quick tunnel off. |
| `GIFT_FRONTEND_URL` | `https://comfy-cinematic.ai.studio` | The copy of the app friends open links in. |
| `CLOUDFLARED_PATH` | found automatically | Where `cloudflared` is, if not in the usual places. |
| `GIFT_LINKS_FILE` | `.data/gift-links.json` | Where link hashes are kept. |

The copy friends open (`GIFT_FRONTEND_URL`) must run this version of the app. Its security policy has to let the page call a gifter's tunnel.

## Limits

- A quick tunnel gets a new random address each time it starts. If you restart the app while links are out, those links stop working; make new ones. A fixed `GIFT_RELAY_URL` avoids this.
- One gift renders at a time per open tab, oldest request first.
- If your tab closes mid-render, the render still finishes on your app's server. The relay collects that result instead of rendering again.
