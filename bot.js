/**
 * spare-whatsapp-bot — Baileys bot for Dogar Alpha Elite trade alerts.
 *
 * Links as a companion device to the SPARE WhatsApp account (+923703832506)
 * and sends plain-text alert messages to the recipients the Worker queues
 * (default: the main number +923001412943 only).
 * It polls the dogar-alerts Worker queue (Cloudflare KV) — the Worker never
 * pushes to the phone, so no public IP / port forwarding is needed.
 *
 * HOST: Render free web service (primary). Termux on the spare phone is the
 * fallback (see ../spare-call/SETUP-TERMUX.md).
 *   $ node bot.js            # QR link mode (scan from spare WhatsApp)
 *   $ LINK_MODE=code node bot.js   # pairing-code mode (8-digit code, in logs)
 *   $ DRY_RUN=1 node bot.js  # poll + log only, never send, never ack
 *
 * Env:
 *   WORKER_URL    default https://dogar-alerts.abdulrahman-dogar.workers.dev
 *   SPARE_TOKEN   required — the SPARE_BOT_TOKEN Worker secret
 *   POLL_SECONDS  default 10
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

  // /health server — Render requires the service to bind $PORT, and the
  // Worker's cron keep-alive pings this endpoint every 5 minutes.
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bot: "spare-whatsapp-bot", connected, sent_today: sentToday, ts: Date.now() }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(PORT, "0.0.0.0", () => log("health server on :" + PORT));

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
        if (LINK_MODE === "code") {
          // Pairing code mode: request a fresh 8-digit code (max once a minute).
          if (!sock.authState.creds.registered && Date.now() - pairingCodeShownAt > 60000) {
            try {
              pairingCodeShownAt = Date.now();
              const code = await sock.requestPairingCode(SPARE_PHONE);
              log("PAIRING CODE (enter in spare WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead): " + code);
            } catch (e) {
              log("pairing code request failed: " + String((e && e.message) || e).slice(0, 120));
            }
          }
        } else {
          log("QR LINK — scan with the SPARE WhatsApp (+923703832506): Settings > Linked Devices > Link a Device");
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === "open") {
        connected = true;
        reconnectAttempts = 0;
        log("WhatsApp connected as " + (sock.user ? sock.user.id : "?"));
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
          log("LOGGED OUT — clearing KV auth and stopping (link again to resume).");
          await clearKvAuth();
          process.exit(3);
        }
        // Exponential backoff (5s -> 10s -> 20s -> 40s -> 60s max): a dead
        // socket must not hammer WhatsApp with constant reconnects.
        reconnectAttempts++;
        const delay = Math.min(
          MAX_RECONNECT_DELAY_MS,
          5000 * Math.pow(2, reconnectAttempts - 1)
        );
        log(`reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        await sleep(delay);
        connect();
      }
    });
  }

  connect();

  // Poll loop — runs even while WhatsApp is down; items stay queued until sent.
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const items = await fetchPending();
      if (items.length === 0) return;
      log(`queue: ${items.length} pending`);
      const acked = [];
      for (const item of items) {
        const text = stripLinks(item.text || "");
        if (!text) {
          acked.push(item.id); // empty text: drop it, nothing to send
          continue;
        }
        if (isRecentlySent(item.id)) {
          // KV can briefly re-list an acked item; never send it twice.
          log(`skip duplicate ${item.id} (already sent, still listed)`);
          acked.push(item.id);
          continue;
        }
        if (sentToday >= DAILY_CAP) {
          log(`daily cap (${DAILY_CAP}) reached — leaving rest queued`);
          break;
        }
        // Recipient comes from the queue item (admin-set in the panel);
        // default is the main number. Anything else is refused.
        let jid;
        try {
          jid = assertQueuedJid(item.to || MAIN_NUMBER);
        } catch (e) {
          log(`refusing item ${item.id}: ${String((e && e.message) || e).slice(0, 100)}`);
          acked.push(item.id); // invalid recipient: drop it, never retry
          continue;
        }
        if (DRY_RUN) {
          log(`[DRY-RUN] would send to ${jid}: ${text.slice(0, 120)}`);
          continue; // dry-run never acks: items stay queued for the real run
        }
        if (!connected || !sock) {
          log("WhatsApp not connected — items stay queued");
          break;
        }
        try {
          await sock.sendMessage(jid, { text });
          sentToday++;
          writeCount(sentToday);
          markSent(item.id);
          acked.push(item.id);
          log(`sent to ${jid} (${item.kind}): ${text.slice(0, 120)}`);
        } catch (e) {
          log("send failed, will retry next poll: " + String((e && e.message) || e).slice(0, 120));
          break;
        }
        await sleep(SEND_GAP_MS);
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

  // Keep the process alive and log a heartbeat hourly.
  setInterval(() => {
    log(`heartbeat: connected=${connected} sent_today=${sentToday} dry_run=${DRY_RUN}`);
  }, 3600 * 1000);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}

module.exports = { stripLinks, assertQueuedJid, toStorable, fromStorable, readCount, isRecentlySent, markSent, MAIN_NUMBER };
