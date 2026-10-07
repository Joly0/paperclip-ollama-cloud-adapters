// Per-agent OpenCode settings that keep Ollama Cloud usage in check: reasoning
// effort, OpenCode's output cap, compaction and the loop guard. Everything is
// handed to OpenCode through the run's env, so nothing global changes.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_PREFIX = "ollama-cloud/";
const EFFORT_ORDER = ["low", "medium", "high", "max"];

export const DEFAULTS = {
  reasoningEffort: "high",
  raiseOutputCap: true,
  // Highest automatic output cap. OpenCode compacts at "context minus output
  // cap" unless a model has an input limit, so an uncapped 1M output limit
  // (the deepseek models) would compact on every turn.
  autoOutputCapMax: 131072,
  compaction: false,
  compactAtTokens: 200000,
  pruneToolOutputs: false,
  loopGuard: true,
  loopGuardRepeats: 3,
  stableTempDir: true,
};

// Paperclip gives every run a fresh scratch folder (paperclip-run-<issue>-<run>-<random>)
// and points TMPDIR at it, so it can remove the run's temp files when the run
// ends. OpenCode writes "$TMPDIR/opencode" into the bash tool's description,
// which comes before the conversation in every request, so each resumed run
// missed Ollama's prompt cache from that point on. TMPDIR stays as Paperclip
// sets it; a stable link per agent and issue points at the current scratch
// folder, and guards.js shows the model the link instead of the per-run path.
const STABLE_TEMP_ROOT = path.join(os.tmpdir(), "paperclip-opencode");
// A link whose target still exists belongs to a run that may still be active,
// unless the target is older than this.
const ACTIVE_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DANGLING_LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function safeSegment(value, fallback) {
  const text = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);
  return text && text !== "." && text !== ".." ? text : fallback;
}

// Removes links whose scratch folder is gone, once they are a day old.
function sweepStableLinks() {
  const now = Date.now();
  let agents = [];
  try {
    agents = fs.readdirSync(STABLE_TEMP_ROOT);
  } catch {
    return;
  }
  for (const agent of agents) {
    const agentDir = path.join(STABLE_TEMP_ROOT, agent);
    let links = [];
    try {
      links = fs.readdirSync(agentDir);
    } catch {
      continue;
    }
    for (const name of links) {
      const link = path.join(agentDir, name);
      try {
        const info = fs.lstatSync(link);
        if (!info.isSymbolicLink() || fs.existsSync(link)) continue;
        if (now - info.mtimeMs > DANGLING_LINK_MAX_AGE_MS) fs.unlinkSync(link);
      } catch {
        // Another run may be replacing it.
      }
    }
  }
}

// Points the agent's link for this issue at the run's scratch folder. Returns
// the env for guards.js, or null when TMPDIR is not a Paperclip scratch folder
// or another run on the same issue still uses the link.
function linkStableTemp(env, run) {
  const scratch = envValue(env, "TMPDIR");
  if (!scratch || !path.basename(scratch).startsWith("paperclip-run-")) return null;
  sweepStableLinks();
  const agentDir = path.join(STABLE_TEMP_ROOT, safeSegment(run.agentId, "agent"));
  const link = path.join(agentDir, safeSegment(run.issue, "no-issue"));
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  let current = null;
  try {
    current = fs.readlinkSync(link);
  } catch {
    // No link yet.
  }
  if (current && current !== scratch) {
    try {
      if (Date.now() - fs.statSync(current).mtimeMs < ACTIVE_RUN_MAX_AGE_MS) return null;
    } catch {
      // The previous run's folder is gone, so the link is free.
    }
  }
  if (current !== scratch) {
    const temp = `${link}.${process.pid}.${Date.now()}`;
    fs.symlinkSync(scratch, temp);
    fs.renameSync(temp, link);
  }
  return { PAPERCLIP_TMP_RUN: scratch, PAPERCLIP_TMP_STABLE: link };
}

// OpenCode's default compaction buffer (`compaction.reserved`).
const COMPACTION_RESERVED = 20000;
const MIN_COMPACT_AT = 50000;

// Used when `opencode models --verbose` fails. Taken from OpenCode 1.18.31.
const FALLBACK_MODELS = {
  "deepseek-v4-pro": { context: 1048576, output: 1048576, variants: ["high", "max"] },
  "deepseek-v4-pro:0813": { context: 1048576, output: 1048576, variants: ["high", "max"] },
  "deepseek-v4.1-flash": { context: 1048576, output: 384000, variants: ["low", "high", "max"] },
  "gemma4:31b": { context: 262144, output: 262144, variants: ["low", "medium", "high"] },
  "glm-5.2": { context: 976000, output: 131072, variants: ["high", "max"] },
  "glm-5.3": { context: 1048576, output: 131072, variants: ["low", "high", "max"] },
  "glm-5.3-flash": { context: 1000000, output: 131072, variants: ["low", "high", "max"] },
  "gpt-oss:20b": { context: 131072, output: 32768, variants: ["low", "medium", "high"] },
  "gpt-oss:120b": { context: 131072, output: 32768, variants: ["low", "medium", "high"] },
  "kimi-k2.6": { context: 262144, output: 262144, variants: [] },
  "kimi-k2.7-code": { context: 262144, output: 262144, variants: [] },
  "kimi-k3": { context: 1048576, output: 131072, variants: ["low", "high", "max"] },
  "minimax-m2.7": { context: 196608, output: 196608, variants: [] },
  "minimax-m3": { context: 512000, output: 131072, variants: ["low", "medium", "high", "max"] },
  "mistral-large-3:675b": { context: 262144, output: 262144, variants: [] },
  "nemotron-3-nano:30b": { context: 1048576, output: 131072, variants: ["low", "medium", "high"] },
  "nemotron-3-super": { context: 262144, output: 65536, variants: ["low", "medium", "high"] },
  "nemotron-3-ultra": { context: 262144, output: 128000, variants: ["low", "medium", "high"] },
};

const METADATA_TTL_MS = 60 * 60 * 1000;
let metadataCache = null;

// `opencode models ollama-cloud --verbose` prints each model id on its own line
// followed by a pretty-printed JSON object.
export function parseVerboseModels(text) {
  const out = {};
  const parts = text.split(/^ollama-cloud\/(\S+)\s*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    try {
      const info = JSON.parse(parts[i + 1].trim());
      out[parts[i]] = {
        context: Number(info?.limit?.context) || 0,
        output: Number(info?.limit?.output) || 0,
        variants: Object.keys(info?.variants ?? {}),
      };
    } catch {
      // Skip a model whose block does not parse.
    }
  }
  return out;
}

function runVerboseModels(command) {
  return new Promise((resolve) => {
    execFile(
      command,
      ["models", "ollama-cloud", "--verbose"],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024, cwd: "/tmp" },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });
}

// Model limits and reasoning variants as OpenCode knows them, cached for an hour.
export async function modelMetadata(command = "opencode") {
  if (metadataCache && Date.now() - metadataCache.at < METADATA_TTL_MS) return metadataCache.models;
  const parsed = parseVerboseModels(await runVerboseModels(command));
  if (Object.keys(parsed).length === 0) return FALLBACK_MODELS;
  metadataCache = { at: Date.now(), models: parsed };
  return parsed;
}

// The supported variant closest to the requested effort; a tie goes to the
// higher one. Null when the model offers no variants.
export function pickVariant(requested, variants) {
  if (!variants || variants.length === 0) return null;
  if (variants.includes(requested)) return requested;
  const want = EFFORT_ORDER.indexOf(requested);
  let best = null;
  let bestDistance = Infinity;
  for (const variant of variants) {
    const index = EFFORT_ORDER.indexOf(variant);
    if (index === -1) continue;
    const distance = Math.abs(index - want);
    if (distance < bestDistance || (distance === bestDistance && index > EFFORT_ORDER.indexOf(best))) {
      best = variant;
      bestDistance = distance;
    }
  }
  return best;
}

function asBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function asPositiveInt(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function envValue(env, key) {
  const value = env?.[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.value === "string") return value.value;
  return undefined;
}

// OpenCode 1.18 ignores file:// plugin entries in its config and loads only
// files in the config's plugins folder. Paperclip copies that folder into each
// run's config, so guards.js is installed there; each guard stays inert unless
// the run's env enables it, which keeps them per-agent settings.
const GUARDS_FILE = "paperclip-guards.js";

function installGuards(env) {
  const configHome =
    envValue(env, "XDG_CONFIG_HOME") || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const target = path.join(configHome, "opencode", "plugins", GUARDS_FILE);
  const source = fs.readFileSync(new URL("./guards.js", import.meta.url), "utf8");
  let current = null;
  try {
    current = fs.readFileSync(target, "utf8");
  } catch {
    // Not installed yet.
  }
  if (current === source) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Adds the settings to the run's config: `variant` for OpenCode's --variant,
// and env entries for the output cap, the inline OpenCode config and the loop
// guard. Returns the new config and one log line describing what was applied.
export async function applyRunSettings(config, run = {}) {
  const model = String(config.model ?? "").trim();
  const modelId = model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : model;
  const metadata = await modelMetadata(String(config.command ?? "").trim() || "opencode");
  const info = metadata[modelId] ?? FALLBACK_MODELS[modelId] ?? null;
  const env = { ...(config.env && typeof config.env === "object" ? config.env : {}) };
  const notes = [];
  const next = { ...config };

  // Reasoning effort. An explicit `variant` (API only) wins over the field;
  // Paperclip's own "Thinking effort" field (`effort`) is ignored.
  const explicitVariant = typeof config.variant === "string" ? config.variant.trim() : "";
  const effort = String(config.reasoningEffort ?? DEFAULTS.reasoningEffort).trim() || DEFAULTS.reasoningEffort;
  if (explicitVariant) {
    notes.push(`variant ${explicitVariant} (set directly)`);
  } else if (effort === "auto") {
    next.variant = "";
    notes.push("effort auto (server default)");
  } else {
    const variant = pickVariant(effort, info?.variants);
    next.variant = variant ?? "";
    notes.push(variant ? `effort ${effort} -> variant ${variant}` : `effort ${effort} (model has no variants, none sent)`);
  }

  let tempGuardEnv = null;
  if (asBool(config.stableTempDir, DEFAULTS.stableTempDir)) {
    try {
      tempGuardEnv = linkStableTemp(env, run);
      notes.push(tempGuardEnv ? `temp path shown as ${tempGuardEnv.PAPERCLIP_TMP_STABLE}` : "temp path per run (another run uses the link, or no Paperclip scratch folder)");
    } catch (err) {
      notes.push(`temp path per run (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Output cap. A value already in the agent's env wins.
  if (envValue(env, "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")) {
    notes.push(`output cap ${envValue(env, "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX")} (agent env)`);
  } else if (asBool(config.raiseOutputCap, DEFAULTS.raiseOutputCap)) {
    const manual = asPositiveInt(config.outputTokenCap);
    const auto = info?.output
      ? Math.min(info.output, DEFAULTS.autoOutputCapMax, info.context ? Math.floor(info.context / 2) : Infinity)
      : DEFAULTS.autoOutputCapMax;
    const cap = manual ?? auto;
    env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(cap);
    notes.push(`output cap ${cap}${manual ? "" : " (auto)"}`);
  } else {
    notes.push("output cap 32000 (OpenCode default)");
  }

  // Inline OpenCode config, merged over the global opencode.json by OpenCode.
  const inline = parseJsonObject(envValue(env, "OPENCODE_CONFIG_CONTENT") ?? "");
  const compaction = { ...(inline.compaction ?? {}) };
  const guardEnv = {};
  if (asBool(config.compaction, DEFAULTS.compaction) && info?.context) {
    // Without an input limit OpenCode compacts at "context minus output cap",
    // close to 1M tokens on these models. With one it compacts at "input limit
    // minus reserved", so this puts the trigger at the threshold.
    const at = Math.max(MIN_COMPACT_AT, asPositiveInt(config.compactAtTokens) ?? DEFAULTS.compactAtTokens);
    const input = Math.min(info.context, at + COMPACTION_RESERVED);
    compaction.auto = true;
    compaction.reserved = COMPACTION_RESERVED;
    const provider = { ...(inline.provider ?? {}) };
    const cloud = { ...(provider["ollama-cloud"] ?? {}) };
    const models = { ...(cloud.models ?? {}) };
    models[modelId] = {
      ...(models[modelId] ?? {}),
      limit: { context: info.context, output: info.output || DEFAULTS.autoOutputCapMax, input },
    };
    provider["ollama-cloud"] = { ...cloud, models };
    inline.provider = provider;
    guardEnv.PAPERCLIP_COMPACTION_STOP_WHEN_DONE = "1";
    notes.push(`compaction at ${input - COMPACTION_RESERVED} tokens`);
  } else {
    notes.push("compaction OpenCode default (near the full context)");
  }
  if (asBool(config.pruneToolOutputs, DEFAULTS.pruneToolOutputs)) {
    compaction.prune = true;
    notes.push("prune old tool outputs");
  }
  if (Object.keys(compaction).length > 0) inline.compaction = compaction;

  if (asBool(config.loopGuard, DEFAULTS.loopGuard)) {
    const repeats = Math.max(2, asPositiveInt(config.loopGuardRepeats) ?? DEFAULTS.loopGuardRepeats);
    guardEnv.PAPERCLIP_LOOP_GUARD_REPEATS = String(repeats);
    notes.push(`loop guard at ${repeats} identical calls`);
  } else {
    notes.push("loop guard off");
  }
  if (tempGuardEnv) Object.assign(guardEnv, tempGuardEnv);
  if (Object.keys(guardEnv).length > 0) {
    try {
      installGuards(env);
      Object.assign(env, guardEnv);
    } catch (err) {
      notes.push(`guards plugin not installed, loop guard, compaction stop and stable temp path inactive (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (Object.keys(inline).length > 0) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
  next.env = env;
  return { config: next, note: `[ollama-cloud] ${modelId}: ${notes.join("; ")}.` };
}

export const runSettingsFields = [
  {
    key: "stableTempDir",
    label: "Keep the prompt cache across runs",
    type: "toggle",
    default: DEFAULTS.stableTempDir,
    hint: "Paperclip gives every run a new temporary folder and removes it when the run ends. OpenCode puts that folder's path into the bash tool's description near the start of every request, so a new path on each wake made Ollama's prompt cache miss for the whole resumed session. On shows the model a fixed link per agent and issue that points at the current run's folder instead. The temporary folder and its cleanup stay exactly as Paperclip handles them.",
  },
  {
    key: "reasoningEffort",
    label: "Reasoning effort",
    type: "select",
    default: DEFAULTS.reasoningEffort,
    options: [
      { label: "High (recommended)", value: "high" },
      { label: "Max", value: "max" },
      { label: "Medium", value: "medium" },
      { label: "Low", value: "low" },
      { label: "Auto (server default)", value: "auto" },
    ],
    hint: "How long the model may think. A value the model does not offer becomes the nearest one it does (GLM, Kimi and DeepSeek have no Medium; Gemma, gpt-oss and Nemotron have no Max). Auto sends nothing and leaves it to Ollama's default, which has produced 32k-token replies of pure reasoning and noticeably higher usage. Low degrades some GLM models. This replaces the form's Thinking effort field, which this adapter ignores.",
  },
  {
    key: "raiseOutputCap",
    label: "Raise OpenCode's output cap",
    type: "toggle",
    default: DEFAULTS.raiseOutputCap,
    hint: "OpenCode cuts every reply at 32,000 tokens; a long reasoning reply then fails and is retried from scratch. On lifts the cap to the value below. Off keeps 32,000, which also limits how much one runaway reply can cost.",
  },
  {
    key: "outputTokenCap",
    label: "Output cap (tokens)",
    type: "number",
    hint: "Empty means auto: the model's own output limit, at most 131,072 and at most half its context. Only used when the cap is raised.",
  },
  {
    key: "compaction",
    label: "Compact long sessions",
    type: "toggle",
    default: DEFAULTS.compaction,
    hint: "Off keeps OpenCode's default, which compacts only when the context is nearly full (around 900k tokens on most of these models). On summarises the session once it passes the threshold below. Each resumed run resends the whole session, so a smaller session costs less on every request, at the price of detail from earlier turns. After a compaction OpenCode keeps working only when the model was still mid-task.",
  },
  {
    key: "compactAtTokens",
    label: "Compact at (tokens)",
    type: "number",
    default: DEFAULTS.compactAtTokens,
    hint: "Session size that triggers compaction (minimum 50,000). Fresh sessions start around 30k tokens; long runs reach 200k to 400k. Lower saves more and forgets more.",
  },
  {
    key: "pruneToolOutputs",
    label: "Prune old tool outputs",
    type: "toggle",
    default: DEFAULTS.pruneToolOutputs,
    hint: "OpenCode's prune option: drops the output of old tool calls (file reads, build logs) from the session. Saves tokens on long runs; the agent has to re-read a file it needs again.",
  },
  {
    key: "loopGuard",
    label: "Loop guard",
    type: "toggle",
    default: DEFAULTS.loopGuard,
    hint: "Refuses a tool call that repeats the previous calls exactly (same tool, same arguments) and tells the model to change approach or report the blocker. Ordinary edit and test cycles are not affected.",
  },
  {
    key: "loopGuardRepeats",
    label: "Loop guard: identical calls in a row",
    type: "number",
    default: DEFAULTS.loopGuardRepeats,
    hint: "The call that would make this many identical calls in a row is refused (minimum 2).",
  },
];
