/**
 * Recipe-driven agent engine.
 *
 * A "recipe" is pure DATA (JSON): where to find a CLI, how to pass a prompt,
 * and how to read its output. Everything agent-specific lives in a recipe, so
 * adding an agent — or fixing one whose CLI changed its flags — never requires
 * touching this file, and recipes pulled from a community registry stay data
 * rather than code (which is what makes distributing them safe).
 *
 * See lib/recipes/opencode.json for the reference recipe.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/* ------------------------------------------------------------------ helpers */

/** Expand %VAR% (Windows), $VAR / ${VAR} (POSIX) and a leading ~. */
export function expandPath(value, env = process.env) {
  if (typeof value !== 'string' || value === '') return value
  let out = value
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    // Honour the environment the CALLER supplied, exactly like %VAR%/$VAR below
    // do — otherwise a recipe's `~/.opencode/bin/opencode` would silently resolve
    // against the real home even when the caller passed an explicit env (a
    // sandbox, a service override, or a test). Falls back to the real home.
    const home = (env && (env.HOME || env.USERPROFILE)) || homedir()
    out = join(home, out.slice(1))
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => env[name] ?? m)
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => env[a || b] ?? m)
  return out
}

/**
 * Resolve a path that may contain `*` segments (versioned install dirs such as
 * `...\cli\*\opencode-cli.exe`). Only one level of `*` per segment is needed in
 * practice; anything deeper still works because the walk is recursive.
 */
export function expandGlob(pattern) {
  const parts = pattern.split(/[\\/]+/).filter((p) => p !== '')
  const root = /^[A-Za-z]:$/.test(parts[0]) ? `${parts.shift()}\\` : (pattern.startsWith('/') ? '/' : '')
  const walk = (current, rest) => {
    if (rest.length === 0) return existsSync(current) ? [current] : []
    const [head, ...tail] = rest
    if (!head.includes('*')) return walk(join(current, head), tail)
    let entries = []
    try { entries = readdirSync(current).filter((name) => matchStar(head, name)) } catch { return [] }
    return entries.flatMap((name) => walk(join(current, name), tail))
  }
  return walk(root, parts)
}

/** Glob match for a single segment supporting `*` and `?`. */
export function matchStar(pattern, value) {
  const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return rx.test(value)
}

/** Read a dotted path out of a parsed object; undefined when absent. */
export function pick(object, path) {
  if (!object || !path) return undefined
  return String(path).split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), object)
}

/**
 * Normalize any value into LOSSLESS JSON: plain objects/arrays with enumerable
 * string keys, no `undefined` members, no non-finite numbers, no negative zero,
 * no class instances. DSH validates every tool result against exactly these
 * rules and fails the entire tool call when they are violated ("value is not
 * lossless JSON"), so nothing may cross that boundary unsanitized.
 */
export function jsonSafe(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : jsonSafe(item)))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return null
}

/** True when every key/value in `where` matches the object. */
export function matches(object, where) {
  if (!where) return true
  return Object.entries(where).every(([key, value]) => object && object[key] === value)
}

/** Look a bare command name up on PATH. */
export function findOnPath(names, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || '').split(delimiter).filter(Boolean)
  const exts = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const name of names) {
    const hasExt = /\.[A-Za-z0-9]+$/.test(name)
    for (const dir of dirs) {
      const candidates = hasExt ? [name] : [name, ...exts.map((e) => name + e.toLowerCase())]
      for (const candidate of candidates) {
        const full = join(dir, candidate)
        try { if (existsSync(full) && statSync(full).isFile()) return full } catch { /* unreadable dir */ }
      }
    }
  }
  return null
}

/* ---------------------------------------------------------------- discovery */

/**
 * Turn a rule's `append` fragment into a real path under a directory.
 * Rules are data, so they always use `/` as the separator.
 */
function under(directory, append) {
  return join(directory, ...String(append || '').split('/').filter(Boolean))
}

/**
 * Find the CLI for a recipe, in priority order: explicit override → PATH →
 * platform-specific path list, and then the DERIVED real entry.
 *
 * Why derivation exists: many CLIs are installed through a package manager that
 * leaves a shim in the bin directory (`claude.ps1`/`claude.cmd` on Windows, a
 * shell script elsewhere) while the thing that must actually be spawned lives
 * inside the package (`node_modules/@anthropic-ai/claude-code/bin/claude.exe`).
 * A shim is not directly spawnable without a shell, so a derived, real entry
 * always outranks the shim it came from. Read-only: it never executes anything.
 */
export function discover(recipe, env = process.env, platform = process.platform) {
  const found = []
  const d = recipe.discover || {}
  for (const key of d.env || []) {
    const value = env[key]
    if (value && existsSync(value)) found.push({ source: `env:${key}`, path: value })
  }
  const onPath = findOnPath(d.bin || [], env, platform)
  if (onPath) found.push({ source: 'PATH', path: onPath })
  for (const raw of ((d.paths || {})[platform] || [])) {
    for (const candidate of expandGlob(expandPath(raw, env))) {
      if (existsSync(candidate)) found.push({ source: 'known-path', path: candidate })
    }
  }

  const derived = []
  for (const candidate of found) {
    for (const rule of (d.derive || [])) {
      if (Array.isArray(rule.platforms) && !rule.platforms.includes(platform)) continue
      const path = under(dirname(candidate.path), rule.append)
      if (path !== candidate.path && existsSync(path)) derived.push({ source: `derived<-${candidate.source}`, path })
    }
  }

  const seen = new Set()
  return [...derived, ...found].filter((f) => (seen.has(f.path) ? false : seen.add(f.path)))
}

/* ------------------------------------------------------------ argv building */

/**
 * Turn a run spec into an argv vector.
 * @param recipe Parsed recipe.
 * @param spec { prompt, model, agent, session, resume, files }
 * @returns { args, promptVia } — promptVia is 'positional' | 'stdin' | flag name.
 */
export function buildArgs(recipe, spec = {}) {
  const run = recipe.run || {}
  const args = [...(run.argv || [])]
  const flag = (entry) => (Array.isArray(entry) ? entry : [entry]).filter(Boolean)

  if (spec.model && run.model) args.push(...flag(run.model.flag), String(spec.model))
  if (spec.agent && run.agent) args.push(...flag(run.agent.flag), String(spec.agent))
  if (spec.session && run.session) args.push(...flag(run.session.flag), String(spec.session))
  if (spec.resume && run.resume) args.push(...flag(run.resume.flag))
  for (const file of spec.files || []) {
    if (run.files) args.push(...flag(run.files.flag), String(file))
  }

  const prompt = String(spec.prompt ?? '')
  const via = (run.prompt && run.prompt.via) || 'positional'
  if (via === 'positional') args.push(prompt)
  else if (via !== 'stdin') args.push(...flag(via), prompt)

  return { args, promptVia: via }
}

/* ----------------------------------------------------------- output parsing */

/** Parse a whole stdout blob according to the recipe's declared format. */
export function parseEvents(recipe, text) {
  const format = (recipe.output && recipe.output.format) || 'text'
  if (format === 'text') return { events: [], text: String(text || '') }
  if (format === 'json') {
    try { return { events: [], json: JSON.parse(String(text || '').trim()) } } catch { return { events: [], json: null } }
  }
  // jsonl (the common case for streaming agents): one JSON object per line.
  const events = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { events.push(JSON.parse(trimmed)) } catch { /* non-JSON banner line */ }
  }
  return { events }
}

/**
 * Normalize a run into the shape the host, the panel and the reports all share:
 * { Ok, Answer, Session, Tools, Tokens, Cost }.
 */
export function normalize(recipe, run, raw) {
  const out = recipe.output || {}
  const parsed = parseEvents(recipe, raw.stdout)

  let answer = ''
  if (parsed.json) {
    const picked = pick(parsed.json, out.answer && out.answer.pick)
    answer = picked === undefined || picked === null ? '' : String(picked)
  } else if (parsed.events.length) {
    const where = out.answer && out.answer.where
    const path = (out.answer && out.answer.pick) || 'text'
    answer = parsed.events.filter((e) => matches(e, where)).map((e) => pick(e, path)).filter((v) => v !== undefined && v !== null).join('\n').trim()
  } else {
    answer = String(parsed.text || '').trim()
  }

  let session = ''
  if (out.session) {
    const source = parsed.json || parsed.events.find((e) => pick(e, out.session.pick) !== undefined)
    const picked = source ? pick(source, out.session.pick) : undefined
    session = picked === undefined || picked === null ? '' : String(picked)
  }

  const tools = []
  if (out.tool && parsed.events.length) {
    for (const event of parsed.events.filter((e) => matches(e, out.tool.where))) {
      /* Only DEFINED fields may enter the entry: DSH requires every tool result
       * to be lossless JSON, and `undefined` is not (JSON.stringify silently
       * drops it, which is exactly what "not lossless" means). A recipe whose
       * stream lacks an optional path — OpenCode emits no `part.state.error` on
       * success — would otherwise break the whole tool call. */
      const entry = {}
      for (const [key, path] of [['Tool', out.tool.name], ['Status', out.tool.status], ['Note', out.tool.error]]) {
        const value = pick(event, path)
        if (value === undefined || value === null) continue
        entry[key] = typeof value === 'string' ? value : String(value)
      }
      const input = pick(event, out.tool.input)
      if (input !== undefined && input !== null) {
        // A tool input can be a whole file's content; keep the diagnostic bounded.
        const text = typeof input === 'string' ? input : JSON.stringify(jsonSafe(input))
        entry.Input = text.length > 400 ? `${text.slice(0, 400)}…` : text
      }
      tools.push(entry)
    }
  }

  let cost = 0
  const tokens = { Input: 0, Output: 0, Reasoning: 0, CacheRead: 0 }
  let steps = 0
  const usage = out.usage
  if (usage && parsed.json) {
    /* Single-object formats report ONE usage block (Claude Code: .usage.*,
     * .total_cost_usd, .num_turns) instead of per-step events to accumulate. */
    steps = Number(pick(parsed.json, usage.steps) || 0)
    cost = Number(pick(parsed.json, usage.cost) || 0)
    tokens.Input = Number(pick(parsed.json, usage.input) || 0)
    tokens.Output = Number(pick(parsed.json, usage.output) || 0)
    tokens.Reasoning = Number(pick(parsed.json, usage.reasoning) || 0)
    tokens.CacheRead = Number(pick(parsed.json, usage.cacheRead) || 0)
  } else if (usage && parsed.events.length) {
    for (const event of parsed.events.filter((e) => matches(e, usage.where))) {
      steps++
      cost += Number(pick(event, usage.cost) || 0)
      tokens.Input += Number(pick(event, usage.input) || 0)
      tokens.Output += Number(pick(event, usage.output) || 0)
      tokens.Reasoning += Number(pick(event, usage.reasoning) || 0)
      tokens.CacheRead += Number(pick(event, usage.cacheRead) || 0)
    }
  }

  /* Some CLIs report failure INSIDE a successful process: Claude Code exits 0
   * and sets `is_error` (with subtype / terminal_reason) instead of failing the
   * process. The recipe names that flag so a failed run is never mistaken for an
   * answer. */
  const errorFlag = out.errorFlag && parsed.json ? pick(parsed.json, out.errorFlag) : undefined
  const ok = raw.exitCode === 0 && !raw.timedOut && !raw.aborted && answer !== '' && !errorFlag
  return jsonSafe({
    Ok: ok,
    Agent: recipe.id,
    ExitCode: raw.exitCode,
    Seconds: Number((raw.ms / 1000).toFixed(1)),
    Session: session,
    Answer: answer,
    Tools: tools,
    ToolSteps: steps,
    Cost: cost,
    Tokens: tokens,
    Stderr: String(raw.stderr || '').trim(),
    TimedOut: Boolean(raw.timedOut),
    Aborted: Boolean(raw.aborted),
    ErrorFlag: Boolean(errorFlag),
    Spawned: raw.spawned !== false,
    SpawnError: raw.error || '',
    /** How the process was started: 'subprocess-service' or 'direct'. */
    Via: raw.via || '',
    OutFile: raw.outPath,
    ErrFile: raw.errPath,
  })
}

/** Load a recipe from disk (kept here so recipes stay data, never modules). */
export function loadRecipe(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
