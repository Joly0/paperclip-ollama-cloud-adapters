// Transcript parser for Paperclip's run view: turns OpenCode's `--format json`
// lines into transcript entries (assistant text, reasoning, tool calls and
// results, step usage, errors).
//
// Port of Paperclip's built-in opencode_local parser
// (packages/adapters/opencode-local/src/ui/parse-stdout.ts), which the UI only
// applies to the built-in adapter type. Paperclip serves this file to the
// browser and evaluates it in a sandboxed worker through `new Function`, so it
// must stay a single file without imports, written CommonJS style: an ESM
// `export` would be a syntax error there.

"use strict";

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value) {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const msg = asString(rec.message) || asString(data && data.message) || asString(rec.name) || "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseToolUse(parsed, ts) {
  const part = asRecord(parsed.part);
  if (!part) return [{ kind: "system", ts, text: "tool event" }];

  const toolName = asString(part.tool, "tool");
  const state = asRecord(part.state);
  const input = (state && state.input) ?? {};
  const callEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    toolUseId: asString(part.callID) || asString(part.id) || undefined,
    input,
  };

  const status = asString(state && state.status);
  if (status !== "completed" && status !== "error") return [callEntry];

  const rawOutput =
    asString(state && state.output) ||
    asString(state && state.error) ||
    asString(part.title) ||
    `${toolName} ${status}`;

  const metadata = asRecord(state && state.metadata);
  const headerParts = [`status: ${status}`];
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) headerParts.push(`${key}: ${value}`);
    }
  }
  const content = `${headerParts.join("\n")}\n\n${rawOutput}`.trim();

  return [
    callEntry,
    {
      kind: "tool_result",
      ts,
      toolUseId: asString(part.callID) || asString(part.id, toolName),
      content,
      isError: status === "error",
    },
  ];
}

function parseStdoutLine(line, ts) {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part && part.text).trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = asString(part && part.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool_use") return parseToolUse(parsed, ts);

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    return [{ kind: "system", ts, text: `step started${sessionId ? ` (${sessionId})` : ""}` }];
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part && part.tokens);
    const cache = asRecord(tokens && tokens.cache);
    const reason = asString(part && part.reason, "step");
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: asNumber(tokens && tokens.input, 0),
        outputTokens: asNumber(tokens && tokens.output, 0) + asNumber(tokens && tokens.reasoning, 0),
        cachedTokens: asNumber(cache && cache.read, 0),
        costUsd: asNumber(part && part.cost, 0),
        subtype: reason,
        isError: false,
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

// The parser keeps no state between lines, so the factory only wraps it.
function createStdoutParser() {
  return { parseLine: parseStdoutLine, reset() {} };
}

module.exports = { parseStdoutLine, createStdoutParser };
