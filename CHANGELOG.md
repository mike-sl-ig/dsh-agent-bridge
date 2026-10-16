# Changelog

## 0.4.4

- **WorkBuddy's balance row is off.** Its endpoints answer for an account API key, and issuing one
  needs a paid membership, so on a free account the row could only ever show an error the user
  cannot act on. The recipe now declares `balance.kind = "none"` — state `unsupported`, no row
  rendered — while keeping `"write": null` so the file still proves it cannot mutate an account. The
  read-only definition that used to be there (base, probe, summary, map, unit) is preserved in the
  block's `note` for whoever turns it back on.
- **Recorded in that note, because it cost real time:** a non-ASCII `CODEBUDDY_AUTH_TOKEN` breaks
  *runs*, not just the balance row. The plugin hands its environment to the CLI, the CLI used the
  value as a credential, and the runtime threw `Cannot convert argument to a ByteString ... 27983`
  before any request left — a free model failed with exactly that message. Deleting the variable
  restores the CLI's own stored login; 0.4.3's guard only covers the balance path.

## 0.4.3

- **A credential that cannot travel is refused in words.** A header value has to be ISO-8859-1, and
  pasting a label or half a line instead of the token is easy — the runtime then fails with
  `Cannot convert argument to a ByteString because the character at index 21 has a value of 27983`,
  which tells a user nothing. `lib/balance.js` now checks the credential before the first request and
  answers `凭据含非 ASCII 字符（第 N 个），HTTP 头无法携带；请重新复制纯 ASCII 的 Cookie 或 API 令牌`
  instead. Three new checks in `tests/balance.mjs` pin it (no request attempted, the words name the
  character and the fix): 31 checks in that file, 491 across the suite.

## 0.4.2

- **WorkBuddy followed the 2026-10-15 app update.** That update replaced `cli/dist/*` with the lite
  bundle `dist/codebuddy-lite-wb.mjs`, and the old `bin/codebuddy` launcher now dies in print mode
  with `Cannot find module '../dist/codebuddy'` (its headless bundle is gone) — a 0.3s failure with
  no stderr. Discovery now prefers the `.mjs` entry, which serves both `--version` and `-p`, and
  keeps `bin/codebuddy` as the fallback for older installs. Verified against the installed CLI:
  probe `2.161.0`, and a real run answered in 7.1s.
- **The balance credential now actually travels.** `lib/balance.js` used `CODEBUDDY_AUTH_TOKEN` only
  as a presence check and then sent the request with no credential header at all, so the endpoint
  could never answer anything but "unauthenticated". The credential is now attached to both calls: a
  value that looks like a browser cookie (it contains `=`) travels as `Cookie:`, anything else as
  `Authorization: Bearer`. A recipe can override that with `balance.auth = { header, prefix }`
  (validated in `lib/recipe.js`). Guessing wrong costs one honest "unauthenticated" answer, never a
  wrong number.
- **`tests/balance.mjs` grew 12 checks** that pin the wire form rather than the intent: the suite
  stubs `globalThis.fetch` and asserts the cookie/bearer header is on both the login probe and the
  summary POST (28 checks in that file, 21 files in the suite).
- **`unauthenticated` now tells the user what to do** — "设置 CODEBUDDY_AUTH_TOKEN（浏览器 Cookie 或
  API 令牌）" — instead of only explaining why the plugin cannot read the CLI's encrypted credential.
- **`tests/launch-smoke.mjs` is opt-in** (`LIVE_SMOKE=1`, with `LIVE_SMOKE_MAX_MS` for the limit).
  It spawns a real CLI, so free-model latency — 117.8s once, for an otherwise perfect run — could
  paint the whole suite red for a reason unrelated to the launcher.

## 0.4.1

- **The plugin now says which DSH versions it supports**, instead of loading silently into any of
  them: `peerDependencies['@deepseek-ai/dsh'] = ">=0.2.0-rc.2 <0.3.0"`. DSH evaluates that field in
  `packages/boot/app-boot/src/plugin-compatibility.ts` with
  `semver.satisfies(runtime, range, { includePrerelease: true })` and refuses (or warns, with an
  exact-version exemption to override) when it does not hold. The `includePrerelease` option is what
  makes a prerelease runtime like `0.2.1-alpha.2` admissible at all — under default semver rules the
  prerelease-exclusion rule would reject it.
- **Audited against 0.2.1-alpha.2** (tag `dsh-v0.2.1-alpha.2`, commit `d7432673`) by reading that
  source. All six API surfaces this plugin depends on are unchanged: the
  `conversation.session.header.utilities` slot (the official `session-log-export` plugin registers
  into it with the identical call), `ctx.slots.register` (`name` required, `id`/`label`/`order`
  optional), `ctx.get('tools')` + `tools.register`, `connection.fetch.register` (same options shape,
  same `/api/` path validation), `agent/pre-step` with `{ kind: 'enter', messages }`, and the
  `dsh.client.platform` + `exports["./client"]` + `dsh.bundle.patch` contract. None of the 0.2.1
  breaking changes apply: no `./invariant` export, no composer statistics row, no tool-presentation
  mode, no per-row `dshHome` agent-instructions config, and this is a package-root plugin rather
  than a subpath one.
- New suite member `tests/compat-manifest.mjs` (18 files total) pins that promise: the declared range
  must admit every runtime the suite has been run against (`0.2.0-rc.2`, `0.2.1-alpha.1`,
  `0.2.1-alpha.2`, `0.2.1`) and refuse `0.3.0`, so a future version bump cannot quietly extend the
  claim. It carries its own comparator because this package has **no dependencies**; that comparator
  was cross-checked against the real `semver` library over 66 (range, version) pairs using DSH's
  exact call shape — 0 mismatches.

## 0.4.0

- **More than one agent can be switched on at once.** The panel used to radio-select a single
  "default agent", which contradicted what the role features are for: cross-model verification
  wants a *different* model family, and a second opinion wants a different head. It is now a pool
  (checkboxes), every pooled agent keeps its own model picker, and the reminder lists the whole
  pool and hands the choice back: "用哪个、用几个由你判断".
- **Behaviour change worth knowing:** a `verify` call may no longer use the agent you had selected
  as "primary" — picking a different family is the point. The first *installed* pool member is the
  default when a call names none.
- `defaultAgent` is kept in the state file (0.3.x consumers read it) but is now derived from the
  pool, so the two cannot disagree. An old state migrates losslessly: the single selected agent
  becomes a one-member pool.

## 0.3.0

- **`catalog.kind: "argv"` was a promise the schema made and the code did not keep.** The validator
  listed `argv` as legal while `readCatalog` threw `"not supported"` and quietly fell back to the
  static list. It is implemented now: a recipe can point at its own CLI (`opencode models`, one id
  per line, `parse: "lines"`; `parse: "json"` for CLIs that answer in JSON). OpenCode's picker was
  the proof it mattered — the recipe listed **8** models while the authenticated CLI offers **41**
  (Claude, GPT, Gemini, Grok, Qwen …), so two thirds of what the user could run was invisible. The
  static array stays as the offline fallback when the CLI cannot be run.
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
