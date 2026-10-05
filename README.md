# paperclip-ollama-cloud-adapters

External adapters for [Paperclip](https://github.com/paperclipai/paperclip), a self-hosted agent
orchestration server. Each package in this repo is an external Paperclip adapter that runs one
agent harness on Ollama Cloud models and handles Ollama Cloud's session and weekly usage limits:
before a run it checks the account's usage, it does not start the harness while a limit is spent,
and Paperclip retries right after the limit's next reset. There is one npm package per harness.

## Packages

| Folder | npm package | Adapter type | Status | Docs |
| --- | --- | --- | --- | --- |
| opencode | @joly0/paperclip-adapter-opencode-ollama-cloud | `opencode_ollama_cloud` | available | [opencode/README.md](opencode/README.md) |
| pi | - | `pi_ollama_cloud` | planned | - |

## Layout

- `shared/ollama-quota.js`: the harness-neutral limit logic used by every package (usage check,
  computed resets, retry times, quota windows).
- Each harness folder is an npm package whose `index.js` wraps Paperclip's built-in adapter for
  that harness.
- Inside the repo, each harness folder holds a symlink `ollama-quota.js -> ../shared/ollama-quota.js`.
  npm would not pack the symlink, so the publish workflow replaces it with a copy of the shared
  file before publishing: every published package is self-contained.

## Releasing

A release is a version bump: change `version` in `<harness>/package.json` and push to main. The
workflow `.github/workflows/publish-<harness>.yml` runs on pushes that touch that folder or
`shared/`, does a syntax check, and publishes only when that exact version is not on npm yet, so
ordinary commits run the checks and skip publishing.

Publishing uses npm trusted publishing (GitHub OIDC) with provenance, so no npm token is stored.
Trusted publishing is configured in the package settings on npmjs.com, so a new package needs one
manual first publish by a maintainer (`npm publish --provenance=false --access public` from the
package folder with the shared file copied in, confirmed with 2FA). Then add the trusted publisher
there: repository Joly0/paperclip-ollama-cloud-adapters, workflow file `publish-<harness>.yml`.

## Adding a harness

- A new folder with a `package.json`: own package name, adapter type `<harness>_ollama_cloud`.
- An `index.js` wrapping Paperclip's built-in adapter for that harness.
- The symlink `ollama-quota.js -> ../shared/ollama-quota.js`.
- A copy of an existing publish workflow with the folder name and paths changed.

## Requirements

The adapters run inside Paperclip and need the official Paperclip Docker image
(ghcr.io/paperclipai/paperclip), which ships the harnesses and the built-in adapters that the
packages wrap. See each package's README for its full requirements (import paths, env vars,
Ollama Cloud plan, install and update steps).

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE).