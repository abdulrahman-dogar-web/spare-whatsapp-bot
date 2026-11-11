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
 * Image (v2.10): ~17s after the text, the Worker pushes the chart
 * screenshot (POST /signal, kind "entry-image", image {data: base64 JPEG,
 * mime, caption}) and the bot sends it as a WhatsApp image message to
 * the same recipients. Image pushes are best-effort only (never queued
 * in KV) — if the bot is down or paused the image is lost, the text
 * stands. A per-item dry_run flag lets the Worker verify image handling
 * without sending anything (token-authenticated; the Worker never sets
 * dry_run in production).
 * ntfy alarm (v2.11, title-sanitized in v2.12, self-hosted in v2.13):
 * the BOT — not the Worker — publishes the ntfy phone alarm. The
 * Worker's egress IPs hit ntfy.sh's per-IP quota (250 msgs/day,
 * exhausted by strangers — even a first-ever post got HTTP 429 on the
 * panel Test alarm button, 2026-11-11), and the diagnosis is error
 * 42908 "daily message quota reached" (ntfy.sh shares one quota per
 * egress IP). So v2.13 runs ntfy ITSELF, inside this same Render
 * service (a second free Render service is impossible — 750 free
 * instance hours/month, this bot alone uses ~744h): the bot spawns
 * the ntfy binary as a child process listening on 127.0.0.1:2586,
 * publishes to it over loopback (exempt from its own rate limits),
 * and proxies all other HTTP paths to it, so the user's ntfy app
 * subscribes to this bot's own URL instead of ntfy.sh. The Worker
 * attaches an ntfy block {topic, enabled, title, server} to the FIRST
 * recipient's item only — three recipients still mean ONE alarm, not
 * three — and the bot POSTs to <server>/<topic> with Priority: 5
 * right after the WhatsApp send succeeds (never before, never
 * delaying it). POST /ntfy-test is the panel "Test alarm" button's
 * endpoint (same SPARE_TOKEN auth). v2.12: the title is sanitized to
 * ASCII/Latin1 before it is set as the "Title" header — the test
 * title's em-dash and signal titles' emoji made Node's fetch throw a
 * ByteString error on the first Test alarm press; the catch now also
 * keeps the FULL error message (500 chars) so failures show
 * completely. v2.13: a 4xx publish captures the ntfy error code from
 * the response body (e.g. ntfy_http_429_code_42908_...) and is never
 * retried elsewhere; a network error or 5xx falls back once to the
 * Worker-provided server, then ntfy.sh. v2.13.2: the bot installs the
 * ntfy binary ITSELF at startup (download + SHA256 + extract,
 * best-effort, ~60s max) — Render runs the dashboard build/start
 * commands for this existing service and ignores render.yaml, so a
 * deploy can go live with ./ntfy missing; the self-install makes the
 * alarm work regardless of the build/start commands.
 * A dry-run item that explicitly carries an ntfy block also posts —
 * production never attaches ntfy to dry-run items, so this is the
 * verification hook only (proves the bot's egress IP reaches ntfy.sh
 * without ringing any phone).
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
const { spawn, execFile } = require("child_process"); // v2.13: local ntfy server subprocess; v2.13.2: execFile for tar extraction in the self-install
const crypto = require("crypto"); // v2.13.2: SHA256 verification of the self-installed ntfy tarball
const os = require("os"); // v2.13.2: temp dir for the self-install
const { promisify } = require("util"); // v2.13.2: promisified execFile
const execFileAsync = promisify(execFile);

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
// v2.13.3: DAILY_CAP raised 30 -> 120. The cap counts EVERY WhatsApp
// send (all recipients), so 30 meant only 10 signals/day across 3
// recipients — an 11th signal on a busy day would be silently held
// ("daily cap reached") and the ring with it (ntfy fires after the
// WhatsApp send). 120 = ~40 signals/day, far above any real volume
// (best day so far: 7 signals), while still guarding against a runaway
// loop. Sends stay spaced 3s apart, so the spam risk is unchanged.
// NOTE: this only takes effect after a Manual Deploy on Render.
const DAILY_CAP = 120;
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
// v2.10: an "entry-image" item also carries image {data: base64, mime,
// caption}; dry_run (boolean) is the verification hook — it is validated
// here like any other field, and sendQueuedItem handles it.
// Exported for the self-test.
function isValidSignalItem(item) {
  return !!item && typeof item === "object" &&
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.text === "string" && item.text.length > 0 &&
    (item.to === undefined || typeof item.to === "string") &&
    (item.kind === undefined || typeof item.kind === "string") &&
    (item.image === undefined || (typeof item.image === "object" && typeof item.image.data === "string" && item.image.data.length > 0)) &&
    (item.dry_run === undefined || typeof item.dry_run === "boolean");
}

// Delivery delay (v2.7): the Worker stamps each item with receivedAt —
// the moment the TradingView webhook arrived. The delay is measured at
// send time, honestly, never faked: one decimal place, e.g. "2.4s".
// formatDelay returns "—" when receivedAt is missing/invalid.
// applyDelayToken replaces a literal <delay> in the message; if the
// template has no <delay> (hard-coded fallback format), the delay line
// is appended at the end so EVERY signal still shows how fast it was
// delivered. If receivedAt is missing, the text is left untouched.
function formatDelay(receivedAt, nowMs) {
  const r = Number(receivedAt);
  const n = Number(nowMs);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(n) || n < r) return "—";
  return ((n - r) / 1000).toFixed(1) + "s";
}
function applyDelayToken(text, receivedAt, nowMs) {
  const t = String(text || "");
  const d = formatDelay(receivedAt, nowMs);
  if (d === "—") return t;
  if (t.includes("<delay>")) return t.replace(/<delay>/g, d);
  return t + "\n⚡ Delivered in " + d;
}

// ---- ntfy alarm (v2.11, title-sanitized in v2.12, self-hosted in v2.13) ----
// The bot — not the Worker — publishes the alarm (see header). v2.13:
// the publish target is the SELF-HOSTED ntfy server running inside
// this same service (127.0.0.1:2586) whenever the Worker names this
// bot's own public URL as the server; the loopback address is exempt
// from ntfy's own rate limits, so a publish there can never 429.
// POST <server>/<topic> with Priority: 5 (max): Android plays a
// continuous alarm and bypasses silent/DND. Pure helpers (exported
// for the self-test). timeoutMs caps the wait per attempt (3s on the
// signal path so a slow ntfy can never eat the Worker's 5s push
// budget; 5s for the test endpoint, where the user is waiting for
// the result).
//
// v2.12 (2026-11-11): the ntfy TITLE travels as an HTTP header
// ("Title"), and Node's fetch (undici) rejects header values with any
// character > 255 (ByteString) — the test title's em-dash and signal
// titles' 🟢/🔴 emoji threw "Cannot convert argument to a ByteString..."
// on the very first Test alarm press. sanitizeNtfyTitle() makes every
// title ASCII/Latin1-safe right here, so the bot can never throw
// ByteString again no matter who sends it a title (the Worker also
// sanitizes first — defense in depth). The message BODY is untouched:
// emoji in the body is fine, it is the POST body (UTF-8), not a header.
// The catch now keeps the FULL error message (500 chars, was 60) so
// the panel console shows a failure completely instead of cut off.
//
// v2.13: a non-2xx publish reads the response body and reports the
// ntfy error code when it is JSON (e.g. 42908 "daily message quota
// reached" -> ntfy_http_429_code_42908_limit_reached_daily_message_
// quota_reached), so the panel console shows WHY ntfy refused it
// instead of a bare status. A 4xx (including 429) is final — the
// quota is per egress IP, so another server would refuse the same
// message too. A network error or 5xx falls back ONCE per remaining
// candidate: the Worker-provided server URL (if it was not the one
// just tried), then https://ntfy.sh.
const NTFY_LOCAL_URL = "http://127.0.0.1:2586";
const NTFY_DEFAULT_SERVER = "https://ntfy.sh";
const BOT_PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || "https://spare-whatsapp-bot.onrender.com").replace(/\/+$/, "");

function normalizeServerUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

// Resolve the publish base URL for a Worker-provided server URL:
// the bot's own public URL means the LOCAL loopback ntfy (avoids the
// public round-trip); anything else is used as given; no server means
// ntfy.sh (the pre-v2.13 behaviour). Exported for the self-test.
function resolveNtfyBase(serverUrl) {
  const s = normalizeServerUrl(serverUrl);
  if (!s) return NTFY_DEFAULT_SERVER;
  if (s.toLowerCase() === BOT_PUBLIC_URL.toLowerCase()) return NTFY_LOCAL_URL;
  return s;
}
function sanitizeNtfyTitle(title) {
  return String(title || "Signal")
    .replace(/[\u2013\u2014]/g, "-") // en-dash / em-dash -> "-"
    .replace(/[^\x00-\xFF]/g, "") // drop anything above Latin1 (emoji etc.)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Signal";
}
function isValidNtfyTopic(topic) {
  return typeof topic === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(topic);
}
// Build the result string for a 4xx publish: the ntfy error code and
// message are read from the JSON error body when present
// ({"code":42908,"http":429,"error":"limit reached: ..."}). res.text()
// is guarded — it may fail, or the body may not be JSON — and a mock
// without .text() at all must not crash: then the plain status is
// returned. Total result is bounded to 500 chars.
async function ntfyErrorResult(res) {
  const status = res.status;
  let code = null;
  let errText = "";
  try {
    if (res && typeof res.text === "function") {
      const raw = await res.text();
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data && typeof data === "object") {
            if (typeof data.code === "number") code = data.code;
            if (typeof data.error === "string") errText = data.error;
          }
        } catch (e) {
          /* body is not JSON — keep the plain status */
        }
      }
    }
  } catch (e) {
    /* res.text() failed — keep the plain status */
  }
  let out = "ntfy_http_" + status;
  if (code !== null) {
    out += "_code_" + code;
    if (errText) {
      const slug = errText.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
      if (slug) out += "_" + slug;
    }
  }
  return out.slice(0, 500);
}
async function sendNtfyAlarm(topic, title, text, timeoutMs, serverUrl) {
  const t = String(topic || "").trim();
  if (!t) return "ntfy_no_topic";
  if (!isValidNtfyTopic(t)) return "ntfy_bad_topic";
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  // Fallback order (v2.13): the resolved server first; then the
  // Worker-provided server URL (if it was not the one just tried);
  // then https://ntfy.sh. Only a network error or a 5xx moves to the
  // next candidate — a 4xx (including 429) returns at once with its
  // ntfy error code, and a 2xx returns at once as success.
  const primary = resolveNtfyBase(serverUrl);
  const candidates = [primary];
  const provided = normalizeServerUrl(serverUrl);
  if (provided && provided !== primary) candidates.push(provided);
  if (!candidates.includes(NTFY_DEFAULT_SERVER)) candidates.push(NTFY_DEFAULT_SERVER);
  let lastStatus = 0;
  let lastError = null;
  for (const base of candidates) {
    let res;
    try {
      res = await fetch(base + "/" + encodeURIComponent(t), {
        method: "POST",
        headers: { "Priority": "5", "Title": sanitizeNtfyTitle(title), "Content-Type": "text/plain; charset=utf-8" },
        body: String(text || "").slice(0, 4000),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      lastError = e; // network error / timeout: try the next candidate
      continue;
    }
    if (res.status >= 200 && res.status < 300) return "ntfy_http_" + res.status;
    if (res.status >= 400 && res.status < 500) return await ntfyErrorResult(res);
    lastStatus = res.status; // 5xx: try the next candidate
    lastError = new Error("ntfy HTTP " + res.status);
  }
  if (lastStatus) return "ntfy_http_" + lastStatus;
  return "ntfy_error_" + String((lastError && lastError.message) || lastError || "all ntfy servers failed").slice(0, 500);
}

// ---- ntfy binary self-install (v2.13.2) ----
// Render runs the DASHBOARD build/start commands ('npm install' /
// 'node bot.js') for this existing service — the render.yaml
// buildCommand (which downloads ./ntfy) and startCommand (bash
// start-render.sh) are ignored, so a deploy can go live with the
// binary missing (ntfy_server: "not_installed", 2026-11-11) and no
// build/start change can ever fix it. The bot therefore installs the
// binary ITSELF at startup: if ./ntfy is missing (or not executable),
// download the pinned ntfy release tarball, verify its SHA256, extract
// the single binary with the system tar, and chmod +x it into dir.
// Best-effort, bounded (~60s total: 45s download + 15s extract):
// ANY failure only logs and returns false — the bot keeps running and
// ntfy publishes fall back to ntfy.sh (the pre-v2.13 behaviour). It
// never throws, never blocks the bot from starting, and never touches
// ntfy-server.yml, the loopback server, the proxy, or alert behaviour.
// Exported for the self-test / verification harness.
const NTFY_RELEASE_URL = "https://github.com/binwiederhier/ntfy/releases/download/v2.36.0/ntfy_2.36.0_linux_amd64.tar.gz";
const NTFY_RELEASE_SHA256 = "d2c76d17c4bde762913b1cbbf5ca2ac74c3eade36befb0989b44e7877c8596c2";
const NTFY_RELEASE_MEMBER = "ntfy_2.36.0_linux_amd64/ntfy";
async function ensureNtfyBinary(dir) {
  const targetDir = dir || __dirname;
  const bin = path.join(targetDir, "ntfy");
  try {
    if (fs.existsSync(bin)) {
      try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch (e) { /* exists but not executable — reinstall below */ }
    }
  } catch (e) { /* fall through to install */ }
  const started = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntfy-install-"));
  try {
    log("local ntfy: ./ntfy missing — downloading v2.36.0");
    const res = await fetch(NTFY_RELEASE_URL, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error("download HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(tmpDir, "ntfy.tar.gz"), buf);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (hash !== NTFY_RELEASE_SHA256) throw new Error("SHA256 mismatch (got " + hash.slice(0, 16) + "…)");
    log("local ntfy: tarball verified (" + buf.length + " bytes, SHA256 OK)");
    await execFileAsync("tar", ["-xzf", path.join(tmpDir, "ntfy.tar.gz"), "-C", tmpDir, NTFY_RELEASE_MEMBER], { timeout: 15000 });
    const extracted = path.join(tmpDir, NTFY_RELEASE_MEMBER);
    fs.copyFileSync(extracted, bin);
    fs.chmodSync(bin, 0o755);
    log("local ntfy: binary installed at " + bin + " in " + ((Date.now() - started) / 1000).toFixed(1) + "s");
    return true;
  } catch (e) {
    log("local ntfy: self-install failed (" + String((e && e.message) || e).slice(0, 120) + ") — ntfy publishes fall back to ntfy.sh");
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best-effort cleanup */ }
  }
}

// ---- local ntfy HTTP proxy (v2.13) ----
// The bot's HTTP server proxies every path that is NOT one of its own
// routes to the local ntfy (127.0.0.1:2586) — this is how the user's
// ntfy app, subscribed to the bot's public URL, reaches the local
// server, including its long-lived SSE streams. Pure helper (exported
// for the self-test / verification harness): method, path, query,
// headers and body are forwarded; the upstream response streams back
// without buffering; on upstream error / local ntfy down it answers
// 502 (never crashes); on client disconnect the upstream request is
// aborted. X-Forwarded-For carries the real client IP (Render sets it;
// behind-proxy is true in ntfy-server.yml), falling back to the
// socket address.
function ntfyClientIp(req) {
  const xff = req && req.headers && req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).split(",")[0].trim();
  return (req && req.socket && req.socket.remoteAddress) || "127.0.0.1";
}
function proxyToLocalNtfy(req, res) {
  const headers = { ...(req.headers || {}) };
  delete headers["host"];
  delete headers["connection"];
  headers["x-forwarded-for"] = ntfyClientIp(req);
  headers["host"] = "127.0.0.1:2586";
  let upstream;
  try {
    upstream = http.request(
      { host: "127.0.0.1", port: 2586, method: req.method, path: req.url, headers },
      (upRes) => {
        if (res.destroyed) return;
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("ntfy unavailable");
    return;
  }
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    if (!res.writableEnded) res.end("ntfy unavailable");
  });
  req.on("aborted", () => { try { upstream.destroy(); } catch (e) { /* already gone */ } });
  res.on("close", () => { if (!res.writableEnded) { try { upstream.destroy(); } catch (e) { /* already gone */ } } });
  req.pipe(upstream);
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
  // ntfy alarm (v2.11): last publish result {result, topic, ts} — shown
  // in /health so the Worker console can see it without another call.
  let lastNtfy = null;

  // ---- local ntfy server (v2.13, subprocess; self-install in v2.13.2) ----
  // The ntfy binary runs as a child process listening on 127.0.0.1:2586
  // with the committed ntfy-server.yml config; base-url is filled in at
  // startup from RENDER_EXTERNAL_URL (fallback: the known public URL)
  // so it can never go stale. Started here, before connect(), so alarms
  // work from the first signal. v2.13.2: if ./ntfy is missing, the bot
  // installs it itself first (ensureNtfyBinary — download + SHA256 +
  // extract, best-effort, ~60s max), because Render ignores the
  // render.yaml build/start commands that used to install it. On crash
  // it restarts with a 5s backoff, max 5 restarts, then gives up
  // (status "down") — publishes still fall back to ntfy.sh via
  // sendNtfyAlarm. If the binary is missing AND the self-install fails,
  // the bot keeps working for WhatsApp and every publish goes to
  // ntfy.sh.
  const NTFY_MAX_RESTARTS = 5;
  const NTFY_RESTART_BACKOFF_MS = 5000;
  let ntfyServerStatus = "not_installed"; // "running" | "down" | "not_installed"
  let ntfyProc = null;
  let ntfyRestarts = 0;
  // Async: installs the binary first when missing (best-effort, ~60s
  // max). Called fire-and-forget from main() — a slow download must
  // never delay the health server binding or the WhatsApp connect;
  // /health flips ntfy_server to "running" once install + spawn
  // complete. The restart path reuses it (binary exists by then, so
  // the install is a no-op).
  async function startLocalNtfy() {
    const bin = path.join(__dirname, "ntfy");
    if (!fs.existsSync(bin)) {
      await ensureNtfyBinary(__dirname);
    }
    if (!fs.existsSync(bin)) {
      ntfyServerStatus = "not_installed";
      log("local ntfy: ./ntfy binary not installed — ntfy publishes fall back to ntfy.sh");
      return;
    }
    let cfgText;
    try {
      cfgText = fs.readFileSync(path.join(__dirname, "ntfy-server.yml"), "utf-8");
    } catch (e) {
      ntfyServerStatus = "down";
      log("local ntfy: ntfy-server.yml missing (" + String((e && e.message) || e).slice(0, 80) + ") — not starting");
      return;
    }
    if (!cfgText.includes("{{BASE_URL}}")) {
      ntfyServerStatus = "down";
      log("local ntfy: ntfy-server.yml has no {{BASE_URL}} placeholder — not starting");
      return;
    }
    const runtimeCfg = path.join(__dirname, "ntfy-server.runtime.yml");
    try {
      fs.writeFileSync(runtimeCfg, cfgText.replace("{{BASE_URL}}", BOT_PUBLIC_URL));
    } catch (e) {
      ntfyServerStatus = "down";
      log("local ntfy: cannot write runtime config (" + String((e && e.message) || e).slice(0, 80) + ") — not starting");
      return;
    }
    log("local ntfy: starting ./ntfy (base-url " + BOT_PUBLIC_URL + ", listen 127.0.0.1:2586)");
    try {
      ntfyProc = spawn(bin, ["serve", "-c", runtimeCfg], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      ntfyServerStatus = "down";
      log("local ntfy: spawn failed (" + String((e && e.message) || e).slice(0, 120) + ")");
      return;
    }
    ntfyServerStatus = "running";
    ntfyProc.stdout.on("data", (d) => log("[ntfy] " + String(d).trim().slice(0, 200)));
    ntfyProc.stderr.on("data", (d) => log("[ntfy] " + String(d).trim().slice(0, 200)));
    ntfyProc.on("error", (e) => {
      ntfyServerStatus = "down";
      log("local ntfy: process error (" + String((e && e.message) || e).slice(0, 120) + ")");
    });
    ntfyProc.on("exit", (code, signal) => {
      ntfyProc = null;
      ntfyServerStatus = "down";
      if (ntfyRestarts < NTFY_MAX_RESTARTS) {
        ntfyRestarts++;
        log(`local ntfy: exited (code=${code} signal=${signal}) — restart ${ntfyRestarts}/${NTFY_MAX_RESTARTS} in ${NTFY_RESTART_BACKOFF_MS / 1000}s`);
        setTimeout(startLocalNtfy, NTFY_RESTART_BACKOFF_MS);
      } else {
        log("local ntfy: exited and restart limit reached — giving up; ntfy publishes fall back to ntfy.sh");
      }
    });
  }
  startLocalNtfy();

  // ntfy alarm (v2.11, server wired through in v2.13): post the alarm
  // for an item that carries an ntfy block {topic, enabled, title,
  // server}. Called AFTER the WhatsApp send succeeds (or for a
  // dry-run verification item) — it never delays a send. Returns the
  // result string ("ntfy_http_200", "ntfy_http_429_code_42908_...",
  // ...), or null when the item carries no ntfy block / it is disabled
  // / the topic is empty. Records the result in lastNtfy.
  async function maybePostNtfy(item, text) {
    const n = item && item.ntfy;
    if (!n || typeof n !== "object" || n.enabled === false) return null;
    const topic = String(n.topic || "").trim();
    if (!topic) return null;
    const result = await sendNtfyAlarm(topic, String(n.title || "Signal").slice(0, 100), text, 3000, n.server);
    lastNtfy = { result, topic, ts: Date.now() };
    log(`ntfy alarm — ${result} (topic ${topic})`);
    return result;
  }

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
      res.end(JSON.stringify({ ok: true, bot: "spare-whatsapp-bot", version: "2.13.3", connected, paused, state: paused ? "paused" : (connected ? "linked" : currentStatus), sent_today: sentToday, last_ntfy: lastNtfy, ntfy_server: ntfyServerStatus, ntfy_exists: fs.existsSync(path.join(__dirname, "ntfy")), ntfy_path: path.join(__dirname, "ntfy"), cwd: process.cwd(), ts: Date.now() }));
    } else if (req.url === "/signal" && req.method === "POST") {
      handlePushSignal(req, res);
    } else if (req.url === "/ntfy-test" && req.method === "POST") {
      handleNtfyTest(req, res);
    } else if (req.url.split("?")[0] === "/signal" || req.url.split("?")[0] === "/ntfy-test") {
      // Bot route, wrong method (only POST is valid) — keep the old 404.
      res.writeHead(404);
      res.end("not found");
    } else {
      // v2.13: every other path is proxied to the local ntfy server
      // (the user's ntfy app subscribes to this bot's URL).
      proxyToLocalNtfy(req, res);
    }
  });
  server.listen(PORT, "0.0.0.0", () => log("health server on :" + PORT));

  // POST /ntfy-test (v2.11, server wired through in v2.13): the
  // Worker's panel "Test alarm" button asks the BOT to post the test
  // message (auth: SPARE_TOKEN, same as /signal). Body {token, topic,
  // title, body, server} — v2.17 Worker sends server; v2.13 honours
  // it. Returns {ok:true, result:"ntfy_http_200", topic} on success. Only the
  // Worker calls this (via the panel button the user presses himself);
  // the button is rate-limited to 1/min Worker-side.
  async function handleNtfyTest(req, res) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", async () => {
      let b = null;
      try { b = JSON.parse(body || "{}"); } catch (e) { b = null; }
      if (!b || typeof b !== "object") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_payload" }));
        return;
      }
      if (String(b.token || "") !== SPARE_TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_token" }));
        return;
      }
      const topic = String(b.topic || "").trim();
      if (!isValidNtfyTopic(topic)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad_topic" }));
        return;
      }
      const result = await sendNtfyAlarm(topic, String(b.title || "Test alarm — Dogar Alerts").slice(0, 100), String(b.body || ""), 5000, b.server);
      lastNtfy = { result, topic, ts: Date.now() };
      log(`ntfy test — ${result} (topic ${topic})`);
      if (/^ntfy_http_2/.test(result)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result, topic }));
      } else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result, topic }));
      }
    });
  }

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
      if (body.length > 2000000) req.destroy(); // v2.10: image pushes carry base64 JPEG (~100-300KB); token-authenticated, so 2MB is safe
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
        res.end(JSON.stringify({ ok: true, result: r.action, ms, ...(r.ntfy ? { ntfy: r.ntfy } : {}) }));
      } else if (r.action === "dryrun") {
        res.writeHead(200, { "content-type": "application/json" });
        // v2.10: the per-item dry run reports the decoded image size, so
        // the Worker can verify image handling without sending anything.
        // v2.11: ...plus the ntfy result when the item carried an ntfy block.
        res.end(JSON.stringify({ ok: true, result: "dryrun", ms, ...(typeof r.imageBytes === "number" ? { imageBytes: r.imageBytes } : {}), ...(r.ntfy ? { ntfy: r.ntfy } : {}) }));
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
    // Delay line (v2.7): applied AFTER stripLinks, so the line is never
    // cut off by the 500-char cap.
    const text = applyDelayToken(stripLinks(item.text || ""), item.receivedAt, Date.now());
    if (!text) return { action: "drop", reason: "empty text" };
    if (isRecentlySent(item.id)) {
      // KV can briefly re-list an acked item; never send it twice.
      log(`skip duplicate ${item.id} (already sent, still listed)`);
      return { action: "drop", reason: "duplicate" };
    }
    // Chart image (v2.10): kind "entry-image" carries image {data: base64
    // JPEG, mime, caption}. Decoded + size-checked here so a bad image is
    // dropped, never sent. Images are push-only (never in the KV queue).
    let imageBuf = null;
    if (item.image && typeof item.image === "object" && typeof item.image.data === "string") {
      try { imageBuf = Buffer.from(item.image.data, "base64"); } catch (e) { imageBuf = null; }
      if (!imageBuf || imageBuf.length < 2000 || imageBuf.length > 1500000) {
        log(`refusing item ${item.id}: bad image payload (${imageBuf ? imageBuf.length : 0} bytes)`);
        return { action: "drop", reason: "bad image" };
      }
    }
    // Per-item dry run (v2.10, verification hook): validate + decode the
    // image (or text) and log it, but send nothing and ack nothing. Only
    // the Worker can call /signal (token-authenticated); the Worker never
    // sets dry_run in production.
    if (item.dry_run === true) {
      log(`[DRY-RUN-ITEM] would send ${imageBuf ? "image (" + imageBuf.length + " bytes, " + (item.image.mime || "?") + ")" : "text"} to ${item.to || MAIN_NUMBER}: ${text.slice(0, 120)}`);
      // ntfy verification hook (v2.11): a dry-run item NEVER sends
      // WhatsApp, but if it explicitly carries an ntfy block, post the
      // alarm — production never attaches ntfy to dry-run items, so this
      // only ever fires for an injected verification item (proves the
      // bot's egress IP reaches ntfy.sh without ringing any phone).
      const ntfyDry = await maybePostNtfy(item, text);
      return { action: "dryrun", reason: "dry-run-item", imageBytes: imageBuf ? imageBuf.length : 0, ...(ntfyDry ? { ntfy: ntfyDry } : {}) };
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
      if (imageBuf) {
        const caption = String((item.image && item.image.caption) || item.text || "").slice(0, 300);
        await sock.sendMessage(jid, { image: imageBuf, caption });
      } else {
        await sock.sendMessage(jid, { text });
      }
      lastSendAt = Date.now();
      sentToday++;
      writeCount(sentToday);
      markSent(item.id);
      log(`sent to ${jid} (${item.kind}): ${imageBuf ? "image (" + imageBuf.length + " bytes)" : text.slice(0, 120)}`);
      // ntfy alarm (v2.11): AFTER the WhatsApp send, once per signal —
      // the Worker attaches the ntfy block to the FIRST recipient's item
      // only, so three recipients still mean one alarm, not three.
      const ntfy = await maybePostNtfy(item, text);
      return { action: "sent", reason: "sent to " + jid, ...(ntfy ? { ntfy } : {}) };
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

module.exports = { stripLinks, assertQueuedJid, isValidSignalItem, formatDelay, applyDelayToken, sendNtfyAlarm, sanitizeNtfyTitle, isValidNtfyTopic, resolveNtfyBase, ensureNtfyBinary, NTFY_RELEASE_URL, NTFY_RELEASE_SHA256, NTFY_RELEASE_MEMBER, proxyToLocalNtfy, toStorable, fromStorable, readCount, isRecentlySent, markSent, ownNumberDigits, isValidBotCommand, fetchBotCommand, ackBotCommand, MAIN_NUMBER };
