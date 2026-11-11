/**
 * spare-whatsapp-bot — Baileys bot for Dogar Alpha Elite trade alerts.
 *
 * Links as a companion device to the SPARE WhatsApp account (+923703832506)
 * and sends plain-text alert messages to the recipients the Worker queues
 * (default: the main number +923001412943 only).
 * Delivery (v2.6): the Worker PUSHES each queued signal straight to this
 * bot (POST /signal) so it sends in ~1-2s; the bot ALSO polls the Worker
 * queue (Cloudflare KV) every POLL_SECONDS as the fallback — a push that
 * fails, or a signal queued while the bot is down, still arrives on the
 * next poll. No public IP / port forwarding is needed (Render gives the
 * bot a public URL and the Worker calls it).
 *
 * HOST: Render free web service (primary). Termux on the spare phone is the
 * fallback (see ../spare-call/SETUP-TERMUX.md).
 *   $ node bot.js            # QR link mode (default; QR also shown on the
 *                           # control panel — scan from spare WhatsApp)
 *   $ LINK_MODE=code node bot.js   # same, but no terminal QR print
 *                           # (the pairing code is posted in BOTH modes
 *                           # since v2.5 — LINK_MODE no longer gates it)
 *   $ DRY_RUN=1 node bot.js  # poll + log only, never send, never ack
 *
 * LINKING (v2.5): the bot posts its link QR (PNG data URL) AND a pairing
 * code to the Worker (/spare-link) so the control panel shows BOTH — the
 * user scans the QR or enters the code on the spare WhatsApp. The code
 * is requested (max once a minute) whenever the socket is unregistered;
 * a socket restart resets the throttle so a dead code is replaced right
 * away. The QR expires after ~20s, which is why a stale panel QR can
 * fail with "COULDN'T LOGIN" — the code is the reliable second method.
 * It also posts a status heartbeat (/spare-status) every 60s and on every
 * change, so the Worker can tell the user on Discord if the sending
 * number goes down.
 *
 * BOT TAB COMMANDS (v2.2 + v2.5): the panel's Bot tab sends commands
 * through a KV command channel on the Worker (GET/POST /spare-command,
 * same token). The bot checks for a pending command on every poll
 * and acks it after executing: RECONNECT closes the socket and
 * reconnects at once (session kept — no re-link); RESTART exits so
 * Render restarts the service; STOP pauses sending (alerts stay queued)
 * while the bot keeps heartbeating with state "paused" (so the Worker's
 * down-detection does not fire); RESUME unpauses. MANUAL PING is
 * Worker-side (no bot involvement). v2.5 adds: PAIRING-CODE (panel "Get
 * a fresh code" — forces an immediate fresh code request, bypassing
 * the 60s throttle once) and REFRESH-QR (reconnects the socket so
 * Baileys makes a brand-new QR for the panel).
 *
 * Env:
 *   WORKER_URL    default https://dogar-alerts.abdulrahman-dogar.workers.dev
 *   SPARE_TOKEN   required — the SPARE_BOT_TOKEN Worker secret
 *   POLL_SECONDS  default 10 (Render sets 5 — fallback poll only; the
 *                 push path is what makes delivery fast)
 *   LINK_MODE     qr | code   (default qr)
 *   SPARE_PHONE   digits-only number of the spare WhatsApp account
 *                 (default 923703832506) — used ONLY for the pairing code
 *   DRY_RUN       1 = log what would be sent, send nothing, ack nothing
 *   PORT          default 3000 — the /health HTTP server (Render needs it)
 *
 * Auth: the Baileys session lives in Cloudflare KV through the Worker
 * (/spare-auth), NOT on local disk — so a Render restart/redeploy never
 * needs a QR/pairing-code re-link. On LOGGED OUT the KV auth is cleared.
 *
 * Safety (hard rules, do not relax):
 *   - Recipients come ONLY from Worker queue items (set by the admin in
 *     the control panel). The bot never sends to an arbitrary number.
 *     Each recipient must be 10-15 digits; anything else is refused.
 *   - Plain text only, links stripped, max 500 chars per message.
 *   - >= 3 seconds between sends; max 30 messages per UTC day.
 *   - Reconnects use exponential backoff (5s -> 60s max), never a tight loop.
 *   - Dedup: an alert id sent once is never sent again within 1 hour, even
 *     if Cloudflare KV briefly re-lists it after the ack (KV reads are
 *     eventually consistent).
 *   - Alerts are a few per day; the queue is the only input (no other
 *     triggers, no groups, no replies, no incoming-message handling).
 */

const {
  default: makeWASocket,
  initAuthCreds,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode"); // PNG data URLs for the panel's QR section
const pino = require("pino");
const http = require("http");
const fs = require("fs");
const path = require("path");

const MAIN_NUMBER = "923001412943"; // main number — default recipient
const SPARE_PHONE = (process.env.SPARE_PHONE || "923703832506").replace(/\D/g, "");
const WORKER_URL = (process.env.WORKER_URL ||
  "https://dogar-alerts.abdulrahman-dogar.workers.dev").replace(/\/$/, "");
const SPARE_TOKEN = process.env.SPARE_TOKEN || "";
const POLL_MS = Math.max(5, parseInt(process.env.POLL_SECONDS || "10", 10)) * 1000;
const LINK_MODE = (process.env.LINK_MODE || "qr").toLowerCase();
const DRY_RUN = process.env.DRY_RUN === "1";
const PORT = parseInt(process.env.PORT || "3000", 10);
const SEND_GAP_MS = 3000;
const DAILY_CAP = 30;
const COUNT_FILE = path.join(__dirname, "sent-count.json");
const SENT_IDS_FILE = path.join(__dirname, "sent-ids.json");
const DEDUP_WINDOW_MS = 60 * 60 * 1000; // never send the same queue id twice within 1h
const MAX_RECONNECT_DELAY_MS = 60000;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, "bot.log"), line + "\n");
  } catch (e) {
    /* logging must never crash the bot (on Render the disk is ephemeral) */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- pure helpers (exported for the self-test) ----
function stripLinks(text) {
  // Keep the TradingView chart link (the only sanctioned URL — the user
  // asked for CLICK HERE as a plain link in the WhatsApp alert); strip
  // every other URL so nothing spammy-looking is ever sent. Line breaks
  // are kept so the multi-line alert format stays readable.
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, (url) =>
      url.includes("tradingview.com/chart") ? url : ""
    )
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .slice(0, 500);
}

// Recipient guard: the number must come from a Worker queue item (the admin
// sets recipients in the control panel) and must be 10-15 digits. Anything
// else is refused — the bot never sends to an arbitrary number.
function assertQueuedJid(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(digits)) {
    throw new Error("refusing to send to invalid recipient: " + String(number).slice(0, 30));
  }
  return digits + "@s.whatsapp.net";
}

// Pushed-signal shape (v2.6): the Worker POSTs the queued item itself to
// /signal — {id, kind, text, to} plus the SPARE_TOKEN. The token is
// checked separately (401), so this only validates the item shape.
// Exported for the self-test.
function isValidSignalItem(item) {
  return !!item && typeof item === "object" &&
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.text === "string" && item.text.length > 0 &&
    (item.to === undefined || typeof item.to === "string") &&
    (item.kind === undefined || typeof item.kind === "string");
}

// ---- Baileys auth in Cloudflare KV (via the Worker /spare-auth) ----
// Buffers do not survive a plain JSON round-trip, so convert every
// Uint8Array/Buffer to {__b64} before storing and back on load.
function toStorable(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { __b64: Buffer.from(v).toString("base64") };
  }
  if (Array.isArray(v)) return v.map(toStorable);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = toStorable(v[k]);
    return o;
  }
  return v;
}

function fromStorable(v) {
  if (Array.isArray(v)) return v.map(fromStorable);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.__b64 === "string") {
      return Buffer.from(v.__b64, "base64");
    }
    const o = {};
    for (const k of keys) o[k] = fromStorable(v[k]);
    return o;
  }
  return v;
}

async function loadKvAuth() {
  const url = `${WORKER_URL}/spare-auth?token=${encodeURIComponent(SPARE_TOKEN)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("spare-auth GET HTTP " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error("spare-auth error: " + (data.error || "?"));
  if (!data.found || !data.creds) return null;
  return { creds: fromStorable(data.creds), keys: fromStorable(data.keys || {}) };
}

async function saveKvAuth(creds, keysObj) {
  const body = JSON.stringify({ token: SPARE_TOKEN, creds: toStorable(creds), keys: toStorable(keysObj) });
  const res = await fetch(`${WORKER_URL}/spare-auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error("spare-auth save failed: HTTP " + res.status);
  return data;
}

async function clearKvAuth() {
  try {
    await fetch(`${WORKER_URL}/spare-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SPARE_TOKEN, clear: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    /* clearing is best-effort */
  }
}

// In-memory SignalKeyStore backed by a plain object (persisted wholesale).
function makeKvKeyStore(keysObj) {
  return {
    get: async (type, ids) => {
      const out = {};
      const store = keysObj[type] || {};
      for (const id of ids) {
        if (store[id]) out[id] = store[id];
      }
      return out;
    },
    set: async (data) => {
      for (const type of Object.keys(data)) {
        keysObj[type] = { ...(keysObj[type] || {}), ...data[type] };
      }
    },
  };
}

function readCount() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNT_FILE, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    if (data.date === today) return data.count || 0;
    return 0;
  } catch (e) {
    return 0;
  }
}

function writeCount(n) {
  try {
    fs.writeFileSync(
      COUNT_FILE,
      JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: n })
    );
  } catch (e) {
    /* non-fatal (ephemeral disk on Render) */
  }
}

// Idempotency guard: KV reads are eventually consistent, so an acked item
// can briefly reappear in a later poll. Never send the same queue id twice
// within the dedup window, even if the Worker still lists it as pending.
function readSentIds() {
  try {
    const data = JSON.parse(fs.readFileSync(SENT_IDS_FILE, "utf-8"));
    if (data && typeof data === "object") return data;
    return {};
  } catch (e) {
    return {};
  }
}

function isRecentlySent(id) {
  const all = readSentIds();
  const ts = all[id];
  return typeof ts === "number" && Date.now() - ts < DEDUP_WINDOW_MS;
}

function markSent(id) {
  try {
    const all = readSentIds();
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const k of Object.keys(all)) {
      if (all[k] < cutoff) delete all[k];
    }
    all[id] = Date.now();
    fs.writeFileSync(SENT_IDS_FILE, JSON.stringify(all));
  } catch (e) {
    /* non-fatal */
  }
}

async function fetchPending() {
  const url = `${WORKER_URL}/spare-pending?queue=wa&token=${encodeURIComponent(SPARE_TOKEN)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("pending HTTP " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error("pending error: " + (data.error || "?"));
  return data.items || [];
}

async function ackItems(ids) {
  const res = await fetch(`${WORKER_URL}/spare-ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SPARE_TOKEN, queue: "wa", ids }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

// ---- Panel link + status reporting (v2.1) ----
// The control panel shows the link QR / pairing code and the live status,
// so the user never has to dig through Render logs. Best-effort: a failed
// post is logged and never crashes the bot or blocks alerts.
async function postLink(link) {
  try {
    const res = await fetch(`${WORKER_URL}/spare-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SPARE_TOKEN, qrDataUrl: link.qrDataUrl || null, code: link.code || null }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) log("spare-link post failed: HTTP " + res.status);
  } catch (e) {
    log("spare-link post failed: " + String((e && e.message) || e).slice(0, 100));
  }
}

async function postStatus(status, ownNumber) {
  try {
    const res = await fetch(`${WORKER_URL}/spare-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: SPARE_TOKEN, status, ownNumber: ownNumber || null }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) log("spare-status post failed: HTTP " + res.status);
  } catch (e) {
    log("spare-status post failed: " + String((e && e.message) || e).slice(0, 100));
  }
}

// Own number as plain digits (Baileys id looks like "923703832506:12@s.whatsapp.net").
function ownNumberDigits(sock) {
  try {
    const id = sock && sock.user ? String(sock.user.id || "") : "";
    const m = id.match(/^(\d{10,15})/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// ---- Bot command channel (v2.2) ----
// The panel's Bot tab writes commands to the Worker (KV panel:bot-command);
// the bot reads them here on every poll loop and acks each after executing.
// Exported for the self-test / verification script (same code main() uses).
const BOT_COMMANDS = ["ping", "reconnect", "restart", "stop", "resume", "pairing-code", "refresh-qr"];
function isValidBotCommand(action) {
  return BOT_COMMANDS.includes(String(action || "").trim().toLowerCase());
}

async function fetchBotCommand() {
  const res = await fetch(`${WORKER_URL}/spare-command?token=${encodeURIComponent(SPARE_TOKEN)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("spare-command GET HTTP " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error("spare-command error: " + (data.error || "?"));
  return { pending: data.pending || null, last: data.last || null };
}

async function ackBotCommand(id, result) {
  const res = await fetch(`${WORKER_URL}/spare-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SPARE_TOKEN, ack: id, result: String(result || "").slice(0, 200) }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error("spare-command ack failed: HTTP " + res.status);
  return data;
}

async function main() {
  if (!SPARE_TOKEN) {
    console.error("ERROR: SPARE_TOKEN env is required (the SPARE_BOT_TOKEN Worker secret).");
    process.exit(2);
  }
  log(`starting spare-whatsapp-bot (dry_run=${DRY_RUN} link=${LINK_MODE} poll=${POLL_MS}ms)`);
  log(`spare account ${SPARE_PHONE}; recipients come from the Worker queue only`);

  // Load the Baileys session from Cloudflare KV (or start fresh).
  let loaded = null;
  try {
    loaded = await loadKvAuth();
    log(loaded ? "auth loaded from Cloudflare KV (no re-link needed)" : "no saved auth in KV — fresh link needed");
  } catch (e) {
    log("KV auth load failed (" + String((e && e.message) || e).slice(0, 100) + ") — starting fresh, will retry saves");
  }
  const creds = loaded ? loaded.creds : initAuthCreds();
  const keysObj = loaded ? loaded.keys : {};
  const keys = makeKvKeyStore(keysObj);

  let saveTimer = null;
  let savePending = false;
  function saveCreds() {
    // Debounce: Baileys can fire creds.update in bursts during link/sync.
    savePending = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!savePending) return;
      savePending = false;
      try {
        await saveKvAuth(creds, keysObj);
      } catch (e) {
        log("KV auth save failed (will retry on next update): " + String((e && e.message) || e).slice(0, 100));
        savePending = true;
      }
    }, 800);
  }

  let sock = null;
  let connected = false;
  let pairingCodeShownAt = 0;
  let sentToday = readCount();
  let reconnectAttempts = 0;
  // Bot tab command state (v2.2): paused = STOP pressed (sending halted,
  // heartbeats continue with state "paused"); manualReconnect = the panel
  // asked for a RECONNECT (close the socket and reconnect at once, no
  // backoff); lastCommandId = last command id seen (retried until acked).
  let paused = false;
  let manualReconnect = false;
  let lastCommandId = null;
  // Panel link/status state (v2.1): last QR + code posted, last status posted.
  let lastLink = { qrDataUrl: null, code: null };
  let currentStatus = "connecting";

  // Request a fresh pairing code (v2.5): posted to /spare-link ALONGSIDE
  // the QR. `force` (panel "Get a fresh code") bypasses the 60s throttle
  // once. Returns {ok, code} or {ok:false, reason}. Never throws.
  async function requestPairingCodeNow(force) {
    if (!sock || !sock.authState || !sock.authState.creds || sock.authState.creds.registered) {
      return { ok: false, reason: "already registered" };
    }
    if (!force && Date.now() - pairingCodeShownAt <= 60000) {
      return { ok: false, reason: "throttled (max once a minute)" };
    }
    try {
      pairingCodeShownAt = Date.now();
      const code = await sock.requestPairingCode(SPARE_PHONE);
      lastLink = { qrDataUrl: lastLink.qrDataUrl, code };
      await postLink(lastLink);
      log("PAIRING CODE (enter in spare WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead): " + code);
      return { ok: true, code };
    } catch (e) {
      log("pairing code request failed: " + String((e && e.message) || e).slice(0, 120));
      return { ok: false, reason: String((e && e.message) || e).slice(0, 80) };
    }
  }

  // /health server — Render requires the service to bind $PORT, and the
  // Worker's cron keep-alive pings this endpoint every 5 minutes.
  // POST /signal (v2.6 PUSH): the Worker pushes a queued signal straight
  // here (auth: SPARE_TOKEN, same scheme as the /spare-* endpoints) so it
  // sends in ~1-2s instead of waiting for the poll. The pushed item is the
  // same shape as a queue item ({id, kind, text, to}); it goes through
  // the SAME send path as the poll loop (validation, caps, dedup, 3s
  // gap) — a pushed duplicate of an already-sent queue id is never sent
  // twice. On success the item is acked so the poll loop skips it.
  // The handler awaits the send, so the Worker measures the true
  // delivery time from the round trip.
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bot: "spare-whatsapp-bot", connected, paused, state: paused ? "paused" : (connected ? "linked" : currentStatus), sent_today: sentToday, ts: Date.now() }));
    } else if (req.url === "/signal" && req.method === "POST") {
      handlePushSignal(req, res);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(PORT, "0.0.0.0", () => log("health server on :" + PORT));

  // POST /signal handler (v2.6). A pushed item that fails validation
  // gets 400, a bad token 401. A "retry" outcome (not connected, cap
  // reached, send failed) still answers 200 — the item stays queued and
  // the poll loop delivers it, so the push is never a single point of
  // failure. A paused bot holds the push (200, "paused_held") and the
  // queue delivers it on resume.
  async function handlePushSignal(req, res) {
    const started = Date.now();
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", async () => {
      let item = null;
      try { item = JSON.parse(body || "{}"); } catch (e) { item = null; }
      if (!isValidSignalItem(item)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_payload" }));
        return;
      }
      if (String(item.token || "") !== SPARE_TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_token" }));
        return;
      }
      if (paused) {
        log(`push ${item.id} held — bot paused (stays queued)`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: "paused_held", ms: Date.now() - started }));
        return;
      }
      const r = await sendQueuedItemLocked(item);
      const ms = Date.now() - started;
      if (r.action === "sent" || r.action === "drop") {
        // Sent (or a duplicate/invalid item that must not retry): ack it
        // so the poll loop never sends it again. If the ack itself fails,
        // the 1h dedup still stops a double send.
        if (!DRY_RUN) {
          try { await ackItems([item.id]); } catch (e) { /* dedup covers it */ }
        }
        log(`push ${item.id} ${r.action} in ${ms}ms`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: r.action, ms }));
      } else if (r.action === "dryrun") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: "dryrun", ms }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: "retry_" + r.reason, ms }));
      }
    });
  }

  function connect() {
    sock = makeWASocket({
      auth: { creds, keys },
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false, // we render the QR ourselves from the qr event
      logger: pino({ level: "error" }), // keep Baileys' own log noise out
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Post the QR to the panel in BOTH modes (the panel QR is the
        // primary link method; the pairing code is shown next to it).
        try {
          const dataUrl = await QRCode.toDataURL(qr, { width: 512, margin: 1 });
          lastLink = { qrDataUrl: dataUrl, code: lastLink.code || null };
          await postLink(lastLink);
        } catch (e) {
          log("QR render/post failed: " + String((e && e.message) || e).slice(0, 100));
        }
        // Pairing code (v2.5): requested in BOTH modes, next to the QR —
        // the user asked for both login methods at once. Throttled to
        // once a minute; a socket restart resets the throttle so a dead
        // code is replaced right away (see the close handler).
        await requestPairingCodeNow(false);
        if (LINK_MODE === "code") {
          log("PAIRING CODE mode — the code is also on the control panel");
        } else {
          log("QR LINK — scan with the SPARE WhatsApp (+923703832506): Settings > Linked Devices > Link a Device (or scan the QR on the control panel)");
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === "open") {
        connected = true;
        reconnectAttempts = 0;
        currentStatus = "linked";
        log("WhatsApp connected as " + (sock.user ? sock.user.id : "?"));
        await postStatus("linked", ownNumberDigits(sock));
        // Linked now: the panel no longer needs the QR/code.
        lastLink = { qrDataUrl: null, code: null };
        await postLink(lastLink);
        saveCreds(); // persist the fresh session right away
      }
      if (connection === "close") {
        connected = false;
        const reason =
          lastDisconnect && lastDisconnect.error
            ? lastDisconnect.error.output
              ? lastDisconnect.error.output.statusCode
              : String(lastDisconnect.error).slice(0, 80)
            : "?";
        log("WhatsApp disconnected, reason=" + reason);
        const loggedOut =
          lastDisconnect &&
          lastDisconnect.error &&
          lastDisconnect.error.output &&
          lastDisconnect.error.output.statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          currentStatus = "logged_out";
          log("LOGGED OUT — clearing KV auth and stopping (link again to resume).");
          await postStatus("logged_out", ownNumberDigits(sock));
          await clearKvAuth();
          process.exit(3);
        }
        currentStatus = "disconnected";
        await postStatus("disconnected", ownNumberDigits(sock));
        // v2.5: a socket restart invalidates the pairing code — reset the
        // throttle so the next qr event requests a fresh one right away.
        pairingCodeShownAt = 0;
        // Exponential backoff (5s -> 10s -> 20s -> 40s -> 60s max): a dead
        // socket must not hammer WhatsApp with constant reconnects.
        // A panel RECONNECT skips the backoff and reconnects at once.
        reconnectAttempts++;
        const delay = manualReconnect
          ? 0
          : Math.min(
            MAX_RECONNECT_DELAY_MS,
            5000 * Math.pow(2, reconnectAttempts - 1)
          );
        manualReconnect = false;
        log(`reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        await sleep(delay);
        connect();
      }
    });
  }

  connect();

  // Bot tab commands (v2.2): the panel writes them to the Worker's KV
  // command channel; this checks for a pending command on every poll loop
  // and acks it after executing. The id is marked seen only after the ack
  // succeeds, so a failed ack is retried on the next poll (every action
  // here is idempotent: stop/resume twice is harmless, and a restart
  // exits the process, so it cannot double-run).
  async function processCommand(cmd) {
    const action = String(cmd.action || "").trim().toLowerCase();
    if (DRY_RUN) {
      await ackBotCommand(cmd.id, `dry-run: ${action} simulated`);
      log(`command ${action} (dry-run: simulated, no state change)`);
      return;
    }
    if (action === "restart") {
      // Ack first (the process is about to exit and could not ack after).
      await ackBotCommand(cmd.id, "restarting — Render will restart the service");
      log("restart command: exiting in 500ms so Render restarts the service");
      setTimeout(() => process.exit(0), 500);
      return;
    }
    let result;
    if (action === "reconnect") {
      if (!connected || !sock) {
        result = "already reconnecting (not connected)";
      } else {
        manualReconnect = true;
        try {
          sock.end(); // close event fires; the handler reconnects at once
          result = "reconnecting — socket closed, reconnecting immediately (session kept)";
        } catch (e) {
          manualReconnect = false;
          result = "reconnect failed: " + String((e && e.message) || e).slice(0, 80);
        }
      }
    } else if (action === "stop") {
      paused = true;
      await postStatus("paused", ownNumberDigits(sock));
      result = "paused — sending stopped, alerts stay queued";
    } else if (action === "resume") {
      paused = false;
      await postStatus(currentStatus, ownNumberDigits(sock));
      result = "resumed — sending live again";
    } else if (action === "pairing-code") {
      // v2.5: panel "Get a fresh code" — force an immediate fresh code
      // request, bypassing the 60s throttle once. The code is posted to
      // /spare-link and shows in the panel's Link tab.
      const r = await requestPairingCodeNow(true);
      result = r.ok
        ? "fresh pairing code posted to the panel: " + r.code
        : "pairing code not requested: " + r.reason;
    } else if (action === "refresh-qr") {
      // v2.5: panel "Refresh QR" — reconnect the socket so Baileys makes
      // a brand-new QR (same as RECONNECT; the close handler resets the
      // pairing-code throttle, so a fresh code comes with it).
      if (!connected || !sock) {
        result = "already reconnecting (not connected) — a fresh QR will appear shortly";
      } else {
        manualReconnect = true;
        try {
          sock.end(); // close event fires; the handler reconnects at once
          result = "refreshing QR — socket closed, reconnecting now; a fresh QR will appear on the panel in a few seconds";
        } catch (e) {
          manualReconnect = false;
          result = "QR refresh failed: " + String((e && e.message) || e).slice(0, 80);
        }
      }
    } else {
      result = "unknown action ignored: " + action;
    }
    await ackBotCommand(cmd.id, result);
    log(`command ${action} done: ${result}`);
  }

  async function checkCommand() {
    try {
      const { pending } = await fetchBotCommand();
      if (!pending || pending.id === lastCommandId) return;
      log(`command received: ${pending.action} (id ${pending.id})`);
      await processCommand(pending);
      lastCommandId = pending.id;
    } catch (e) {
      log("command check failed: " + String((e && e.message) || e).slice(0, 100));
    }
  }

  // Shared send path (v2.6): the poll loop AND the push endpoint
  // (POST /signal) send through this one function, so validation, caps,
  // dedup, the 3s gap and the daily cap behave identically on both
  // paths. Returns {action, reason}:
  //   "sent"   — message went out (caller must ack the id)
  //   "drop"   — ack it (empty text / invalid recipient / already sent)
  //   "retry"  — leave queued (not connected / cap reached / send failed)
  //   "dryrun" — logged only, never acked (DRY_RUN mode)
  let lastSendAt = 0;
  async function sendQueuedItem(item) {
    const text = stripLinks(item.text || "");
    if (!text) return { action: "drop", reason: "empty text" };
    if (isRecentlySent(item.id)) {
      // KV can briefly re-list an acked item; never send it twice.
      log(`skip duplicate ${item.id} (already sent, still listed)`);
      return { action: "drop", reason: "duplicate" };
    }
    if (sentToday >= DAILY_CAP) {
      log(`daily cap (${DAILY_CAP}) reached — leaving rest queued`);
      return { action: "retry", reason: "daily cap reached" };
    }
    // Recipient comes from the queue item (admin-set in the panel);
    // default is the main number. Anything else is refused.
    let jid;
    try {
      jid = assertQueuedJid(item.to || MAIN_NUMBER);
    } catch (e) {
      log(`refusing item ${item.id}: ${String((e && e.message) || e).slice(0, 100)}`);
      return { action: "drop", reason: "invalid recipient" };
    }
    if (DRY_RUN) {
      log(`[DRY-RUN] would send to ${jid}: ${text.slice(0, 120)}`);
      return { action: "dryrun", reason: "dry-run" };
    }
    if (!connected || !sock) {
      log("WhatsApp not connected — items stay queued");
      return { action: "retry", reason: "not connected" };
    }
    // >= 3s between sends, whichever path sends (anti-spam guard).
    const wait = SEND_GAP_MS - (Date.now() - lastSendAt);
    if (wait > 0) await sleep(wait);
    try {
      await sock.sendMessage(jid, { text });
      lastSendAt = Date.now();
      sentToday++;
      writeCount(sentToday);
      markSent(item.id);
      log(`sent to ${jid} (${item.kind}): ${text.slice(0, 120)}`);
      return { action: "sent", reason: "sent to " + jid };
    } catch (e) {
      log("send failed, will retry next poll: " + String((e && e.message) || e).slice(0, 120));
      return { action: "retry", reason: "send failed: " + String((e && e.message) || e).slice(0, 80) };
    }
  }

  // Serialize sends: a push arriving mid-poll must not send less than 3s
  // after the poll's last send (and vice versa).
  let sendChain = Promise.resolve();
  function sendQueuedItemLocked(item) {
    const run = sendChain.then(() => sendQueuedItem(item));
    sendChain = run.catch(() => {});
    return run;
  }

  // Poll loop — runs even while WhatsApp is down; items stay queued until sent.
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      // Commands are checked first, on every poll — including while paused
      // (a paused bot must still hear RESUME).
      await checkCommand();
      if (paused) return; // STOP: send nothing; items stay queued
      const items = await fetchPending();
      if (items.length === 0) return;
      log(`queue: ${items.length} pending`);
      const acked = [];
      for (const item of items) {
        const r = await sendQueuedItemLocked(item);
        if (r.action === "sent" || r.action === "drop") acked.push(item.id);
        else if (r.action === "retry") break;
        // dryrun: continue without acking (items stay queued for the real run)
      }
      if (acked.length > 0 && !DRY_RUN) {
        const res = await ackItems(acked);
        log(`acked ${acked.length} (worker: ${JSON.stringify(res)})`);
      }
    } catch (e) {
      log("poll error: " + String((e && e.message) || e).slice(0, 120));
    } finally {
      polling = false;
    }
  }, POLL_MS);

  // Status heartbeat (v2.1): every 60s so the Worker knows the bot is
  // alive — if it goes quiet for 10+ minutes after having linked once,
  // the Worker posts a "sending number down" alert to Discord. While
  // paused (v2.2) the bot keeps heartbeating with state "paused", so the
  // down-detection does not fire.
  setInterval(() => {
    postStatus(paused ? "paused" : currentStatus, ownNumberDigits(sock)).catch(() => {});
  }, 60 * 1000);

  // Keep the process alive and log a heartbeat hourly.
  setInterval(() => {
    log(`heartbeat: connected=${connected} paused=${paused} sent_today=${sentToday} dry_run=${DRY_RUN}`);
  }, 3600 * 1000);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}

module.exports = { stripLinks, assertQueuedJid, isValidSignalItem, toStorable, fromStorable, readCount, isRecentlySent, markSent, ownNumberDigits, isValidBotCommand, fetchBotCommand, ackBotCommand, MAIN_NUMBER };
