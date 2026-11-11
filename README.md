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

## How alerts flow (v2.7 — push, poll as fallback)

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

Measured delay (dry-run, 2026-11-11 — NO live test send was made, the
user has stopped all test sends): webhook POST -> Worker response in
**36ms**, Worker push round trip to the bot **27ms** (local dry-run bot,
`DRY_RUN=1`, localhost). The real Baileys send time on the live bot is
NOT in that number — the true end-to-end delay (webhook -> WhatsApp
delivered) can only be measured on a live test, which needs the user's
approval first. Target stays ≤ 3s. Fallback poll at 5s costs ~2 Worker
requests per poll cycle (queue + command check) ≈ 35k requests/day and
≈ 35k KV reads/day — inside the 100k/day free budget for both. Do NOT
poll faster than 5s: the gain is under a second and the KV read budget
halves.

## Delivery delay line (v2.7)

Every WhatsApp signal message ends with a line showing how fast it was
delivered, e.g. `⚡ Delivered in 2.4s` — measured honestly from the
moment the Worker receives the TradingView webhook (`receivedAt`, carried
in the queued item and the pushed payload) to the moment the bot sends
the message. One decimal place, never faked. The bot fills it in at send
time (`formatDelay` / `applyDelayToken` in `bot.js`, unit-tested): a
`<delay>` token in the message is replaced in place; if the message has
no `<delay>` (the hard-coded fallback format), the line is appended at
the end. The same delay is also shown in the Discord embed footer
(Worker-side, after the push returns).

## Message format (v2.7 — set in the panel, not in code)

The control panel has a **Message Format** tab: the user writes the
WhatsApp format himself with `<tokens>`, with a live preview (sample BUY
signal) and Save / Reset-to-default. The Worker renders the saved
template per signal (`parseSignalFields` + `renderMessageTemplate` in
the Worker; unknown tokens are left as-is, a bad template never crashes
the alert path). No saved template = the current hard-coded format.
Discord embeds are NOT templated (only the delay footer is added).

Tokens (all from fields the Worker already parses from the webhook
embed):

| Token | Meaning |
|---|---|
| `<signal>` | Direction with its dot: 🟢 BUY or 🔴 SELL |
| `<flag>` | 🚩 when the signal is flagged, otherwise empty |
| `<star>` | ⭐ when the signal is starred, otherwise empty |
| `<sl>` | Stop-loss price |
| `<tp>` | Take-profit price (1:1.2 target) |
| `<entry>` | Entry price |
| `<chart>` | TradingView XAUUSD 1m chart link |
| `<session>` | Trading session, e.g. New York |
| `<time>` | Signal time |
| `<bull>` | Bull score |
| `<bear>` | Bear score |
| `<trend>` | Overall trend, e.g. BULLISH ▲ |
| `<structure>` | Overall structure, e.g. BULLISH ▲ |
| `<warning>` | The "check the authority of the signal" warning text |
| `<delay>` | Delivery delay, e.g. 2.4s (filled in when the message is sent) |

Default template (reproduces the current message exactly, plus the
delay line at the end):

```
<signal> SIGNAL - Detected<flag><star>
📉 SL <sl>
📈 TP <tp>
👑 Entry <entry>
CLICK HERE: <chart>
⚠️ <warning>
> <session> > <time> > Bull <bull> / Bear <bear>
- <trend> > <structure>
⚡ Delivered in <delay>
```

## Durable dedup (v2.7)

The bot's 1-hour dedup file (`sent-ids.json`) lives on Render's ephemeral
disk — a restart in the window between a successful send and its KV ack
could wipe it and re-send the item. The Worker now keeps the same
markers durably in KV (`spare:sent-markers`, written on ack, pruned to
1h): an acked queue id is never listed again, even after a bot restart.
The bot's local dedup stays as the fast path; the KV markers are the
backstop. `readPending` only reads the marker map when the queue index
is non-empty, so empty polls cost no extra KV read.

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
  consistent — verified live during testing). The Worker also keeps the
  same markers durably in KV (`spare:sent-markers`), so a Render restart
  can never re-send an acked item (v2.7).
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
  shape (`isValidSignalItem`), delivery-delay helpers (`formatDelay` /
  `applyDelayToken`).
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
