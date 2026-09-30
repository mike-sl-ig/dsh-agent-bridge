# dsh-agent-bridge

Bridge **DeepSeek Harness** to whatever coding-agent CLI your machine already has — OpenCode, Claude Code, Codex, Gemini, or anything you write a recipe for — and use it as an independent worker for cross-model verification, cheap bulk work, or a second opinion.

The plugin never hard-codes a vendor. An agent is described by a **JSON recipe**, so adding one — or fixing one whose CLI changed its flags — is a data change, not a code change. Recipes are data on purpose: that is what makes it safe to fetch them from a community registry later.

## What it gives you

- **A button in the session header.** Pick the default agent, enable any of the three role features, choose a model, and see what the last run did.
- **Three tools** the model can call:
  - `agent_list` — which agents were found, where, what they cost, what they support (`probe: true` also runs `--version`).
  - `agent_run` — run one agent as an independent worker; returns the answer, session id, timing, tool calls and the path of a run report.
  - `agent_mode` — read/change the state the button shows.
- **A report per run**: a Markdown file (prompt, answer, tool calls, tokens, cost, raw log paths) plus `last-run.json` for the panel.

## Install

```
dsh plugin --profile <your-profile> add dsh-agent-bridge
```

Then reload the page (a new client plugin only appears after the page loads the client graph again).

## Roles

| mode | what the worker is told |
|---|---|
| `default` | nothing extra |
| `verify` | independent verifier from a different model family; **tools forbidden**, one pass |
| `bulk` | cheap mechanical worker; prefer direct answers, no self-checking with tools |
| `second` | independent second opinion; **tools forbidden**, one pass |

The tool prohibition is not cosmetic. Measured: an open-ended verifier task with a tool belt spent **11 tool calls and never answered** (180 s timeout), while the same question with tools forbidden answered correctly in **8 s**.

## Writing a recipe

Drop a JSON file in `lib/recipes/`. `lib/recipes/opencode.json` is the reference.

```jsonc
{
  "id": "my-agent",
  "label": "My Agent",
  "cost": "free",                     // free | paid | unknown
  "discover": {
    "env": ["MY_AGENT_CLI"],          // explicit override wins
    "bin": ["my-agent"],              // looked up on PATH
    "paths": { "win32": ["%LOCALAPPDATA%\\MyAgent\\my-agent.exe"],
               "darwin": ["/opt/homebrew/bin/my-agent"],
               "linux":  ["~/.local/bin/my-agent"] }   // `*` segments allowed
  },
  "version": { "args": ["--version"], "match": "my-agent" },
  "run": {
    "argv": ["exec", "--json"],
    "prompt": { "via": "positional" },   // or "stdin", or a flag name like "-p"
    "model":   { "flag": ["--model"] },
    "session": { "flag": ["--session"] },
    "resume":  { "flag": ["--continue"] },
    "files":   { "flag": ["--file"] }
  },
  "output": {
    "format": "jsonl",                   // jsonl | json | text
    "answer":  { "where": { "type": "text" }, "pick": "part.text" },
    "session": { "pick": "sessionID" },
    "tool":    { "where": { "type": "tool_use" }, "name": "part.tool",
                 "input": "part.state.input", "status": "part.state.status", "error": "part.state.error" },
    "usage":   { "where": { "type": "step_finish" }, "cost": "part.cost",
                 "input": "part.tokens.input", "output": "part.tokens.output",
                 "reasoning": "part.tokens.reasoning", "cacheRead": "part.tokens.cache.read" }
  },
  "caps": { "model": true, "session": true, "resume": true, "files": true },
  "models": ["provider/model-a", "provider/model-b"]
}
```

Field notes:

- `output.format: "text"` treats the whole stdout as the answer — the honest fallback for a CLI you have not reverse-engineered. It is **not** a guess: nothing is silently discarded.
- `pick` is a dotted path into the parsed object; `where` is a flat equality filter on the event object.
- `discover.derive`: append templates (`node_modules/<pkg>/<entry>`) resolved **next to a discovered shim**. Derived entries always outrank the shim they came from, because a `.ps1`/`.cmd` cannot be spawned without a shell. This is how Claude Code works: npm installs `claude.ps1`/`claude.cmd`, while the real entry is `.../@anthropic-ai/claude-code/bin/claude.exe`.
- `output.errorFlag`: a path that forces `Ok=false` when truthy, even on exit code 0. Claude Code exits 0 and sets `is_error` instead of failing the process.
- `output.usage` covers **both** output shapes: with `format: "json"` the paths are read once from the single object (`total_cost_usd`, `usage.input_tokens`, `num_turns`); with `jsonl` they are summed over the matching events (`step_finish` → cost/tokens).
- Unknown agents still work: point `prompt.via` at whatever flag the CLI takes and set `format: "text"`.

### Two shapes, both shipped and tested

| recipe | transport | output | cost | gotcha the recipe encodes |
|---|---|---|---|---|
| `opencode.json` | positional prompt, `--format json` | JSONL events | free | the answer is the concatenation of `type=text` events; cost only appears on tool-calling steps |
| `claude.json` | `-p` + positional prompt, `--output-format json` | ONE json object | **paid** | native binary behind an npm shim (`derive`); a failed run still exits 0 (`errorFlag`) |

Each recipe has a **recorded real fixture** in `fixtures/` (shipped inside the package); `npm test` replays it, so a recipe whose CLI changed behaviour fails before it fails for a user.

## Why a recipe and not code

Recipes are JSON so they can be reviewed and distributed without executing anything. Code-shaped adapters would mean "install this plugin and it will run whatever a registry hands it".

## Adding an agent without a release

Both supported ways are data-only:

1. **Locally** — `agent_recipe` with `action: "draft"` runs a CLI once and hands back a draft recipe plus every candidate field it found (the evidence, not just a conclusion). `action: "save"` validates and writes it to `<DSH_HOME>/tools/agent-bridge/recipes/`, where `agent_list` picks it up immediately. A local recipe **wins over a bundled one with the same id**, so a shipped recipe can be corrected without waiting for a release.
2. **From a registry** — `agent_recipe` with `action: "import"` and an http(s) URL returning a recipe, an array, or `{"recipes":[…]}`. Every candidate is validated in **strict mode** (an unknown top-level key is an error, not a warning), oversized and non-JSON payloads are refused before parsing, and every import is recorded in `_provenance.json`. **Nothing in a payload is ever executed** — a recipe is JSON read by this plugin's own engine, which is precisely why distributing recipes is safer than distributing adapters.

## Publishing

`npm test` runs eight suites offline (no network, no DSH). `pack-check.mjs` packs the package with `npm pack --dry-run` and asserts that the manifest only promises files that are really inside the tarball, that **no install-time lifecycle hook** exists, and that `tests/`, `node_modules/` and dotfiles stay out. Current payload: **14 files, ~35 KiB, zero runtime dependencies**.

## Notes for contributors

- **Never auto-execute a discovered binary.** Discovery is read-only (`PATH`, known install paths, `--version`). Running an agent requires an explicit call or an explicit default-agent choice.
- **Costs are real.** A `paid` recipe spends the user's money; the panel warns before a paid agent is selected.
- `tests/parse-recorded.mjs` replays every recorded agent stream on this machine through the parser; add a recorded fixture when you add a recipe.
- `tests/launch-smoke.mjs` runs one real agent call end-to-end without DSH.
- Paid recipes are **opt-in in the tests too**: `LIVE_PAID=1 node tests/host-harness.mjs` additionally drives a real Claude Code run. The default `npm test` never spends money.
- **Local-development hazard, measured twice on 2026-09-30.** Reconciling a profile that `link:`s your working copy — for example swapping that dependency for a packed tarball — can leave the linked directory **empty**, because pnpm's reconciliation follows the link. The failure is silent, and a profile that links to your only copy will then fail to load the plugin on the next start. Keep the tree somewhere no profile links to (or a backup), and re-run `npm test` after changing a profile's dependencies.
- Processes are started through `ctx.subprocess` when it is available (argv vector, no shell) and fall back to `node:child_process` with real file descriptors. Pipes are deliberately avoided: an agent CLI whose stdout is an inherited pipe can write its whole answer and then never exit.

## License

MIT
