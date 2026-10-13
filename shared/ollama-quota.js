// Ollama Cloud usage limits, independent of the agent harness.
//
// Limits come from Ollama's balance API (https://docs.ollama.com/api/balance,
// since 2026-10-07; the old undocumented /api/usage meters are gone). Plans
// with session and weekly limits report `remaining_percent` and `resets_at`
// for each; newer plans report a monthly dollar allowance instead. Purchased
// usage credits are reported in both. If the balance is unavailable, a spent
// limit is still recognised from the refused request: Ollama answers HTTP 429
// "you (...) have reached your session usage limit", since 2026-10 "You
// reached your Pro 5-hour limit" (or weekly).
//
// The fallback reset schedule below is used only when the balance API gives
// no reset time. The resets are global, the same moment for every
// account (ollama/ollama#12532): sessions every 5 hours counted from the Unix
// epoch, weeks at Monday 00:00 UTC. They are computed here, which matches the
// times ollama.com/settings shows. A spent meter is retried just after its
// reset; each retry costs one usage request, not an LLM turn.

import fs from "node:fs";

export const OLLAMA_BASE = "https://ollama.com";
const REQUEST_TIMEOUT_MS = 10_000;

const SESSION_MS = 5 * 3600_000;
const WEEK_MS = 7 * 86400_000;
// The Unix epoch was a Thursday; shifting by 4 days puts week starts on Monday.
const WEEK_OFFSET_MS = 4 * 86400_000;

// Margin after a reset before retrying, so the meter has been cleared.
const RESET_MARGIN_MS = 2 * 60_000;
// A meter still spent this soon after its reset is retried shortly instead of
// waiting a whole window, in case the reset is late or the schedule changed.
// Not for a limit that ran out mid-run: that run used up the new window, and
// a needless early retry costs one of Paperclip's two automatic retries.
const GRACE_AFTER_RESET_MS = 30 * 60_000;
const GRACE_RETRY_MS = 15 * 60_000;

// Test switch: a file named .simulate-quota next to this module, containing
// "session" or "weekly" and optionally a retry delay in minutes ("weekly 10",
// default 5), makes every usage check report that meter as spent and retries
// after that delay instead of the real reset. "used 92" instead reports the
// session as 92% used and nothing spent, to test the session hold without
// spending anything; an optional third value moves the held retry that many
// minutes ahead instead of the real reset ("used 92 5"). Delete the file to
// return to real usage.
const SIMULATE_FILE = new URL("./.simulate-quota", import.meta.url);
const DEFAULT_SIMULATED_DELAY_MINUTES = 5;

function readSimulation() {
  try {
    const [meter, minutes, holdMinutes] = fs.readFileSync(SIMULATE_FILE, "utf8").trim().split(/\s+/);
    if (meter === "used") {
      const used = Number(minutes);
      if (!Number.isFinite(used) || used < 0 || used >= 100) return null;
      const delay = Number(holdMinutes);
      return { used: used / 100, holdMinutes: Number.isFinite(delay) && delay >= 1 ? delay : null };
    }
    if (meter !== "session" && meter !== "weekly") return null;
    const delay = Number(minutes);
    return { meter, minutes: Number.isFinite(delay) && delay >= 1 ? delay : DEFAULT_SIMULATED_DELAY_MINUTES };
  } catch {
    return null;
  }
}

// Reset times reported by the last balance lookup, by meter.
const reportedResets = {};

export function nextResetAt(meter, now = Date.now()) {
  const reported = reportedResets[meter];
  if (reported && reported.getTime() > now) return reported;
  if (meter === "monthly") return new Date(now + 30 * 86400_000);
  if (meter === "weekly") return new Date(now + WEEK_MS - ((now - WEEK_OFFSET_MS) % WEEK_MS));
  return new Date(now + SESSION_MS - (now % SESSION_MS));
}

function windowMs(meter) {
  if (meter === "monthly") return 30 * 86400_000;
  return meter === "weekly" ? WEEK_MS : SESSION_MS;
}

// When to retry a spent meter, and why (for the run log).
export function retryAt(meter, now = Date.now(), { grace = true } = {}) {
  const simulatedDelay = readSimulation()?.minutes;
  if (simulatedDelay) return { at: new Date(now + simulatedDelay * 60_000), reason: "simulated delay" };
  const next = nextResetAt(meter, now);
  const sinceLastReset = now - (next.getTime() - windowMs(meter));
  if (grace && sinceLastReset < GRACE_AFTER_RESET_MS) {
    return { at: new Date(now + GRACE_RETRY_MS), reason: "still spent just after the reset" };
  }
  return { at: new Date(next.getTime() + RESET_MARGIN_MS), reason: `the ${meter} reset at ${next.toISOString()}` };
}

export function configEnv(config) {
  const out = {};
  const raw = config?.env;
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
    else if (value && typeof value === "object" && typeof value.value === "string") out[key] = value.value;
  }
  return out;
}

export function apiKeyFor(config) {
  return configEnv(config).OLLAMA_API_KEY || process.env.OLLAMA_API_KEY || "";
}

export async function ollamaGet(apiPath, apiKey) {
  const res = await fetch(`${OLLAMA_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${apiPath} answered HTTP ${res.status}`);
  return res.json();
}

// Returns { session, weekly } as fractions (1 means spent), or null when the
// usage endpoint is unreachable. Callers treat null as "unknown, proceed".
// Used fractions (0..1, 1 means spent) per meter, the purchased credit
// balance in USD, and whether the balance API answered. Null when it cannot
// be reached at all.
export async function fetchUsage(apiKey) {
  const simulation = readSimulation();
  const simulated = simulation?.meter;
  if (simulated) {
    return { session: simulated === "session" ? 1 : 0, weekly: simulated === "weekly" ? 1 : 0, monthly: null, creditsUsd: null, simulated: true };
  }
  if (simulation?.used != null) {
    return { session: simulation.used, weekly: 0, monthly: null, creditsUsd: null, simulated: true };
  }
  if (!apiKey) return null;
  try {
    const data = await ollamaGet("/api/balance", apiKey);
    const included = data?.included ?? {};
    const used = (meter) => {
      const remaining = included[meter]?.remaining_percent;
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
      const at = Date.parse(included[meter]?.resets_at ?? "");
      if (Number.isFinite(at)) reportedResets[meter] = new Date(at);
      return Math.min(1, Math.max(0, 1 - remaining / 100));
    };
    let monthly = null;
    if (typeof included.balance_usd === "number" && typeof included.allowance_usd === "number" && included.allowance_usd > 0) {
      monthly = Math.min(1, Math.max(0, 1 - included.balance_usd / included.allowance_usd));
      const at = Date.parse(included.period?.until ?? "");
      if (Number.isFinite(at)) reportedResets.monthly = new Date(at);
    }
    const credits = data?.purchased?.balance_usd;
    return {
      session: used("session"),
      weekly: used("weekly"),
      monthly,
      creditsUsd: typeof credits === "number" && Number.isFinite(credits) ? credits : null,
    };
  } catch {
    return null;
  }
}

// The meter named by Ollama's refusal of a request, or null.
export function meterFromError(text) {
  // Both wordings: "reached your session usage limit" and, with the plan
  // name in front, "reached your Pro 5-hour limit".
  const match = /reached your (?:[\w-]+ )?(session|5-hour|weekly|monthly)(?: usage)? limit/i.exec(String(text ?? ""));
  if (!match) return null;
  const meter = match[1].toLowerCase();
  return meter === "5-hour" ? "session" : meter;
}

export function spentMeter(usage) {
  if (!usage) return null;
  if (usage.monthly != null && usage.monthly >= 1) return "monthly";
  if (usage.weekly != null && usage.weekly >= 1) return "weekly";
  if (usage.session != null && usage.session >= 1) return "session";
  return null;
}

// Result fields for a run that ends because a meter is spent. The caller adds
// executionRecovery only when it can prove no provider work started.
// `midRun` marks a limit that ran out during the run (no grace retry).
export function quotaFields(meter, simulated = false, { midRun = false } = {}) {
  const retry = retryAt(meter, Date.now(), { grace: !midRun });
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: retry.at.toISOString(),
    errorMessage:
      `Ollama Cloud ${meter} limit is spent${simulated ? " (simulated by .simulate-quota)" : ""}. ` +
      `Paperclip retries this issue at ${retry.at.toISOString()} (${retry.reason}).`,
    errorMeta: { ollamaMeter: meter, retryReason: retry.reason, simulated },
  };
}

// Result fields for a run held back because the session reached the agent's
// hold share. Unlike a spent meter, the session is retried right after its
// reported reset: the meter is not spent, so the grace retry does not apply.
export function holdFields(sessionUsed, atPercent, now = Date.now()) {
  const reset = nextResetAt("session", now);
  const simulatedDelay = readSimulation()?.holdMinutes;
  const at = simulatedDelay ? new Date(now + simulatedDelay * 60_000) : new Date(reset.getTime() + RESET_MARGIN_MS);
  const used = Math.round(sessionUsed * 1000) / 10;
  return {
    errorCode: "provider_quota",
    errorFamily: "provider_quota",
    retryNotBefore: at.toISOString(),
    errorMessage:
      `Ollama Cloud session is ${used}% used, at or above this agent's hold at ${atPercent}%. ` +
      `Paperclip retries this issue at ${at.toISOString()} (the session reset at ${reset.toISOString()}).`,
    errorMeta: { ollamaMeter: "session", sessionHold: true, sessionUsedPercent: used, holdAtPercent: atPercent },
  };
}

export async function getQuotaWindows() {
  const usage = await fetchUsage(process.env.OLLAMA_API_KEY || "");
  if (!usage) {
    return { provider: "ollama-cloud", ok: false, error: "Ollama balance endpoint unreachable or no key", windows: [] };
  }
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  const detail = usage.simulated
    ? "Simulated by .simulate-quota in the adapter folder"
    : "From Ollama's balance API (https://ollama.com/api/balance)";
  const credits = usage.creditsUsd == null ? null : `$${usage.creditsUsd.toFixed(2)} usage credits left`;
  const windows = [];
  if (usage.session != null) windows.push({ label: "5h session", usedPercent: pct(usage.session), resetsAt: nextResetAt("session").toISOString(), valueLabel: null, detail });
  if (usage.weekly != null) windows.push({ label: "7d weekly", usedPercent: pct(usage.weekly), resetsAt: nextResetAt("weekly").toISOString(), valueLabel: null, detail });
  if (usage.monthly != null) windows.push({ label: "Monthly allowance", usedPercent: pct(usage.monthly), resetsAt: nextResetAt("monthly").toISOString(), valueLabel: null, detail });
  if (credits) windows.push({ label: "Usage credits", usedPercent: null, resetsAt: null, valueLabel: credits, detail });
  return { provider: "ollama-cloud", source: `${OLLAMA_BASE}/api/balance`, ok: true, windows };
}

export const quotaConfigDoc = `- \`env.OLLAMA_API_KEY\`: the Ollama Cloud key, ideally a secret reference. Falls back to the container env.
- A limit found spent before the harness starts (Ollama's balance API), or recognised from Ollama refusing
  a request ("reached your session/weekly usage limit"), is retried 2 minutes after the reset the balance API reports (sessions every 5 hours
  from the Unix epoch, weeks at Monday 00:00 UTC, the same for every account).
- A limit that runs out in the middle of a run is also retried at the reset: the result reports
  bootstrap evidence so Paperclip does not block the issue, and the retry resumes the kept harness
  session. This is a deliberate trade-off: the evidence is not literally true for a run that worked.`;
