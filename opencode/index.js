// Paperclip external adapter: OpenCode pinned to Ollama Cloud.
//
// Wraps the built-in opencode_local adapter from the Paperclip image. Because
// the adapter type is in no AI connection's adapter list, Paperclip never
// attaches an OpenRouter connection to these agents, so they can be created
// and edited in the UI. The UI shows the type string as the adapter's name.
//
// Limit handling lives in ollama-quota.js so other harnesses can reuse it.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Paperclip reloads an adapter by importing index.js under a cache-busting
// query; passing the same query on keeps this module from being served stale.
const {
  apiKeyFor,
  fetchUsage,
  getQuotaWindows,
  ollamaGet,
  quotaConfigDoc,
  quotaFields,
  retryAt,
  spentMeter,
} = await import(new URL(`./ollama-quota.js${new URL(import.meta.url).search}`, import.meta.url).href);
const { applyRunSettings, runSettingsFields } = await import(
  new URL(`./run-settings.js${new URL(import.meta.url).search}`, import.meta.url).href
);

const TYPE = "opencode_ollama_cloud";
const MODEL_PREFIX = "ollama-cloud/";

const APP_DIR = process.env.PAPERCLIP_APP_DIR || "/app";

// Resolve a workspace package's export to a file inside the image. The plugin
// lives outside /app, so bare specifiers would not resolve from here. The
// server runs under the tsx loader, so importing .ts sources works.
async function importAppPackage(pkgDir, subpath) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const target = pkg.exports?.[subpath];
  if (typeof target !== "string") {
    throw new Error(`${pkg.name} has no "${subpath}" export; the Paperclip image layout changed`);
  }
  return import(pathToFileURL(path.join(pkgDir, target)).href);
}

const openCodePkg = path.join(APP_DIR, "packages/adapters/opencode-local");
const oc = await importAppPackage(openCodePkg, "./server");
const ocMeta = await importAppPackage(openCodePkg, ".");
const adapterUtils = await importAppPackage(path.join(APP_DIR, "packages/adapter-utils"), ".");

// Once a plan limit is spent, Ollama bills further requests to the account's
// prepaid usage credits; /api/usage still reports the limit as spent and shows
// no balance. Agents with this setting keep running on those credits.
function usesCredits(config) {
  const value = config?.keepRunningOnCredits;
  return value === true || value === "true";
}

// With credits a failure is not proof of a spent limit, so only an error that
// looks like a refused request (credits used up) is treated as one.
const LIMIT_ERROR = /\b429\b|rate.?limit|quota|credit|usage limit|insufficient|payment|billing/i;

function failedResult(errorMessage, errorCode) {
  return { exitCode: 1, signal: null, timedOut: false, errorMessage, errorCode };
}

// The task page's live line ("Using <tool>", last assistant text) comes from
// run events that adapters report through ctx.onEvent; OpenCode's built-in
// adapter reports none. This passes every chunk on to ctx.onLog unchanged and
// reports a `tool_call` or `assistant` event for each complete OpenCode JSON
// line, the same pattern Paperclip's kimi_local adapter uses.
function openCodeLiveEvents(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  const part = event && typeof event.part === "object" && event.part !== null ? event.part : {};
  if (event?.type === "tool_use" && typeof part.tool === "string" && part.tool) {
    return [{ eventType: "tool_call", payload: { toolName: part.tool } }];
  }
  if (event?.type === "text" && typeof part.text === "string" && part.text.trim()) {
    const content = part.text.trim();
    return [{ eventType: "assistant", message: content, payload: { content } }];
  }
  return [];
}

function createLiveEventLog(onLog, onEvent) {
  if (!onEvent) return { log: onLog, flush: async () => {} };
  let buffer = "";
  const emitLine = async (raw) => {
    const line = raw.trim();
    if (!line) return;
    for (const event of openCodeLiveEvents(line)) {
      try {
        await onEvent({ stream: "stdout", ...event });
      } catch {
        // Live status is cosmetic; never let it fail the run.
      }
    }
  };
  return {
    log: async (stream, chunk) => {
      await onLog(stream, chunk);
      if (stream !== "stdout") return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await emitLine(line);
      }
    },
    flush: async () => {
      const rest = buffer;
      buffer = "";
      await emitLine(rest);
    },
  };
}

// Reasoning effort, output cap, compaction and loop guard (run-settings.js).
async function withRunSettings(ctx) {
  const { config, note } = await applyRunSettings(ctx.config ?? {});
  return { ctx: { ...ctx, config }, note };
}

async function execute(rawCtx) {
  const { ctx, note } = await withRunSettings(rawCtx);
  const model = String(ctx.config?.model ?? "").trim();
  if (!model.startsWith(MODEL_PREFIX)) {
    return failedResult(
      `Model "${model}" is not an Ollama Cloud model; pick one starting with "${MODEL_PREFIX}".`,
      "ollama_cloud_invalid_model",
    );
  }
  const apiKey = apiKeyFor(ctx.config);
  if (!apiKey) {
    return failedResult(
      "OLLAMA_API_KEY is not set: add it to the agent's env (a secret reference) or the container env.",
      "ollama_cloud_missing_key",
    );
  }

  const credits = usesCredits(ctx.config);
  const usage = await fetchUsage(apiKey);
  const before = spentMeter(usage);
  if (before && credits) {
    await ctx.onLog("stderr", `[ollama-cloud] The ${before} limit is spent; this run uses usage credits.\n`);
  } else if (before) {
    const fields = quotaFields(before, Boolean(usage?.simulated));
    await ctx.onLog("stderr", `[ollama-cloud] ${fields.errorMessage} OpenCode was not started.\n`);
    // Without this evidence Paperclip treats the run as possibly having acted
    // and blocks the issue for review instead of scheduling the retry.
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      ...fields,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }

  // OpenCode guesses the biller from the env and picks OpenRouter whenever
  // OPENROUTER_API_KEY is set; these runs are paid by the Ollama subscription.
  await ctx.onLog("stderr", `${note}\n`);
  const live = createLiveEventLog(ctx.onLog, ctx.onEvent);
  let executed;
  try {
    executed = await oc.execute({ ...ctx, onLog: live.log });
  } finally {
    await live.flush();
  }
  const result = {
    ...executed,
    biller: "ollama-cloud",
    billingType: before && credits ? "credits" : "subscription_included",
  };
  const failed = result.exitCode !== 0 || result.timedOut || Boolean(result.errorMessage);
  if (!failed || ctx.signal?.aborted || result.errorFamily === "provider_quota") return result;

  // A limit hit mid-run surfaces as an ordinary OpenCode failure; the usage
  // endpoint tells whether that is what happened.
  //
  // Deliberate trade-off, chosen by the owner: the result claims bootstrap
  // evidence (providerWorkStarted: false) although OpenCode has worked, so that
  // Paperclip schedules the retry at the reset instead of blocking the issue.
  // The claim is literally false; it is defensible because a limit stops
  // OpenCode at its next model request, after earlier tool calls have settled,
  // and the retry resumes the kept OpenCode session (sessionParams below)
  // rather than replaying anything. Without it, every mid-run hit needs a
  // manual comment to continue.
  const afterUsage = await fetchUsage(apiKey);
  const after = spentMeter(afterUsage);
  if (!after) return result;
  if (credits && !LIMIT_ERROR.test(String(result.errorMessage ?? ""))) return result;
  const fields = quotaFields(after, Boolean(afterUsage?.simulated));
  await ctx.onLog(
    "stderr",
    `[ollama-cloud] ${fields.errorMessage} The limit ran out mid-run; the retry resumes the same OpenCode session.\n`,
  );
  return {
    ...result,
    ...fields,
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    errorMessage: `${fields.errorMessage} The limit ran out mid-run; the retry resumes the same OpenCode session. OpenCode said: ${result.errorMessage ?? "(no message)"}`,
  };
}

// With a spent limit OpenCode's hello probe retries HTTP 429 until it times
// out (60 s) and reports a misleading timeout. In that case the other checks
// still run, the probe is cut to 1 s and its result is replaced by a limit
// warning.
async function testEnvironment(rawCtx) {
  const { ctx } = await withRunSettings(rawCtx);
  const apiKey = apiKeyFor(ctx.config);
  if (!apiKey) {
    return {
      adapterType: TYPE,
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [{
        code: "ollama_cloud_missing_key",
        level: "error",
        message: "OLLAMA_API_KEY is not set in the agent's env or the container env.",
      }],
    };
  }

  const usage = await fetchUsage(apiKey);
  const meter = spentMeter(usage);
  if (!meter) return oc.testEnvironment(ctx);
  if (usesCredits(ctx.config)) {
    const result = await oc.testEnvironment(ctx);
    const checks = [...result.checks, {
      code: "ollama_cloud_on_credits",
      level: "info",
      message: `Ollama Cloud ${meter} limit is spent; runs use usage credits until it resets.`,
    }];
    return { ...result, adapterType: TYPE, checks };
  }

  const result = await oc.testEnvironment({ ...ctx, config: { ...ctx.config, helloProbeTimeoutSec: 1 } });
  const checks = result.checks.filter((check) => !check.code.startsWith("opencode_hello_probe"));
  checks.push({
    code: "ollama_cloud_quota_spent",
    level: "warn",
    message: `Ollama Cloud ${meter} limit is spent${usage.simulated ? " (simulated)" : ""}, so the hello probe was skipped.`,
    hint: `Runs start again by themselves: each issue is retried at ${retryAt(meter).at.toISOString()} (${retryAt(meter).reason}).`,
  });
  const status = checks.some((check) => check.level === "error") ? "fail" : "warn";
  return { ...result, adapterType: TYPE, status, checks };
}

// OpenCode's own model list, narrowed to Ollama Cloud models the server still
// serves (OpenCode's catalogue lags behind and keeps retired models).
async function fetchModels() {
  const all = await oc.listOpenCodeModels();
  const cloud = all.filter((m) => m.id.startsWith(MODEL_PREFIX));
  try {
    const served = await ollamaGet("/v1/models", process.env.OLLAMA_API_KEY || "");
    const ids = new Set((served?.data ?? []).map((m) => `${MODEL_PREFIX}${m.id}`));
    const live = cloud.filter((m) => ids.has(m.id));
    if (live.length > 0) return live;
  } catch {
    // Fall through to OpenCode's unfiltered list.
  }
  return cloud;
}

// Paperclip reads the static `models` field for the adapter's model count and
// as a fallback list, so it serves the last fetched list. It starts with the
// models Ollama Cloud served when this version was released and is refreshed
// in the background on load and on every model-list request.
const FALLBACK_MODEL_IDS = [
  "deepseek-v4-pro:0813", "deepseek-v4.1-flash", "gemma4:31b", "glm-5.2", "glm-5.3", "glm-5.3-flash",
  "gpt-oss:20b", "gpt-oss:120b", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3", "minimax-m2.7", "minimax-m3",
  "mistral-large-3:675b", "nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra",
];
let cachedModels = FALLBACK_MODEL_IDS.map((id) => ({ id: `${MODEL_PREFIX}${id}`, label: `${MODEL_PREFIX}${id}` }));

async function listModels() {
  const models = await fetchModels();
  if (models.length > 0) cachedModels = models;
  return models;
}

listModels().catch(() => {});

const agentConfigurationDoc = `# ${TYPE} agent configuration

Runs OpenCode on Ollama Cloud. Same fields as opencode_local, with these differences:

- \`model\` must start with \`${MODEL_PREFIX}\` (e.g. \`${MODEL_PREFIX}glm-5.3\`).
- \`reasoningEffort\` (high, max, medium, low or auto; default high) is mapped to the nearest variant the model
  offers and passed to OpenCode as \`--variant\`. A non-empty \`variant\` wins; the form's \`effort\` is ignored.
- \`raiseOutputCap\` (default true) and \`outputTokenCap\` (empty means the model's output limit, at most 131072 and
  half its context) set \`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX\` unless the agent env sets it.
- \`compaction\` (default false) and \`compactAtTokens\` (default 200000) make OpenCode compact at that session size;
  \`pruneToolOutputs\` (default false) sets OpenCode's \`compaction.prune\`.
- \`keepRunningOnCredits\` (default false) keeps running on prepaid usage credits once a plan limit is spent.
- \`loopGuard\` (default true) and \`loopGuardRepeats\` (default 3) refuse that many identical tool calls in a row.
${quotaConfigDoc}

Ollama Cloud serialises concurrent sessions on one model, so give parallel agents different models.

---

${ocMeta.agentConfigurationDoc ?? ""}`;

// Fields the generic agent form shows for this adapter. Model, env (with
// secret references), command, extra args, timeout and grace period come from
// the form itself (its thinking effort field is ignored, see reasoningEffort).
// This adds what opencode_local's own form has, plus run-settings.js's fields.
// Unset skip-permissions means on, matching opencode_local's runtime default.
const configSchema = {
  fields: [
    {
      key: "dangerouslySkipPermissions",
      label: "Skip permissions",
      type: "toggle",
      default: true,
      hint: "Allow OpenCode to access directories outside the workspace without asking. Unattended runs cannot answer permission prompts.",
    },
    {
      key: "keepRunningOnCredits",
      label: "Keep running on usage credits",
      type: "toggle",
      default: false,
      hint: "Your Ollama plan has a 5-hour session limit and a weekly limit. When one is used up, Ollama charges further requests to your prepaid usage credits (paid per token, listed with their cost in the Ollama dashboard). Off: this agent waits for the limit to reset and never spends credits. On: it keeps working and spends credits; if they run out, the run is retried after the reset.",
    },
    ...runSettingsFields,
  ],
};

export function createServerAdapter() {
  return {
    type: TYPE,
    runtimeToolDelivery: "environment",
    execute,
    testEnvironment,
    listSkills: oc.listOpenCodeSkills,
    syncSkills: oc.syncOpenCodeSkills,
    sessionCodec: oc.sessionCodec,
    sessionManagement: adapterUtils.getAdapterSessionManagement?.("opencode_local") ?? undefined,
    get models() {
      return cachedModels;
    },
    listModels,
    getQuotaWindows,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    agentConfigurationDoc,
    getConfigSchema: () => configSchema,
  };
}
