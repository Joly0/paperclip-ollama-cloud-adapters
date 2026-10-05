// Ollama Cloud usage limits, independent of the agent harness.
//
// The usage API reports the 5 hour session and the weekly meter as fractions
// but no reset times. The resets are global, the same moment for every
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
const GRACE_AFTER_RESET_MS = 30 * 60_000;
const GRACE_RETRY_MS = 15 * 60_000;

// Test switch: a file named .simulate-quota next to this module, containing
// "session" or "weekly" and optionally a retry delay in minutes ("weekly 10",
// default 5), makes every usage check report that meter as spent and retries
// after that delay instead of the real reset. Delete the file to return to
// real usage.
const SIMULATE_FILE = new URL("./.simulate-quota", import.meta.url);
const DEFAULT_SIMULATED_DELAY_MINUTES = 5;

function readSimulation() {
  try {
    const [meter, minutes] = fs.readFileSync(SIMULATE_FILE, "utf8").trim().split(/\s+/);
    if (meter !== "session" && meter !== "weekly") return null;
    const delay = Number(minutes);
    return { meter, minutes: Number.isFinite(delay) && delay >= 1 ? delay : DEFAULT_SIMULATED_DELAY_MINUTES };
  } catch {
    return null;
  }
}

export function nextResetAt(meter, now = Date.now()) {
  if (meter === "weekly") return new Date(now + WEEK_MS - ((now - WEEK_OFFSET_MS) % WEEK_MS));
  return new Date(now + SESSION_MS - (now % SESSION_MS));
}

function windowMs(meter) {
  return meter === "weekly" ? WEEK_MS : SESSION_MS;
}

// When to retry a spent meter, and why (for the run log).
export function retryAt(meter, now = Date.now()) {
  const simulatedDelay = readSimulation()?.minutes;
  if (simulatedDelay) return { at: new Date(now + simulatedDelay * 60_000), reason: "simulated delay" };
  const next = nextResetAt(meter, now);
  const sinceLastReset = now - (next.getTime() - windowMs(meter));
  if (sinceLastReset < GRACE_AFTER_RESET_MS) {
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
export async function fetchUsage(apiKey) {
  const simulated = readSimulation()?.meter;
  if (simulated) return { session: simulated === "session" ? 1 : 0, weekly: simulated === "weekly" ? 1 : 0, simulated: true };
  if (!apiKey) return null;
  try {
    const data = await ollamaGet("/api/usage", apiKey);
    const limits = data?.limits ?? {};
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { session: num(limits.session?.usage), weekly: num(limits.weekly?.usage) };
  } catch {
    return null;
  }
}

export function spentMeter(usage) {
  if (!usage) return null;
  if (usage.weekly !== null && usage.weekly >= 1) return "weekly";
  if (usage.session !== null && usage.session >= 1) return "session";
  return null;
}

// Result fields for a run that ends because a meter is spent. The caller adds
// executionRecovery only when it can prove no provider work started.
export function quotaFields(meter, simulated = false) {
  const retry = retryAt(meter);
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

export async function getQuotaWindows() {
  const usage = await fetchUsage(process.env.OLLAMA_API_KEY || "");
  if (!usage) {
    return { provider: "ollama-cloud", ok: false, error: "Ollama usage endpoint unreachable or no key", windows: [] };
  }
  const pct = (v) => (v === null ? null : Math.round(v * 100));
  const detail = usage.simulated
    ? "Simulated by .simulate-quota in the adapter folder"
    : "Reset times are computed: global 5 hour and Monday 00:00 UTC schedule";
  return {
    provider: "ollama-cloud",
    source: `${OLLAMA_BASE}/api/usage`,
    ok: true,
    windows: [
      { label: "5h session", usedPercent: pct(usage.session), resetsAt: nextResetAt("session").toISOString(), valueLabel: null, detail },
      { label: "7d weekly", usedPercent: pct(usage.weekly), resetsAt: nextResetAt("weekly").toISOString(), valueLabel: null, detail },
    ],
  };
}

export const quotaConfigDoc = `- \`env.OLLAMA_API_KEY\`: the Ollama Cloud key, ideally a secret reference. Falls back to the container env.
- A limit found spent before the harness starts is retried 2 minutes after its reset (sessions every 5 hours
  from the Unix epoch, weeks at Monday 00:00 UTC, the same for every account).
- A limit that runs out in the middle of a run blocks the issue for review, because the harness may have
  half-finished actions.`;
