# Changelog

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
