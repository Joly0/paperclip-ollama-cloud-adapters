# @joly0/paperclip-adapter-opencode-ollama-cloud

An external adapter for [Paperclip](https://github.com/paperclipai/paperclip), a self-hosted agent
orchestration server. It runs OpenCode on Ollama Cloud models and retries issues shortly after a
spent session or weekly limit resets.

Source and issues: https://github.com/Joly0/paperclip-ollama-cloud-adapters

## What it does

The adapter type is `opencode_ollama_cloud`. Agents with this type run OpenCode on Ollama Cloud
models; model ids start with `ollama-cloud/`, for example `ollama-cloud/glm-5.3`.

Because the adapter type is in none of Paperclip's AI connection adapter lists, Paperclip never
attaches an OpenRouter connection to these agents. They can be created and edited in the UI, which
shows the type string as the adapter's name.

The model dropdown lists OpenCode's `ollama-cloud/` models that `ollama.com/v1/models` still
serves: OpenCode's own catalogue lags behind and keeps retired models. If the server's model list
cannot be fetched, the unfiltered OpenCode list is shown.

Runs are reported with biller `ollama-cloud` and billing type `subscription_included`, because they
are paid by the Ollama subscription rather than a connected provider account. A run that starts
while a limit is spent and goes on to prepaid usage credits is labelled billing type `credits`
instead (see Usage limits).

## Agent settings

The agent form shows Paperclip's generic local-adapter settings: model, thinking effort,
environment variables including Paperclip secret references, command and extra args under
Advanced, and timeout and interrupt grace period. The adapter adds these fields of its own.

- 'Skip permissions' (`adapterConfig` key `dangerouslySkipPermissions`, default on; unset counts as
  on, like `opencode_local`). It lets OpenCode access directories outside the workspace without
  asking, since unattended runs cannot answer permission prompts.
- 'Keep the prompt cache across runs' (`stableTempDir`, default on). Paperclip gives every run a
  new temporary folder (TMPDIR) and removes it when the run ends. OpenCode writes that path into
  the bash tool's description, which comes before the conversation in every request, so each
  resumed run missed Ollama's prompt cache for its whole history. With the setting on, the adapter
  keeps a link `/tmp/paperclip-opencode/<agent id>/<issue id>` pointing at the current run's
  folder, and guards.js shows the model the link instead. TMPDIR, the folder and Paperclip's
  cleanup are unchanged. If another run on the same issue still uses the link, the new run keeps
  the per-run path. Links whose folder is gone are removed after a day. Measured in Paperclip: a
  resumed run's first request went from about 8k of 45k prompt tokens cached to 40.5k of 45k.
- 'Agent instructions in the system prompt' (`instructionsInSystemPrompt`, default on). Paperclip's
  OpenCode adapter pastes the agent's whole AGENTS.md in front of every wake message, also when a
  session is resumed, so each wake adds another uncached copy (about 2k tokens for a typical
  file) to the session, and every later request resends all of them. With the setting on, the
  adapter passes the file to OpenCode's `instructions` option instead, which puts it into the
  system prompt under an `Instructions from: <path>` header: read fresh on every run, cached with
  the tool definitions, never repeated, and kept across compaction. Remote runs, a relative
  instructions path and an unreadable file keep Paperclip's behaviour. The first wake of an
  existing session after switching misses the cache once, because the system prompt changed.
- 'Keep the prompt cache warm between wakes' (`cacheKeepalive`, default on), with 'Keepalive
  interval (minutes)' (`keepaliveIntervalMinutes`, default 4) and 'Keepalive for at most
  (minutes)' (`keepaliveForMinutes`, default 30). Ollama drops a cached prompt after a few
  minutes: measured on 2026-10-07, about 5 to 10 minutes for glm-5.3, 15 for
  deepseek-v4.1-flash and 30 to 60 for kimi-k3. A wake that comes later resends the whole
  session uncached. With the setting on, OpenCode reaches Ollama through a small proxy that the
  adapter runs inside Paperclip's server process on 127.0.0.1. It forwards every request
  unchanged and remembers the agent's last request per agent and issue. After the run it repeats
  that request with a one-token reply at the interval, which reads the whole session from the
  cache and costs almost nothing. The pings stop when the next run on the issue starts, after
  the maximum time, when a plan limit is spent (pings never use usage credits) or when one fails.
  The next run's log says how many pings kept the cache warm. The default interval stays below
  the shortest lifetime measured, so new models need no tuning; raise it only for a model known
  to keep its cache longer. Remote runs, runs without an issue and agents that set their own
  `ollama-cloud` `baseURL` go straight to Ollama.
- 'Reasoning effort' (`reasoningEffort`, default High; other choices Max, Medium, Low and Auto).
  The choice is mapped to the nearest reasoning variant the chosen model offers; a tie goes to the
  higher one, and a model that offers no variants gets no variant sent. Auto sends nothing and
  leaves reasoning to the server default. An explicit `variant` set through the API wins over this
  field. The form's own Thinking effort field is ignored. Whether a level has an effect depends on
  the model: GLM, Kimi and DeepSeek have no Medium, Gemma, gpt-oss and Nemotron have no Max, and
  Low degrades some GLM models.
- 'Keep running on usage credits' (`keepRunningOnCredits`, default off). Your Ollama plan has a
  5 hour session limit and a weekly limit on older (legacy) plans, a monthly allowance on newer
  ones; when one is used up, Ollama charges further requests to your prepaid usage credits, which are paid per
  token and listed with their cost in the Ollama dashboard. Off: the agent waits for the limit to
  reset and never spends credits. On: it keeps working and spends credits; if they run out, the run
  is retried after the reset. See Usage limits.
- 'Raise OpenCode's output cap' (`raiseOutputCap`, default on). Sets
  `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` in the run's env; a value already in the agent env
  wins. 'Output cap (tokens)' (`outputTokenCap`) only applies when the cap is raised and overrides
  the automatic value; empty means auto: the model's own output limit, at most 131072 and at most
  half its context. Off keeps OpenCode's 32000-token cap, which also limits how much one runaway
  reply can cost.
- 'Compact long sessions' (`compaction`, default off). Off keeps OpenCode's default, which
  compacts only when the context is nearly full (around 900k tokens on most of these models). On:
  the session is summarised once it passes the size set by 'Compact at (tokens)'
  (`compactAtTokens`, default 200000, minimum 50000; fresh sessions start around 30k tokens, long
  runs reach 200k to 400k; lower saves more and forgets more). The setting works by giving the
  model an input limit so OpenCode's own compaction trigger fires there. After a compaction
  OpenCode keeps working only when the model was still mid-task. Each resumed run resends the
  whole session, so a smaller session costs less on every request, at the price of detail from
  earlier turns.
- 'Prune old tool outputs' (`pruneToolOutputs`, default off). OpenCode's prune option: drops the
  output of old tool calls (file reads, build logs) from the session. Saves tokens on long runs;
  the agent has to re-read a file it needs again.
- 'Loop guard' (`loopGuard`, default on) and 'Loop guard: identical calls in a row'
  (`loopGuardRepeats`, default 3, minimum 2). The call that would make this many identical calls in
  a row (same tool, same arguments) is refused, and the refusal returns to the model as the tool's
  error, so it can change approach or report the blocker. Ordinary edit and test cycles are not
  affected.

## Usage controls

The settings above exist because unattended runs on Ollama Cloud models can spend a lot without
anyone watching. They apply to the run only; nothing global changes.

OpenCode 1.18 cuts every reply at 32000 tokens. A long reasoning reply that hits the cap ends the run
without a result, so the reasoning is paid for and the work has to be started again; raising the
output cap removes that ceiling. The 'Auto' choice of Reasoning effort is the other extreme: it sends no
variant, leaves reasoning to the server default, and that default has produced 32k-token replies of
pure reasoning with noticeably higher usage.

Every resumed run resends the whole session, so a smaller session costs less on every request.
Compaction summarises the session at the chosen size and pruning drops old tool outputs; both
trade detail from earlier turns for lower usage.

The prompt cache only helps while the start of the request stays byte-identical. Besides the temp
path, an MCP server that connects in one run and not the next changes the tool list and has the
same effect.

The loop guard exists because a model can get stuck repeating the same tool call and burn quota on
calls that cannot give a different result; the guard refuses those calls and returns an error to
the model instead. The compaction stop keeps OpenCode from spending extra requests on a pointless
continuation after a compaction that followed the model's final answer. The stable temp path guard
rewrites the bash tool's description through OpenCode's `tool.definition` hook, replacing
`PAPERCLIP_TMP_RUN` (the run's temp folder) with `PAPERCLIP_TMP_STABLE` (the stable link from
'Keep the prompt cache across runs'). All three guards live in guards.js, an OpenCode plugin the
adapter installs. OpenCode 1.18 ignores file:// plugin entries in its config, so the adapter writes
the file directly into OpenCode's config folder as plugins/paperclip-guards.js
(`$XDG_CONFIG_HOME/opencode`, by default `~/.config/opencode`). Paperclip copies that folder into
each run, so OpenCode loads the guards from there. Each guard is inert unless the run's env enables
it, which keeps them per-agent settings.

Each run's stderr starts with one `[ollama-cloud] <model>: ...` line listing the applied settings,
so the transcript shows what was in effect.

## Run view

OpenCode prints its progress as JSON events. The package ships a transcript parser
(`ui-parser.cjs`, a port of Paperclip's built-in `opencode_local` parser, declared through
`exports["./ui-parser"]` and `paperclip.adapterUiParser` in `package.json`), so the run view shows
assistant text, reasoning, tool calls with their results and per-step token usage instead of raw
JSON.

The adapter also reports a `tool_call` or `assistant` run event for each matching OpenCode event,
so the live line on the task page shows the current tool or the last assistant text. Paperclip's
built-in `opencode_local` adapter does not report these. Paperclip keeps the live line in memory
for about 90 seconds and does not store it; the transcript is the history.

## Usage limits

Before each run the adapter checks `https://ollama.com/api/balance`, documented at
`https://docs.ollama.com/api/balance`. The balance API allows 10 requests per minute per user.
Plans with session and weekly limits report `remaining_percent` and `resets_at` per meter, newer
plans a monthly allowance instead (`balance_usd` of `allowance_usd`, reset at `period.until`), and
both report the purchased usage credits (`purchased.balance_usd`). If a limit is spent, OpenCode is
not started: the run ends as `provider_quota` with proof that no provider work started, and
Paperclip schedules a retry 2 minutes after the reset time the API reports. This is the behaviour
with 'Keep running on usage credits' off.

With 'Keep running on usage credits' on, a spent limit does not stop the run: OpenCode starts
anyway, Ollama bills its requests to the account's prepaid usage credits, and a run that starts on
a spent limit is labelled billing type `credits` instead of `subscription_included`. The agent runs
on credits only while the purchased balance is above zero; when the balance reports zero, the run
is not started and is retried at the reset. With credits on, a failure is not proof that a limit is
spent, so a failed run is treated as a limit only when the error looks like a refused request:
HTTP 429, rate limit, quota, credit, payment and similar messages.

If the balance cannot be read, a spent limit is still recognised from Ollama's refusal of a
request: HTTP 429 with "you (...) have reached your session usage limit" (or weekly).

The computed schedule is only a fallback, used when the API reports no reset time. Its resets are
global, the same moment for every account: the session meter resets whenever `unix time % 18000 == 0`
(every 5 hours from the Unix epoch), and the weekly meter resets at Monday 00:00 UTC. When a meter
is still spent within 30 minutes after a reset, the adapter retries 15 minutes later instead of
waiting a whole window.

Paperclip retries a failed run twice, then blocks the issue. A limit that runs out in the middle of
a run is retried at the reset as well. Paperclip normally blocks a failed run unless the adapter
proves that no work started, so for this case the adapter reports that evidence although OpenCode
has worked. This is a deliberate trade-off: a limit stops OpenCode at its next model request, after
earlier tool calls have finished, and the retry resumes the same OpenCode session instead of
replaying anything. Without it, every mid-run limit hit would need a manual comment to continue.

The costs page shows the session, weekly or monthly meters with their reset times and the credits
left.

The environment test normally runs OpenCode's hello probe. With a spent limit, that probe retries
HTTP 429 until it times out and reports a misleading timeout, so the test replaces its result with
a limit warning and keeps the other checks. With credits on, the probe runs as usual and the test
adds an info check noting that runs use usage credits until the limit resets.

## Requirements

- The official Paperclip Docker image (ghcr.io/paperclipai/paperclip): the adapter imports the
  image's built-in `opencode-local` adapter from `/app/packages`. A different location can be set
  with the env var `PAPERCLIP_APP_DIR`.
- The Paperclip server must run under its tsx loader, so that the image's TypeScript sources can be
  imported. The official image does this.
- `OLLAMA_API_KEY` in the agent's env (a Paperclip secret reference) or in the container env.
- An Ollama Cloud plan with usage limits (a 5 hour session limit and a weekly limit on older
  (legacy) plans, a monthly allowance on newer ones).

## Install

In the Paperclip UI, open the instance settings, then Adapters, and install the package by name:

    @joly0/paperclip-adapter-opencode-ollama-cloud

To update to a newer version, use Reinstall. Then pick the adapter `opencode_ollama_cloud` for an
agent and choose a model. Set `OLLAMA_API_KEY` in the agent's environment variables, ideally as a
Paperclip secret reference, or in the container env.

Ollama Cloud serialises concurrent sessions on one model, so give parallel agents different models.

## Testing the limit handling

Create a file named `.simulate-quota` in the installed package folder
(`<Paperclip home>/adapter-plugins/node_modules/@joly0/paperclip-adapter-opencode-ollama-cloud/`,
which is `/paperclip/...` in the official image), containing `session` or `weekly` and optionally a
retry delay in minutes:

    weekly 10

Every usage check then reports that meter as spent: runs do not start, and retries happen after
the delay instead of the real reset. The default delay is 5 minutes. The file is read on each
check, so no restart is needed. Delete it afterwards to return to real usage.

## Caveats

- External adapter loading in Paperclip is new and can change between versions.
- The adapter depends on the image's source layout (package paths and exports) and can break on
  upstream updates of Paperclip.
- The computed fallback reset schedule is not officially documented; it follows the schedule
  observed on ollama.com (see ollama/ollama#12532).

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE).