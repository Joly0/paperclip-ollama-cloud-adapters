// OpenCode plugin installed by the adapter (see run-settings.js). Each guard
// is inert unless the run's env enables it, which the adapter does per agent.
//
// Loop guard (PAPERCLIP_LOOP_GUARD_REPEATS): refuses a tool call that would
// repeat the previous calls exactly, so a model stuck in a loop gets an error
// back instead of burning quota on the same call. The refusal reaches the
// model as the tool's error, so it can change approach.
//
// Compaction stop (PAPERCLIP_COMPACTION_STOP_WHEN_DONE): after compacting,
// OpenCode adds "Continue if you have next steps" and runs the model again.
// When the compaction followed the model's final answer that only costs extra
// requests (in testing the model re-read files it had already summarised), so
// the continuation is kept only when the model was still mid-task.
//
// Stable temp path (PAPERCLIP_TMP_RUN, PAPERCLIP_TMP_STABLE): OpenCode puts
// the run's temp folder into the bash tool's description. Paperclip makes a
// new one per run, which changed the start of every request and made resumed
// sessions miss the prompt cache. Descriptions show the adapter's fixed link
// to the same folder instead; the folder itself is unchanged.

const REPEATS = Number(process.env.PAPERCLIP_LOOP_GUARD_REPEATS) || 0;
const STOP_WHEN_DONE = process.env.PAPERCLIP_COMPACTION_STOP_WHEN_DONE === "1";
const TMP_RUN = process.env.PAPERCLIP_TMP_RUN || "";
const TMP_STABLE = process.env.PAPERCLIP_TMP_STABLE || "";

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const PaperclipGuards = async () => {
  const hooks = {};
  if (REPEATS >= 2) {
    const lastCall = new Map();
    hooks["tool.execute.before"] = async (input, output) => {
      const key = `${input.tool}\u0000${stableStringify(output?.args ?? {})}`;
      const previous = lastCall.get(input.sessionID);
      const count = previous && previous.key === key ? previous.count + 1 : 1;
      lastCall.set(input.sessionID, { key, count });
      if (count >= REPEATS) {
        throw new Error(
          `Loop guard: this is call ${count} in a row of ${input.tool} with identical arguments, and repeating it will not give a different result. Do something different: change the command or its arguments, inspect the cause, or stop and report what is blocking you.`,
        );
      }
    };
  }
  if (STOP_WHEN_DONE) {
    // The hook's own input does not say how the model's last reply ended, so
    // remember it from the session events; compaction summaries are skipped.
    const lastFinish = new Map();
    hooks.event = async ({ event }) => {
      if (event?.type !== "message.updated") return;
      const info = event.properties?.info;
      if (info?.role !== "assistant" || info.summary || !info.finish) return;
      lastFinish.set(info.sessionID, info.finish);
    };
    hooks["experimental.compaction.autocontinue"] = async (input, output) => {
      if (input?.overflow) return;
      if (lastFinish.get(input?.sessionID) === "stop") output.enabled = false;
    };
  }
  if (TMP_RUN && TMP_STABLE) {
    hooks["tool.definition"] = async (_input, output) => {
      if (typeof output?.description === "string" && output.description.includes(TMP_RUN)) {
        output.description = output.description.split(TMP_RUN).join(TMP_STABLE);
      }
    };
  }
  return hooks;
};
