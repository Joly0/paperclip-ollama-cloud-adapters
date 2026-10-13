// Prompt cache keepalive for Ollama Cloud.
//
// Ollama keeps a prompt in its cache for a few minutes only (measured
// 2026-10-07: glm-5.3 5 to 10 min, deepseek-v4.1-flash about 15, kimi-k3 30 to
// 60). A Paperclip wake that comes later resends the whole session uncached.
// OpenCode reaches Ollama through a small local proxy instead, which forwards
// every request unchanged and remembers the last agent request per agent and
// issue. After the run ends it resends that exact request (only max_tokens
// changes) every few minutes, so the next wake finds the session cached. The
// pings stop when a new run on the issue starts, after a maximum time, when a
// plan limit is spent (pings never use usage credits) or when one fails.
//
// Session hold: an agent can be stopped at a share of the 5-hour session
// limit. The proxy then refuses its next request with HTTP 400, which OpenCode
// does not retry, so the run ends at once; the pings go on until the session
// resets, so the retry right after the reset finds the cache warm.
//
// The proxy and its sessions live on globalThis so an adapter reload keeps the
// port that running OpenCode processes use; the newest module's code handles
// requests and pings.

import http from "node:http";
import https from "node:https";

const UPSTREAM_HOST = "ollama.com";
const STATE = Symbol.for("paperclip.ollama-cloud.keepalive");
const USAGE_CACHE_MS = 60 * 1000;

const shared = (globalThis[STATE] ??= {
  server: null,
  listening: null,
  handler: null,
  ping: null,
  sessions: new Map(),
  usage: new Map(),
});

let quota = { fetchUsage: null, spentMeter: null };

// index.js passes the limit helpers in, so this file needs no other module.
export function configure(helpers) {
  quota = helpers;
}

function session(key) {
  let s = shared.sessions.get(key);
  if (!s) {
    s = {
      body: null, path: null, apiKey: null, timer: null, active: false, deadline: 0, intervalMs: 0, pings: 0, lastCached: null,
      // Session hold: armed for the running run, what tripped it, and the
      // session meter readings while the pings wait for the reset.
      hold: null, tripped: null, holdStats: null,
    };
    shared.sessions.set(key, s);
  }
  return s;
}

function stop(s) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}

// The last request worth replaying is the agent's own turn: it carries the
// tool definitions. OpenCode's title request has none and is skipped.
function remember(key, path, raw) {
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (Array.isArray(body.tools) && body.tools.length > 0 && Array.isArray(body.messages)) {
      const s = session(key);
      s.body = body;
      s.path = path;
    }
  } catch {
    // Not JSON: nothing to replay.
  }
}

function forward(req, res, key, upstreamPath, raw) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  if (raw) headers["content-length"] = String(raw.length);
  const up = https.request(
    { host: UPSTREAM_HOST, path: upstreamPath, method: req.method, headers, timeout: 15 * 60 * 1000 },
    (upRes) => {
      const out = { ...upRes.headers };
      delete out["content-length"];
      delete out["transfer-encoding"];
      delete out.connection;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    },
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `ollama-cloud keepalive proxy: ${err.message}` } }));
  });
  if (raw) up.end(raw);
  else up.end();
}

// The session hold of a running run, once the session meter has reached it.
// The meter is read at most once a minute, so a run can overshoot the hold by
// up to a minute of work. An unreadable meter lets the request through.
async function holdReached(key) {
  const s = shared.sessions.get(key);
  if (!s?.hold) return null;
  if (s.tripped) return s.tripped;
  try {
    const used = (await readUsage(s.hold.apiKey))?.session;
    if (typeof used === "number" && used * 100 >= s.hold.atPercent) {
      s.tripped = { used, atPercent: s.hold.atPercent };
    }
  } catch {
    // Unknown: keep working.
  }
  return s.tripped;
}

// HTTP 400 because OpenCode retries 429 and 5xx (until its own timeout) but
// gives up on other client errors at once, with this message in its error.
function refuse(res, held) {
  const used = Math.round(held.used * 1000) / 10;
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: `Held by the ollama-cloud adapter: the Ollama Cloud session is ${used}% used, at or above this agent's hold at ${held.atPercent}%. The issue is retried after the session reset.`,
      type: "invalid_request_error",
      code: "session_hold",
    },
  }));
}

// Requests arrive as /s/<encoded key>/v1/...; the rest goes to ollama.com.
function handle(req, res) {
  const match = /^\/s\/([^/]+)(\/.*)$/.exec(req.url ?? "");
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  const key = decodeURIComponent(match[1]);
  const upstreamPath = match[2];
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = chunks.length > 0 ? Buffer.concat(chunks) : null;
    if (raw && req.method === "POST" && upstreamPath.endsWith("/chat/completions")) {
      // Remembered also when refused: it carries the latest tool results,
      // which the first ping then caches for the run after the reset.
      remember(key, upstreamPath, raw);
      const held = await holdReached(key);
      if (held) {
        refuse(res, held);
        return;
      }
    }
    forward(req, res, key, upstreamPath, raw);
  });
}

// Start the proxy once per server process and return its base URL for a key.
export async function baseUrlFor(key) {
  shared.handler = handle;
  shared.ping = ping;
  if (!shared.listening) {
    shared.server = http.createServer((req, res) => shared.handler(req, res));
    shared.listening = new Promise((resolve, reject) => {
      shared.server.once("error", reject);
      shared.server.listen(0, "127.0.0.1", () => resolve(shared.server.address().port));
    }).catch((err) => {
      shared.listening = null;
      throw err;
    });
  }
  const port = await shared.listening;
  return `http://127.0.0.1:${port}/s/${encodeURIComponent(key)}/v1`;
}

// A run starts: stop pinging and report what the pause between runs cost.
// `hold` ({ atPercent, apiKey }) arms the session hold for this run.
export function beginRun(key, hold = null) {
  const s = session(key);
  stop(s);
  s.active = true;
  s.hold = hold;
  s.tripped = null;
  const result = { pings: s.pings, lastCached: s.lastCached, hold: s.holdStats };
  s.pings = 0;
  s.lastCached = null;
  s.holdStats = null;
  return result;
}

// What stopped the run at the session hold ({ used, atPercent }), or null.
export function tripped(key) {
  return shared.sessions.get(key)?.tripped ?? null;
}

// A run ended, or a held run was not started: keep the cache warm until the
// next run or the deadline. `holdUntil` (ms) extends the deadline to the
// session reset; `holdUsed` is the session meter when the hold started.
export function endRun(key, options) {
  const s = shared.sessions.get(key);
  if (!s) return;
  s.active = false;
  s.hold = null;
  stop(s);
  if (!options || !s.body) return;
  s.apiKey = options.apiKey;
  s.intervalMs = options.intervalMinutes * 60 * 1000;
  s.deadline = Math.max(Date.now() + options.forMinutes * 60 * 1000, options.holdUntil ?? 0);
  if (options.holdUntil) {
    s.holdStats ??= { pings: 0, startUsed: options.holdUsed ?? null, peakUsed: options.holdUsed ?? null };
  }
  schedule(key, s);
}

function schedule(key, s) {
  if (Date.now() + s.intervalMs > s.deadline) {
    forget(key, s);
    return;
  }
  s.timer = setTimeout(() => shared.ping(key), s.intervalMs);
  s.timer.unref?.();
}

// Past the deadline the cache is gone anyway; drop the stored request. The
// entry stays while it has pings or hold readings for the next run to report.
function forget(key, s) {
  stop(s);
  s.body = null;
  s.apiKey = null;
  if (s.pings === 0 && !s.holdStats) shared.sessions.delete(key);
}

// The balance lookup, shared by the pings and the session hold of every
// agent on the same key and cached for a minute (the API allows 10 a minute).
async function readUsage(apiKey) {
  if (!quota.fetchUsage) return null;
  const cached = shared.usage.get(apiKey);
  if (cached && "usage" in cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.usage;
  const usage = await quota.fetchUsage(apiKey);
  shared.usage.set(apiKey, { at: Date.now(), usage });
  return usage;
}

async function planSpent(apiKey) {
  if (!quota.fetchUsage || !quota.spentMeter) return false;
  try {
    return Boolean(quota.spentMeter(await readUsage(apiKey)));
  } catch {
    return true; // Unknown: do not risk spending credits.
  }
}

function post(path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host: UPSTREAM_HOST,
        path,
        method: "POST",
        timeout: 5 * 60 * 1000,
        headers: { "content-type": "application/json", "content-length": String(data.length), authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

async function ping(key) {
  const s = shared.sessions.get(key);
  if (!s || s.active || !s.body || !s.apiKey) return;
  s.timer = null;
  if (await planSpent(s.apiKey)) {
    forget(key, s);
    return;
  }
  // Same prompt, same parameters; only the reply is cut to one token.
  const body = { ...s.body, max_tokens: 1, stream: false };
  delete body.stream_options;
  try {
    const res = await post(s.path, s.apiKey, body);
    if (res.status < 200 || res.status >= 300) {
      forget(key, s);
      return;
    }
    s.pings += 1;
    if (s.holdStats) {
      // What the held pings cost: the highest session reading before the
      // reset (readings after it are lower, so the maximum is the last one).
      s.holdStats.pings += 1;
      const used = shared.usage.get(s.apiKey)?.usage?.session;
      if (typeof used === "number") s.holdStats.peakUsed = Math.max(s.holdStats.peakUsed ?? 0, used);
    }
    try {
      s.lastCached = JSON.parse(res.text)?.usage?.prompt_tokens_details?.cached_tokens ?? null;
    } catch {
      s.lastCached = null;
    }
  } catch {
    forget(key, s);
    return;
  }
  if (!s.active) schedule(key, s);
}
