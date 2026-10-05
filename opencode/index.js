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

function failedResult(errorMessage, errorCode) {
  return { exitCode: 1, signal: null, timedOut: false, errorMessage, errorCode };
}

// Paperclip's agent form stores the thinking-effort choice as `variant` only
// for opencode_local; for any other adapter type it uses `effort`. OpenCode
// reads `variant`, so carry the form's value over unless `variant` is set.
function withOpenCodeConfig(ctx) {
  const config = ctx.config ?? {};
  const effort = typeof config.effort === "string" ? config.effort.trim() : "";
  const variant = typeof config.variant === "string" ? config.variant.trim() : "";
  if (!effort || variant) return ctx;
  return { ...ctx, config: { ...config, variant: effort } };
}

async function execute(rawCtx) {
  const ctx = withOpenCodeConfig(rawCtx);
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

  const usage = await fetchUsage(apiKey);
  const before = spentMeter(usage);
  if (before) {
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
  const result = {
    ...(await oc.execute(ctx)),
    biller: "ollama-cloud",
    billingType: "subscription_included",
  };
  const failed = result.exitCode !== 0 || result.timedOut || Boolean(result.errorMessage);
  if (!failed || ctx.signal?.aborted || result.errorFamily === "provider_quota") return result;

  // A limit hit mid-run surfaces as an ordinary OpenCode failure; the usage
  // endpoint tells whether that is what happened. OpenCode may have acted, so
  // no recovery evidence is added and Paperclip blocks the issue for review.
  const afterUsage = await fetchUsage(apiKey);
  const after = spentMeter(afterUsage);
  if (!after) return result;
  const fields = quotaFields(after, Boolean(afterUsage?.simulated));
  await ctx.onLog("stderr", `[ollama-cloud] ${fields.errorMessage}\n`);
  return {
    ...result,
    ...fields,
    errorMessage: `${fields.errorMessage} The limit ran out mid-run, so the issue needs a review. OpenCode said: ${result.errorMessage ?? "(no message)"}`,
  };
}

// With a spent limit OpenCode's hello probe retries HTTP 429 until it times
// out (60 s) and reports a misleading timeout. In that case the other checks
// still run, the probe is cut to 1 s and its result is replaced by a limit
// warning.
async function testEnvironment(rawCtx) {
  const ctx = withOpenCodeConfig(rawCtx);
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
async function listModels() {
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

const agentConfigurationDoc = `# ${TYPE} agent configuration

Runs OpenCode on Ollama Cloud. Same fields as opencode_local, with these differences:

- \`model\` must start with \`${MODEL_PREFIX}\` (e.g. \`${MODEL_PREFIX}glm-5.3\`).
- \`effort\` (the agent form's thinking effort for this adapter type) is passed to OpenCode as \`variant\`
  unless \`variant\` is set.
${quotaConfigDoc}

Ollama Cloud serialises concurrent sessions on one model, so give parallel agents different models.

---

${ocMeta.agentConfigurationDoc ?? ""}`;

// Fields the generic agent form shows for this adapter. Model, thinking effort,
// env (with secret references), command, extra args, timeout and grace period
// come from the form itself; this adds what opencode_local's own form has.
// Unset means on, matching opencode_local's runtime default.
const configSchema = {
  fields: [
    {
      key: "dangerouslySkipPermissions",
      label: "Skip permissions",
      type: "toggle",
      default: true,
      hint: "Allow OpenCode to access directories outside the workspace without asking. Unattended runs cannot answer permission prompts.",
    },
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
    models: [{ id: `${MODEL_PREFIX}glm-5.3`, label: `${MODEL_PREFIX}glm-5.3` }],
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
