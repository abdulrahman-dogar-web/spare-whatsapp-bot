# Spare WhatsApp message bot

A Baileys (WhatsApp Web multi-device) bot that links as a companion device
to the **spare WhatsApp +923703832506** and sends plain-text trade alerts
to the recipients the dogar-alerts Worker queues (default: the main number
**+923001412943** only — pre-added, never needs to be added by hand). It
polls the Worker queue — the Worker never pushes to the bot, so no public
IP or port forwarding is needed.

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

## How alerts flow

TradingView alert -> dogar-alerts Worker -> Discord (unchanged) + KV queue
(`wa`) -> this bot polls `/spare-pending?queue=wa` every 10s -> WhatsApp
message to each queued recipient -> bot acks the item.

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

- **Render (pairing-code mode):** set `LINK_MODE=code` in the Render env
  vars. The 8-digit code appears in the Render logs. On the phone that
  holds the spare WhatsApp (+923703832506): WhatsApp -> Settings -> Linked
  Devices -> Link a Device -> **Link with phone number instead** -> enter
  the code. (A fresh code is requested at most once a minute until linked.)
- **QR mode:** `bash run-bot.sh` — a QR appears in Termux. Same phone:
  WhatsApp -> Settings -> Linked Devices -> Link a Device -> scan the QR.

After linking, the session is saved in Cloudflare KV — the bot stays linked
across restarts and redeploys. To unlink any time: spare WhatsApp ->
Linked Devices -> remove it (then the bot will clear KV auth and stop).

## Test

- `npm run self-test` — unit test: link stripping, recipient guard,
  KV auth serialization round-trip, dedup.
- `npm run dry-run` — poll the live queue and log what WOULD be sent
  (sends nothing, acks nothing). Needs `SPARE_TOKEN` in env.
- Live test (after linking): press TEST in the control panel; the spare
  WhatsApp must deliver it to the main number within ~15s.

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
