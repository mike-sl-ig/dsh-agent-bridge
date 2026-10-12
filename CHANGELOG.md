# Changelog

## 0.3.0

- **The model picker stops offering models that cannot do the job.** WorkBuddy's account catalog
  lists 55 models, and 12 of them are completion / NES-completion / internal engines that have no
  business in an agent picker. They are also exactly the entries with no `supportsToolCall`, so the
  recipe now says so instead of matching on names: `catalog.require: { supportsToolCall: true }`,
  plus `catalog.excludeIdPattern` for the stragglers. Measured on the live config: 54 → 42 models,
  with nothing usable dropped. A field is a better signal than a naming convention, and an
  uncompilable `excludeIdPattern` is a validation error rather than a filter that silently does
  nothing.
- **A failed run now says why.** Both shipped JSON agents report failure INSIDE the stream rather
  than on stderr — OpenCode and CodeBuddy both write
  `{"type":"error","error":{"type","message","status"}}` and exit 1 — so a failure used to read
  "(没有产出最终答案)" while the actual reason (a 401) sat unread in the raw log. The CLI's error is
  now normalized into `Error` / `ErrorCode`, printed as a table row in the report, carried in
  `last-run.json`, and shown in the panel as "失败原因：… [provider.auth/401]".
- **The enabled features are no longer invisible.** verify / bulk / second only ever did anything
  once `agent_run` was called, so the user had to name an agent in every prompt. The bridge now
  registers DSH's `agent/pre-step` waterfall — the same hook `@deepseek-ai/dsh-agent-instructions`
  uses — and injects ONE advisory `<system-reminder>` per turn naming the features that are on and
  the agent that would serve them.
- **Advisory, never coercive.** The model still decides. Nothing blocks, retries, or forces a call.
  `auto: true` ("DSH handles everything") and the new `remind: false` switch both mean the bridge
  says nothing at all.
- **A switch in the panel** ("自动提醒", on by default) so it can be silenced without turning the
  features off.
- Reminder text escapes `<` and `>`: recipe ids and model names are external data, and a community
  recipe must not be able to close the plugin-owned `</system-reminder>` frame.
- The per-turn dedupe has two tested paths, because the real `agent/pre-step` payload shape was not
  measured when this was written. The first few payload SHAPES (keys only, never values) are logged
  to `<DSH_HOME>/tools/agent-bridge/logs/pre-step-shape.log` so the rule can be tightened with
  evidence instead of guesswork.

## 0.2.0

- **New agent: WorkBuddy** (Tencent CodeBuddy Code). Headless-only: this desktop build ships
  `dist/codebuddy-headless.js` but not the TUI bundle, so the interactive `/login` cannot run.
  Authentication comes from `CODEBUDDY_AUTH_TOKEN`; without it the CLI reports
  `Authentication required` and the panel says "未登录" rather than inventing a number.
- **Model picker with free/paid badges**, for every agent. Catalogs are declared in the recipe
  (`catalog`) and read from disk with a TTL cache; a missing or malformed catalog degrades to the
  recipe's own static list with the reason attached.
- **Balance display** (four states: ok / unauthenticated / unsupported / error). Read-only by
  construction — `balance.write` is rejected by the schema, so the plugin cannot describe a call
  that mutates an account.
- **`interpreter`** on a recipe, so a JavaScript agent CLI runs through the Node that is already
  hosting the plugin (`source: "self"`).
- `agent_list` now returns normalized `models` objects; `modelIds` keeps the 0.1.x `string[]`
  contract working.

## 0.1.2

- Docs only: a full **Chinese README** (`README.zh-CN.md`) with a language switcher, plus badges for CI / npm version / downloads / license / node / zero dependencies. Both READMEs ship in the package.
- Tooling: `pack-check` now also asserts that `package.json` carries no byte-order mark — a BOM is legal UTF-8 but breaks `JSON.parse` everywhere else while npm tolerates it, so nothing else would notice (found the hard way).

## 0.1.1

- **Fix (live-app breaking):** tool results are now returned as content-part blocks. DSH calls `render(args, value)` and treats the result as blocks, so returning a bare string made every tool call fail in the running app with `content.some is not a function`. The contract is now asserted per tool by the harness.
- **Fix:** the recipe drafter searches nested objects and every JSONL event, so a streaming CLI's answer (`part.text`) is recovered instead of missed.
- **Fix:** the self-test accepts streaming fixtures (`*.jsonl`), so those recipes really replay their recorded stream.
- The paid Claude Code adapter is opt-in in the tests (`LIVE_PAID=1`); the default run spends nothing.

## 0.1.0

- First release.
- **Recipes, not code:** an agent is a JSON file (`discover` / `version` / `run` / `output` / `caps`). Two ship: OpenCode (free, JSONL) and Claude Code (paid, single JSON object behind an npm shim).
- **Cross-platform launcher** with no PowerShell: `ctx.subprocess` when the host offers it (argv vector, DSH's own execution world), otherwise `node:child_process` with real file descriptors plus an empty-file stdin — the combination that keeps an agent CLI from writing its answer and then never exiting.
- **Four tools:** `agent_run`, `agent_list` (discovery + `--version` probe + self-test), `agent_recipe` (draft / validate / save / import), `agent_mode`.
- **Session-header panel:** agent picker, per-agent model, role features, paid-agent warning, and the last run's report card.
- **Per-run artifacts:** a Markdown report and `last-run.json` in `<DSH_HOME>/tools/agent-bridge/logs/`.
- **Recipe wizard:** `draft` runs an unknown CLI once and returns a draft plus every candidate field it found; `save` writes to the local recipe directory (which overrides a bundled recipe with the same id); `import` fetches recipes over http(s) and stores only what passes strict validation — unknown top-level keys are errors, oversized and non-JSON payloads are refused before parsing, every import is recorded in `_provenance.json`, and nothing in a payload is ever executed.
- **Self-test:** validate the recipe, find the binary, run `--version`, replay the recorded fixture through the real parser.
- **Migration:** `opencode_run` / `opencode_mode` aliases (the alias refuses to be pointed at a different, paid agent) and one-time migration of `opencode-bridge.json` into the per-agent state shape, leaving the legacy file in place for rollback.
