# Spare WhatsApp message bot

A Baileys (WhatsApp Web multi-device) bot that links as a companion device
to the **spare WhatsApp +923703832506** and sends plain-text trade alerts
to the recipients the dogar-alerts Worker queues (default: the main number
**+923001412943** only — pre-added, never needs to be added by hand). Fast
path is PUSH: the Worker POSTs each queued signal straight to this bot
(`POST /signal`), so WhatsApp delivery is ~1-2s. The queue poll below is
the fallback — no public IP or port forwarding is needed (Render gives
the bot a public URL and the Worker calls it).

## Host: Render (free) — primary; Termux — fallback

- **Render free web service** (see `render.yaml`): the only free service in
  that Render workspace (750 free instance hours/month; one service 24/7
  uses 720–744h). The Cloudflare Worker cron pings `/health` every 5 min
  so the free service never spins down from idleness.
- **Termux on the spare phone** stays as the fallback (same code, same env).

## Files

- `bot.js` — the bot (Node 20+)
- `package.json` — deps: `@whiskeysockets/baileys` **6.7.24** (stable line),
  `qrcode-terminal`, `pino`
- `render.yaml` — Render Blueprint (free web service, `/health` check)
- `run-bot.sh` — Termux starter (reads the token from `.spare-token`)

## How alerts flow (v2.6 — push, poll as fallback)

TradingView alert -> dogar-alerts Worker -> Discord (unchanged) + KV queue
(`wa`) -> **Worker PUSHES the queued item to this bot (`POST /signal`,
SPARE_TOKEN, 5s timeout) -> WhatsApp message to each queued recipient
in ~1-2s** -> bot acks the item so the poll skips it.

Fallback: the bot ALSO polls `/spare-pending?queue=wa` every `POLL_SECONDS`
(5s on Render) — a push that fails, a signal queued while the bot is
down, or a push held while the bot is paused still arrives on the next
poll (~5s). The push and the poll send through the SAME function, so
validation, the 30/day cap, the 1-hour dedup and the 3s gap behave
identically on both paths — a pushed duplicate of an already-sent queue
id is never sent twice. The push handler answers AFTER the send, so the
Worker measures the true delivery time from the round trip.

Measured delay (live, after the v2.6 Render deploy): _pending — fill in
from the first TEST webhook after deploy_ (target: webhook POST to
WhatsApp send ≤ 3s). Fallback poll at 5s costs ~2 Worker requests per
poll cycle (queue + command check) ≈ 35k requests/day and ≈ 35k KV
reads/day — inside the 100k/day free budget for both. Do NOT poll faster
than 5s: the gain is under a second and the KV read budget halves.

SINGLE-ALERT RULE (2026-11-11): only ONE alert per signal is ever queued —
the entry confirmation ("🟢/🔴 BUY/SELL SIGNAL - Detected", with SL, TP,
Entry, CLICK HERE chart link, warning, session/time/score, trend/structure).
Opposition, TP/SL and result alerts do not exist any more: the Pine file
sends only the entry alert, and the Worker DROPS anything else before it
can reach this queue.

## Auth (session) — stored in Cloudflare KV, not on disk

On start the bot loads its Baileys session from the Worker
(`GET /spare-auth`) and saves it back on every `creds.update`
(`POST /spare-auth`). A Render restart/redeploy therefore never needs a
re-link. If WhatsApp ever logs the session out, the bot clears the KV auth
and stops — link again (pairing code below) to resume.

## Safety (built in, do not relax)

- Recipients come ONLY from Worker queue items (set by the admin in the
  control panel at `https://dogar-alerts.abdulrahman-dogar.workers.dev/panel`).
  Each must be 10–15 digits; anything else is refused.
- Plain text only. Links are stripped EXCEPT the TradingView chart link
  (CLICK HERE), which is kept as a plain URL — WhatsApp auto-links it.
  Max 500 chars, >= 3s between sends, max 30 messages per UTC day.
- Reconnects use exponential backoff (5s -> 60s max), never a tight loop.
- Dedup: an alert id sent once is never sent again within 1 hour, even if
  Cloudflare KV briefly re-lists it after the ack (KV reads are eventually
  consistent — verified live during testing).
- Warm-up: after linking, send ONE test alert first, confirm it arrives,
  then let real alerts flow. Real volume is a few messages per day.

## Link the bot (once)

**Primary — scan the QR on the control panel** (`/panel`, "Link sending
number" section): the bot posts its QR there automatically. On the phone
that holds the spare WhatsApp (+923703832506): WhatsApp -> Settings ->
Linked Devices -> Link a Device -> scan the QR. The QR refreshes itself
while unlinked.

- **Pairing code (same thing, second method — v2.5):** the bot requests
  an 8-digit code in BOTH modes and shows it on the panel next to the QR
  (big digits + Copy button). Same phone: WhatsApp -> Settings -> Linked
  Devices -> Link a Device -> **Link with phone number instead** -> enter
  the code. Use the code when a QR scan fails ("COULDN'T LOGIN") — a QR
  expires after ~20s and the panel can show a stale one; the code is the
  reliable method. "Get a fresh code" on the panel forces a new code
  (1/min). A fresh code is requested at most once a minute until linked,
  and a socket restart resets the throttle so a dead code is replaced.
  (`LINK_MODE=code` still exists but only suppresses the terminal QR
  print — it no longer gates the code.)
- **Termux:** `bash run-bot.sh` — a QR appears in Termux (and on the
  panel too). Same phone: WhatsApp -> Settings -> Linked Devices ->
  Link a Device -> scan the QR.

After linking, the session is saved in Cloudflare KV — the bot stays linked
across restarts and redeploys. If the sending number ever goes down, the
Worker posts a "sending number down" alert to Discord and the panel shows
a fresh QR to re-link. To unlink any time: spare WhatsApp ->
Linked Devices -> remove it (then the bot will clear KV auth and stop).

## Test

- `npm run self-test` — unit test: link stripping, recipient guard,
  KV auth serialization round-trip, dedup, bot commands, pushed-signal
  shape (`isValidSignalItem`).
- `npm run dry-run` — poll the live queue and log what WOULD be sent
  (sends nothing, acks nothing). Needs `SPARE_TOKEN` in env.
- Live test (after linking): press TEST in the control panel; the spare
  WhatsApp must deliver it to the main number within ~3s (push path;
  ~5s worst case on the poll fallback).

## Logs / troubleshooting

- Render: service Logs tab. Termux: `bot.log` in this folder.
- `WhatsApp disconnected` + backoff = no internet or WhatsApp hiccup; the
  bot retries on its own and queued alerts wait (nothing is lost).
- `LOGGED OUT` = the session died; KV auth was cleared, link again.
- `daily cap reached` = 30 messages sent today (should never happen at
  real alert volume); it resets at UTC midnight.
- `queue: N pending` + `WhatsApp not connected` = alerts are waiting for
  the WhatsApp link to come back; they send once it reconnects.
- `KV auth save failed` = the Worker could not be reached; the bot keeps
  running with the in-memory session and retries on the next update. If
  the bot restarts before a save succeeds, it may need a fresh link.

## Bot tab controls (v2.2)

The control panel has a Bot tab (🤖 Bot in the side menu). It shows the
bot's live status (linked number, last seen, Render health) and these
controls — all from the panel, no Render login needed:

- **MANUAL PING** — the Worker GETs the Render service right now (the same
  check as the 5-minute cron) and shows HTTP status + ms.
- **RECONNECT** — closes the WhatsApp socket and reconnects at once.
  The saved session is kept, so no re-link is needed.
- **RESTART** — the bot exits and Render restarts the service.
- **STOP / RESUME** — STOP pauses sending (alerts stay queued); the bot
  keeps heartbeating with state "paused", so no "down" alert fires.
  RESUME unpauses it.
- **Get a fresh code (Link tab, v2.5)** — forces an immediate fresh
  pairing-code request (bypasses the 60s throttle once). 1/min.
- **Refresh QR (Link tab, v2.5)** — reconnects the socket so Baileys
  makes a brand-new QR for the panel. 1/min.

How it works: the panel writes a command to the Worker's KV command
channel (`POST /panel/api/bot-command`); the bot checks for a pending
command on every poll (`GET /spare-command`, every 5s on Render) and acks it
(`POST /spare-command {ack, result}`) after executing. In `DRY_RUN`
commands are only simulated (acked, no state change).
