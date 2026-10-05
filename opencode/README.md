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
are paid by the Ollama subscription rather than a connected provider account.

## Usage limits

Before each run the adapter checks `https://ollama.com/api/usage`. If the 5 hour session limit or
the weekly limit is spent, OpenCode is not started: the run ends as `provider_quota` with proof
that no provider work started, and Paperclip schedules a retry 2 minutes after the next reset.

The reset times are computed, because Ollama's API does not report them. The resets are global, the
same moment for every account: the session meter resets whenever `unix time % 18000 == 0` (every
5 hours from the Unix epoch), and the weekly meter resets at Monday 00:00 UTC. When a meter is
still spent within 30 minutes after a reset, the adapter retries 15 minutes later instead of
waiting a whole window.

Paperclip retries a failed run twice, then blocks the issue. A limit that runs out in the middle of
a run blocks the issue for review like an ordinary failure, because OpenCode may have
half-finished actions; the adapter can only prove that nothing started before the run.

The costs page shows both meters with their reset times.

The environment test normally runs OpenCode's hello probe. With a spent limit, that probe retries
HTTP 429 until it times out and reports a misleading timeout, so the test replaces its result with
a limit warning and keeps the other checks.

## Requirements

- The official Paperclip Docker image (ghcr.io/paperclipai/paperclip): the adapter imports the
  image's built-in `opencode-local` adapter from `/app/packages`. A different location can be set
  with the env var `PAPERCLIP_APP_DIR`.
- The Paperclip server must run under its tsx loader, so that the image's TypeScript sources can be
  imported. The official image does this.
- `OLLAMA_API_KEY` in the agent's env (a Paperclip secret reference) or in the container env.
- An Ollama Cloud plan with session and weekly limits.

## Install

In the Paperclip UI, open the instance settings, then Adapters, and install the package by name:

    @joly0/paperclip-adapter-opencode-ollama-cloud

To update to a newer version, use Reinstall. Then pick the adapter `opencode_ollama_cloud` for an
agent and choose a model. The agent form has no env field for external adapters: either set
`OLLAMA_API_KEY` in the container env, or add `env.OLLAMA_API_KEY` to the agent's `adapterConfig`
through the API as a secret reference.

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
- Ollama's reset schedule is not officially documented; the computed times follow the schedule
  observed on ollama.com (see ollama/ollama#12532).

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE).