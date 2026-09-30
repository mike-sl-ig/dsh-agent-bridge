/**
 * dsh-agent-bridge — HOST half.
 *
 * Bridges DeepSeek Harness to whatever external coding-agent CLI the machine
 * has, without hard-coding any single vendor: agents are described by JSON
 * recipes (lib/recipes/*.json), so adding one — or fixing one whose CLI changed
 * its flags — is a data change, and recipes fetched from a community registry
 * stay data instead of code.
 *
 * Surfaces:
 *   tools   agent_run / agent_list / agent_mode
 *   route   GET /api/agent.bridge            (state + discovered agents)
 *           GET /api/agent.bridge?probe=1    (+ run `--version` per agent)
 *           GET /api/agent.bridge?last=1     (+ the newest run summary)
 *           GET /api/agent.bridge?save=1&…   (persist state)
 *
 * Design rules learned the hard way on the OpenCode-only predecessor:
 *   - one malformed tool schema breaks EVERY model request in the session, so
 *     registerTool() refuses anything that is not already a full JSON Schema;
 *   - an agent CLI must not run under a shell, and must not inherit pipes;
 *   - a timeout must never trigger a second run;
 *   - every run leaves a human-readable report behind.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgs, discover, jsonSafe, loadRecipe, normalize } from './engine.js'
import { launch } from './launch.js'
import { draftFromRun, validateRecipe } from './recipe.js'

export const name = 'agent-bridge'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const RECIPE_DIR = join(HERE, 'recipes')

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const STATE_PATH = join(DSH_HOME, 'agent-bridge.json')
/** The OpenCode-only predecessor's state file, read once for migration. */
const LEGACY_STATE_PATH = join(DSH_HOME, 'opencode-bridge.json')
const LOG_DIR = join(DSH_HOME, 'tools', 'agent-bridge', 'logs')
const WORK_DIR = join(DSH_HOME, 'tools', 'agent-bridge', 'work')
const LAST_RUN_PATH = join(LOG_DIR, 'last-run.json')
/** Recipes the user (or the wizard) added. Same JSON shape and the same
 *  validator as the bundled ones, and they WIN over a bundled recipe with the
 *  same id — that is how a shipped recipe gets fixed locally, or a brand-new
 *  agent CLI gets supported, without waiting for a plugin release. */
const LOCAL_RECIPE_DIR = join(DSH_HOME, 'tools', 'agent-bridge', 'recipes')
/** Recorded real outputs (one per recipe) replayed by the self-test. */
const FIXTURE_DIR = join(HERE, '..', 'fixtures')
/**
 * id -> the file a recipe was loaded from. Provenance is kept in a SIDE MAP and
 * never as a property on the recipe: a non-enumerable own property is not
 * lossless JSON, so any tool result carrying the recipe would be rejected.
 */
const RECIPE_SOURCES = new Map()

const FEATURE_KEYS = ['verify', 'bulk', 'second']

/** Role prefixes. verify/second forbid tools: measured 2026-09-30, an open-ended
 * verifier task with a tool belt ran 11 tool calls and never answered, while the
 * same question with tools forbidden answered correctly in 8s in one pass. */
const NO_TOOLS =
  'Do NOT call any tool (no shell, no file reads, no web fetch, no writes). Answer from your ' +
  'own knowledge in a single pass. If you truly cannot answer without tools, say so in one ' +
  'line instead of exploring.\n\n'

const MODE_PREFIX = {
  verify:
    'You are an INDEPENDENT VERIFIER from a different model family. ' +
    'Do not trust the framing below. Independently check it and report every error, ' +
    'contradiction, unsupported claim, or missing case. Be adversarial and concrete.\n\n' + NO_TOOLS,
  bulk:
    'You are a FAST, CHEAP BULK WORKER. Perform the mechanical processing task below ' +
    'faithfully and exhaustively. Return only the requested result, with no commentary.\n\n' +
    'Prefer answering directly. Only call a tool when the task genuinely cannot be done ' +
    'without one, and never use tools to double-check your own answer.\n\n',
  second:
    'You are a SECOND OPINION. Answer the question below independently, in your own words. ' +
    'If a primary answer is quoted, state explicitly where you disagree with it.\n\n' + NO_TOOLS,
}

const DEFAULT_STATE = {
  auto: true,
  defaultAgent: '',
  defaultMode: 'default',
  enabled: { verify: false, bulk: false, second: false },
  agents: {},
}

/* ---------------------------------------------------------------- logging */

let logger = null
/** Set once the agent tools are registered; surfaced by the route's diagnostics. */
let toolsReady = false
function warn(message, error) {
  const detail = error && error.message ? `: ${error.message}` : (error ? `: ${String(error)}` : '')
  if (logger && typeof logger.warn === 'function') logger.warn(`${message}${detail}`)
  else console.warn(`[agent-bridge] ${message}${detail}`)
}

/* ------------------------------------------------------------------ state */

function coerceState(raw) {
  const out = { ...DEFAULT_STATE, enabled: { ...DEFAULT_STATE.enabled }, agents: {} }
  if (!raw || typeof raw !== 'object') return out
  if (typeof raw.auto === 'boolean') out.auto = raw.auto
  if (typeof raw.defaultAgent === 'string') out.defaultAgent = raw.defaultAgent
  if (typeof raw.defaultMode === 'string') out.defaultMode = raw.defaultMode
  if (raw.enabled && typeof raw.enabled === 'object') {
    for (const key of FEATURE_KEYS) if (typeof raw.enabled[key] === 'boolean') out.enabled[key] = raw.enabled[key]
  }
  if (raw.agents && typeof raw.agents === 'object') {
    for (const [id, value] of Object.entries(raw.agents)) {
      if (!value || typeof value !== 'object') continue
      out.agents[id] = { model: typeof value.model === 'string' ? value.model : '' }
    }
  }
  return out
}

/**
 * One-time migration from dsh-opencode-bridge's state file.
 *
 * The old shape was `{ auto, enabled, defaultMode, model }` with a single agent;
 * the new one is `{ auto, defaultAgent, defaultMode, enabled, agents{ id: { model } } }`.
 * The legacy file is left on disk untouched so a rollback stays possible.
 */
function migrateLegacyState() {
  try {
    if (existsSync(STATE_PATH) || !existsSync(LEGACY_STATE_PATH)) return false
    const legacy = JSON.parse(readFileSync(LEGACY_STATE_PATH, 'utf8'))
    const migrated = coerceState({
      auto: legacy.auto,
      defaultAgent: 'opencode',
      defaultMode: legacy.defaultMode,
      enabled: legacy.enabled,
      agents: { opencode: { model: typeof legacy.model === 'string' ? legacy.model : '' } },
    })
    const saved = writeState(migrated)
    if (saved) warn(`migrated legacy state ${LEGACY_STATE_PATH} -> ${STATE_PATH} (the legacy file is left in place)`)
    return saved
  } catch (error) {
    warn('legacy state migration failed', error)
    return false
  }
}

function readState() {
  try {
    if (!existsSync(STATE_PATH)) {
      migrateLegacyState()
      if (!existsSync(STATE_PATH)) return coerceState(null)
    }
    return coerceState(JSON.parse(readFileSync(STATE_PATH, 'utf8')))
  } catch {
    return coerceState(null)
  }
}

function writeState(state) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch (error) {
    warn('cannot write state', error)
    return false
  }
}

function readLastRun() {
  try {
    if (!existsSync(LAST_RUN_PATH)) return null
    const raw = JSON.parse(readFileSync(LAST_RUN_PATH, 'utf8'))
    if (raw && typeof raw.Answer === 'string' && raw.Answer.length > 4000) raw.Answer = `${raw.Answer.slice(0, 4000)}…`
    return raw
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- recipes */

/** Read one recipe directory, validating every file before it is trusted. */
function readRecipeDir(directory) {
  let names = []
  // `_`-prefixed files are bookkeeping (the provenance log), never recipes.
  try { names = readdirSync(directory).filter((f) => f.endsWith('.json') && !f.startsWith('_')) } catch { return [] }
  const recipes = []
  for (const file of names.sort()) {
    const full = join(directory, file)
    try {
      const recipe = loadRecipe(full)
      const verdict = validateRecipe(recipe)
      if (!verdict.ok) {
        warn(`recipe ${file} was rejected: ${verdict.problems.join('; ')}`)
        continue
      }
      for (const warning of verdict.warnings) warn(`recipe ${file}: ${warning}`)
      // Provenance lives in a SIDE MAP, never on the recipe object: a
      // non-enumerable own property is not lossless JSON, and any tool result
      // that happened to carry the recipe would then be rejected outright.
      RECIPE_SOURCES.set(recipe.id, full)
      recipes.push(recipe)
    } catch (error) {
      warn(`recipe ${file} is not valid JSON`, error)
    }
  }
  return recipes
}

/** Bundled recipes plus local overrides, deduplicated by id (local wins). */
function loadRecipes() {
  const byId = new Map()
  for (const recipe of [...readRecipeDir(RECIPE_DIR), ...readRecipeDir(LOCAL_RECIPE_DIR)]) {
    byId.set(recipe.id, recipe)
  }
  return [...byId.values()]
}

/** Read-only view of every recipe plus where its CLI was found. */
function agentsView(state) {
  return loadRecipes().map((recipe) => {
    const found = discover(recipe)
    const configured = state.agents[recipe.id] || {}
    return {
      id: recipe.id,
      label: recipe.label || recipe.id,
      vendor: recipe.vendor || '',
      cost: recipe.cost || 'unknown',
      caps: recipe.caps || {},
      models: Array.isArray(recipe.models) ? recipe.models : [],
      model: configured.model || '',
      installed: found.length > 0,
      path: found.length ? found[0].path : '',
      source: found.length ? found[0].source : '',
      candidates: found.length,
    }
  })
}

/** Execute `--version` for one recipe; never throws. */
async function probeRecipe(ctx, recipe) {
  const spec = recipe.version || {}
  const found = discover(recipe)
  if (!found.length) return { id: recipe.id, installed: false, ok: false, note: 'not found' }
  const result = await launch(ctx, found[0].path, spec.args || ['--version'], {
    cwd: WORK_DIR,
    logDir: LOG_DIR,
    label: `${recipe.id}-probe`,
    timeoutMs: spec.timeoutMs || 30000,
  })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  const match = spec.match ? text.toLowerCase().includes(String(spec.match).toLowerCase()) : true
  return {
    id: recipe.id,
    installed: true,
    path: found[0].path,
    ok: result.spawned && result.exitCode === 0 && match,
    exitCode: result.exitCode,
    version: text.split(/\r?\n/).find(Boolean) || '',
    note: result.error || (match ? '' : `output did not contain "${spec.match}"`),
  }
}

/* ------------------------------------------------------------------- runs */

/** Registry payload limits: a recipe is data, and small. */
const IMPORT_MAX_BYTES = 512 * 1024
const IMPORT_TIMEOUT_MS = 15000

/**
 * Fetch recipes from a community URL and store only what passes the strict
 * validator. Nothing in the payload is ever executed — a recipe is JSON that is
 * read by this plugin's own engine, which is exactly why distributing recipes
 * is safer than distributing adapters.
 */
async function importRecipes(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('import needs an http(s) url')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS)
  let text
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > IMPORT_MAX_BYTES) throw new Error(`registry declared ${declared} bytes; the limit is ${IMPORT_MAX_BYTES}`)
    text = await response.text()
  } finally {
    clearTimeout(timer)
  }
  if (text.length > IMPORT_MAX_BYTES) throw new Error(`registry payload is ${text.length} bytes; the limit is ${IMPORT_MAX_BYTES}`)

  let parsed
  try { parsed = JSON.parse(text) } catch (error) { throw new Error(`registry payload is not JSON: ${String((error && error.message) || error)}`) }
  const candidates = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.recipes) ? parsed.recipes : [parsed])
  if (candidates.length === 0) throw new Error('registry payload contained no recipes')

  mkdirSync(LOCAL_RECIPE_DIR, { recursive: true })
  const results = []
  for (const candidate of candidates) {
    const id = candidate && typeof candidate.id === 'string' ? candidate.id : '(no id)'
    const verdict = validateRecipe(candidate, { strictKeys: true })
    if (!verdict.ok) {
      results.push({ id, saved: false, problems: verdict.problems })
      continue
    }
    const target = join(LOCAL_RECIPE_DIR, `${candidate.id}.json`)
    let overridesBundled = false
    try { overridesBundled = readdirSync(RECIPE_DIR).includes(`${candidate.id}.json`) } catch { overridesBundled = false }
    writeFileSync(target, JSON.stringify(candidate, null, 2), 'utf8')
    results.push({ id: candidate.id, saved: true, path: target, overridesBundled, warnings: verdict.warnings })
  }

  // Provenance: the user can always see which ids came from which URL.
  try {
    const log = join(LOCAL_RECIPE_DIR, '_provenance.json')
    const history = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : []
    history.push({ url, at: new Date().toISOString(), saved: results.filter((r) => r.saved).map((r) => r.id) })
    writeFileSync(log, JSON.stringify(history.slice(-50), null, 2), 'utf8')
  } catch (error) {
    warn('cannot write the provenance log', error)
  }

  return { url, bytes: text.length, candidates: candidates.length, saved: results.filter((r) => r.saved).length, results }
}

/** The recorded fixture for a recipe id, if the package ships one. */
function fixtureFor(id) {
  try {
    // `.json` for single-object CLIs, `.jsonl` for streaming ones.
    const hit = readdirSync(FIXTURE_DIR)
      .filter((f) => f.startsWith(`${id}-`) && (f.endsWith('.json') || f.endsWith('.jsonl')))
      .sort()[0]
    return hit ? join(FIXTURE_DIR, hit) : ''
  } catch {
    return ''
  }
}

/**
 * The honest answer to "is this adapter actually working?": validate the recipe,
 * find the binary, run --version, and replay the recorded fixture through the
 * real parser. Nothing is asserted that was not measured.
 */
async function selfTestRecipe(ctx, recipe, { probe = true } = {}) {
  const verdict = validateRecipe(recipe)
  const found = discover(recipe)
  const report = {
    id: recipe.id,
    label: recipe.label || recipe.id,
    cost: recipe.cost || 'unknown',
    source: RECIPE_SOURCES.get(recipe.id) || '',
    recipeValid: verdict.ok,
    problems: verdict.problems,
    warnings: verdict.warnings,
    installed: found.length > 0,
    path: found.length ? found[0].path : '',
    foundVia: found.length ? found[0].source : '',
    probe: null,
    fixture: null,
    ok: false,
  }
  if (probe && found.length) report.probe = await probeRecipe(ctx, recipe)
  const fixture = fixtureFor(recipe.id)
  if (fixture) {
    try {
      const parsed = normalize(recipe, {}, {
        spawned: true,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        stdout: readFileSync(fixture, 'utf8'),
        stderr: '',
        ms: 1000,
        outPath: fixture,
        errPath: '',
      })
      report.fixture = {
        file: fixture,
        ok: parsed.Ok,
        answerChars: parsed.Answer.length,
        session: parsed.Session,
        cost: parsed.Cost,
        toolCalls: parsed.Tools.length,
      }
    } catch (error) {
      report.fixture = { file: fixture, ok: false, error: String((error && error.message) || error) }
    }
  } else {
    report.warnings = [...report.warnings, 'no recorded fixture: the parser cannot be self-tested for this recipe']
  }
  const probeOk = report.probe === null ? true : Boolean(report.probe && report.probe.ok)
  const fixtureOk = report.fixture === null ? true : Boolean(report.fixture && report.fixture.ok)
  report.ok = report.recipeValid && report.installed && probeOk && fixtureOk
  return report
}

/** Write the human-readable report for one run; returns its path. */
function writeReport(result, spec, prompt) {
  const lines = []
  lines.push(`# ${result.Agent} 运行报告`)
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 结果 | ${result.Ok ? 'Ok' : '失败'} |`)
  lines.push(`| agent | ${result.Agent} |`)
  lines.push(`| 模式 | ${result.Mode} |`)
  lines.push(`| 时间 | ${formatLocal()} |`)
  lines.push(`| 耗时 | ${result.Seconds} s |`)
  lines.push(`| 退出码 | ${result.ExitCode === null ? '-' : result.ExitCode} |`)
  // Diagnostics parity with the predecessor plugin, which recorded how it launched.
  const launchMethod = result.Via === 'subprocess-service'
    ? 'DSH subprocess 服务'
    : (result.Via === 'direct' ? 'node:child_process（直连，无 shell）' : (result.Via || '-'))
  lines.push(`| 启动方式 | ${launchMethod} |`)
  lines.push(`| 模型 | ${result.ModelReq || '(CLI 默认)'} |`)
  lines.push(`| 会话 | ${result.Session || '-'} |`)
  lines.push(`| 工具调用 | ${result.Tools.length} 次 / ${result.ToolSteps} 步 |`)
  lines.push(`| tokens | in=${result.Tokens.Input} out=${result.Tokens.Output} reasoning=${result.Tokens.Reasoning} cacheRead=${result.Tokens.CacheRead} |`)
  lines.push(`| 成本 | ${result.Cost} |`)
  lines.push(`| 工作目录 | ${spec.workdir || WORK_DIR} |`)
  lines.push('')
  lines.push('## 提示词')
  lines.push('')
  for (const line of String(prompt).split(/\r?\n/)) lines.push(`    ${line}`)
  lines.push('')
  lines.push('## 答案')
  lines.push('')
  lines.push(result.Answer || '(没有产出最终答案)')
  lines.push('')
  lines.push('## 工具调用')
  lines.push('')
  if (result.Tools.length) {
    for (const tool of result.Tools) {
      lines.push(`- ${tool.Tool} [${tool.Status || '-'}]${tool.Note ? ` -- ERR: ${tool.Note}` : ''}`)
    }
  } else {
    lines.push('(未调用任何工具)')
  }
  if (result.Stderr) {
    lines.push('')
    lines.push('## stderr')
    lines.push('')
    for (const line of result.Stderr.split(/\r?\n/)) lines.push(`    ${line}`)
  }
  lines.push('')
  lines.push('## 原始文件')
  lines.push('')
  lines.push(`- stdout: ${result.OutFile}`)
  lines.push(`- stderr: ${result.ErrFile}`)
  lines.push('')

  const path = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${result.Agent}-${result.Mode}.md`)
  try { writeFileSync(path, lines.join('\r\n'), 'utf8') } catch (error) { warn('cannot write the run report', error); return '' }
  return path
}

/**
 * Local wall-clock time WITH its offset. The panel and the report previously
 * printed the raw ISO string, which is UTC: a user at UTC+8 read
 * "2026-09-29T18:41Z" as "yesterday" while their clock said 2026-09-30 02:41.
 */
function formatLocal(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `(UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)})`
}

function writeLastRun(result, reportPath) {
  const summary = {
    Ok: result.Ok,
    Agent: result.Agent,
    Mode: result.Mode,
    Time: new Date().toISOString(),
    TimeLocal: formatLocal(),
    Seconds: result.Seconds,
    ExitCode: result.ExitCode,
    Model: result.ModelReq,
    Session: result.Session,
    ToolCalls: result.Tools.length,
    Steps: result.ToolSteps,
    Cost: result.Cost,
    Tokens: result.Tokens,
    Answer: result.Answer,
    Report: reportPath,
    OutFile: result.OutFile,
    ErrFile: result.ErrFile,
    Args: result.Args,
    Exe: result.Exe,
  }
  try { writeFileSync(LAST_RUN_PATH, JSON.stringify(summary, null, 2), 'utf8') } catch (error) { warn('cannot write last-run.json', error) }
  return summary
}

/** Resolve the agent + recipe for a call, with actionable error text. */
function resolveTarget(state, requested) {
  const recipes = loadRecipes()
  if (!recipes.length) throw new Error('no agent recipes are installed (expected JSON files in lib/recipes)')
  const wanted = String(requested || state.defaultAgent || '').trim()
  const recipe = wanted ? recipes.find((r) => r.id === wanted) : recipes.find((r) => discover(r).length) || recipes[0]
  if (!recipe) throw new Error(`unknown agent "${wanted}"; known agents: ${recipes.map((r) => r.id).join(', ')}`)
  return recipe
}

async function runAgent(ctx, spec) {
  const state = readState()
  const recipe = resolveTarget(state, spec.agent)
  const found = discover(recipe)
  if (!found.length) {
    const where = (recipe.discover && recipe.discover.bin || []).join(', ') || recipe.id
    throw new Error(`agent "${recipe.id}" is not installed (looked for ${where} on PATH and in its known install paths)`)
  }
  const exe = found[0].path
  const configured = state.agents[recipe.id] || {}
  const model = String(spec.model || configured.model || '')
  const mode = FEATURE_KEYS.includes(spec.mode) ? spec.mode : 'default'
  const prompt = (MODE_PREFIX[mode] || '') + String(spec.prompt || '')

  const workdir = spec.workdir || WORK_DIR
  mkdirSync(workdir, { recursive: true })
  const { args, promptVia } = buildArgs(recipe, {
    prompt,
    model,
    agent: spec.agentName,
    session: spec.session,
    resume: spec.resume === true,
    files: Array.isArray(spec.files) ? spec.files.slice(0, 20) : [],
  })

  const raw = await launch(ctx, exe, args, {
    cwd: workdir,
    logDir: LOG_DIR,
    label: `${recipe.id}-${mode}`,
    timeoutMs: spec.timeoutMs || 600000,
    signal: spec.signal,
    // buildArgs leaves the prompt OUT of argv when a recipe declares
    // `prompt.via: "stdin"`; without handing it over here it would be dropped.
    stdinText: promptVia === 'stdin' ? prompt : '',
  })

  const result = normalize(recipe, {}, raw)
  result.Mode = mode
  result.ModelReq = model
  result.Args = args.join(' ')
  result.Exe = exe
  result.WorkDir = workdir
  const report = writeReport(result, { ...spec, workdir }, prompt)
  result.Report = report
  return { result, summary: writeLastRun(result, report) }
}

/* ------------------------------------------------------ JSON Schema safety */

/**
 * Every tool's `parameters` must ALREADY be a full JSON Schema object: the model
 * API rejects the entire request when any registered tool declares anything
 * else, which takes the whole session down. Validate before registering, and
 * never let a bad schema reach the wire.
 */
function wireLegal(definition) {
  const problems = []
  const params = definition && definition.parameters
  if (!params || typeof params !== 'object') problems.push('parameters must be an object')
  else {
    if (params.type !== 'object') problems.push(`parameters.type must be "object" (got ${JSON.stringify(params.type)})`)
    if (!params.properties || typeof params.properties !== 'object') problems.push('parameters.properties must be an object')
  }
  const output = definition && definition.output
  if (!output || typeof output !== 'object') problems.push('output must be an object')
  else if (!output.schema || output.schema.type !== 'object') problems.push('output.schema.type must be "object"')
  if (typeof definition.execute !== 'function') problems.push('execute must be a function')
  if (!output || typeof output.render !== 'function') problems.push('output.render must be a function')
  if (problems.length) throw new Error(`illegal tool definition for "${definition && definition.name}": ${problems.join('; ')}`)
  return definition
}

/**
 * Tool results are CONTENT PART ARRAYS: DSH calls `render(args, value)` and then
 * treats the return value as blocks (`content.some(...)`). Returning a bare
 * string breaks the call with "content.some is not a function" — measured in the
 * desktop app on 2026-09-30, on the first live agent_list.
 */
const textPart = (text) => [{ type: 'text', text }]

const renderText = (_args, value) => textPart(typeof value === 'string' ? value : JSON.stringify(value, null, 2))

function renderRun(_args, value) {
  const result = (value && value.result) || {}
  const summary = (value && value.summary) || {}
  if (!result.Ok) {
    const why = result.TimedOut
      ? `timed out after ${result.Seconds}s`
      : (result.SpawnError || (result.Stderr ? String(result.Stderr).split(/\r?\n/)[0] : 'no answer was produced'))
    return textPart([
      `[${result.Agent}] FAILED — ${why}`,
      `mode: ${result.Mode}  exit: ${result.ExitCode}  tool calls: ${(result.Tools || []).length}`,
      result.Answer ? `\n--- partial answer ---\n${result.Answer}` : '',
      summary.Report ? `report: ${summary.Report}` : '',
      result.OutFile ? `raw: ${result.OutFile}` : '',
    ].filter(Boolean).join('\n'))
  }
  return textPart([
    `[${result.Agent}] ok  mode=${result.Mode}  ${result.Seconds}s  session=${result.Session || '-'}  model=${result.ModelReq || 'default'}`,
    `tool calls: ${(result.Tools || []).length}  tokens in/out=${result.Tokens ? result.Tokens.Input : '?'}/${result.Tokens ? result.Tokens.Output : '?'}  cost=${result.Cost}`,
    '',
    '--- answer ---',
    result.Answer || '(empty)',
    summary.Report ? `\nreport: ${summary.Report}` : '',
  ].filter(Boolean).join('\n'))
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx) {
  logger = ctx.logger ? ctx.logger('agent-bridge') : null
  mkdirSync(WORK_DIR, { recursive: true })
  // Migrate eagerly so the state file exists from the moment the plugin mounts,
  // instead of whenever something happens to read it first.
  migrateLegacyState()

  ctx.effect(() => {
    // Only ctx.get() here: cordis' context is a proxy that THROWS on a service
    // property that was not declared in `inject`, and a thrown apply() fails the
    // whole entry (measured: "cannot get property connection without inject").
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      warn('tools service unavailable; agent tools were not registered')
      return () => {}
    }
    /** Every definition we register, so the compatibility aliases can reuse them. */
    const definitions = new Map()
    const registerTool = (definition) => {
      if (definition && typeof definition.name === 'string') definitions.set(definition.name, definition)
      /* One seam, applied to EVERY tool: DSH validates each result as lossless
       * JSON and rejects the whole call otherwise ("value is not lossless JSON").
       * Sanitizing here means no individual tool can forget — a single missing
       * optional field in one recipe once took down a complete agent_run. */
      const guarded = {
        ...definition,
        async execute(args, exec) {
          return jsonSafe(await definition.execute(args, exec))
        },
      }
      return tools.register(wireLegal(guarded))
    }
    const disposers = []

    try {
      disposers.push(ctx.effect(() => registerTool({
        name: 'agent_run',
        description:
          'Run one external coding-agent CLI (whatever the machine has installed: opencode, claude, codex, gemini, …) ' +
          'as an independent worker. Returns the agent answer, its session id, timing, tool calls and the path of a ' +
          'human-readable run report. Prefer this over guessing: agent_list reports what is actually installed.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The task or question for the external agent.' },
            agent: { type: 'string', description: 'Recipe id to use, e.g. "opencode". Omit to use the configured default (or the first installed agent).' },
            mode: { type: 'string', enum: ['default', 'verify', 'bulk', 'second'], description: 'Role prefix: verify/second forbid tool use and answer in one pass; bulk prefers direct answers.' },
            model: { type: 'string', description: 'Model id passed to the agent CLI (ignored when the agent has no model flag).' },
            session: { type: 'string', description: 'Existing agent session id to continue.' },
            resume: { type: 'boolean', description: 'Continue the given session (adds the agent resume flag).' },
            files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach when the agent supports it.' },
            timeoutMs: { type: 'number', description: 'Hard timeout; a timeout never triggers a retry. Default 600000.' },
            workdir: { type: 'string', description: 'Directory the agent runs in (and may edit). Defaults to a scratch dir under DSH_HOME.' },
          },
          required: ['prompt'],
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderRun },
        async execute(args, exec) {
          const { result, summary } = await runAgent(ctx, {
            prompt: args.prompt,
            agent: typeof args.agent === 'string' ? args.agent : '',
            mode: typeof args.mode === 'string' ? args.mode : '',
            model: typeof args.model === 'string' ? args.model : '',
            session: typeof args.session === 'string' ? args.session : '',
            resume: args.resume === true,
            files: Array.isArray(args.files) ? args.files : [],
            timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 600000,
            workdir: typeof args.workdir === 'string' && args.workdir ? args.workdir : '',
            signal: exec && exec.signal,
          })
          return { result, summary }
        },
      }), 'agent-bridge: agent_run tool'))
    } catch (error) {
      warn('agent_run registration failed', error)
    }

    try {
      disposers.push(ctx.effect(() => registerTool({
        name: 'agent_list',
        description:
          'List the agent CLIs this plugin can drive, where each one was found, what it costs, and which capabilities ' +
          '(model/session/resume/files) its recipe supports. With probe=true it also runs each CLI\'s --version, which ' +
          'is the only way to tell "installed" from "actually usable".',
        parameters: {
          type: 'object',
          properties: {
            probe: { type: 'boolean', description: 'Also run --version for every discovered agent (slower, but authoritative).' },
            selftest: { type: 'boolean', description: 'Validate every recipe, find its binary, and replay its recorded fixture — the honest "is this adapter actually working" answer.' },
          },
          required: [],
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
        async execute(args) {
          const state = readState()
          const body = { agents: agentsView(state), probed: false }
          if (args.selftest === true) {
            body.selftest = []
            for (const recipe of loadRecipes()) body.selftest.push(await selfTestRecipe(ctx, recipe, { probe: true }))
            body.testedAt = new Date().toISOString()
          }
          if (args.probe === true) {
            const probed = []
            for (const recipe of loadRecipes()) probed.push(await probeRecipe(ctx, recipe))
            body.probed = probed
            body.probedAt = new Date().toISOString()
          }
          return body
        },
      }), 'agent-bridge: agent_list tool'))
    } catch (error) {
      warn('agent_list registration failed', error)
    }

    try {
      disposers.push(ctx.effect(() => registerTool({
        name: 'agent_recipe',
        description:
          'Author a recipe for an agent CLI that has none yet, or check one. action=draft runs the given argv once, captures the raw output and returns a draft ' +
          'recipe together with every candidate field it found — the evidence, not just a conclusion. action=validate checks a recipe object. action=save validates ' +
          'a recipe and writes it to the LOCAL recipe directory, where agent_list picks it up immediately (a local recipe also overrides a bundled one with the same id).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['draft', 'validate', 'save', 'import'], description: 'What to do.' },
            url: { type: 'string', description: 'import: http(s) URL returning a recipe, an array of recipes, or {"recipes":[...]}. Every candidate is validated strictly and nothing in the payload is ever executed.' },
            exe: { type: 'string', description: 'draft: absolute path of the CLI to run. Required for draft — discovery is read-only and will not guess a binary to execute.' },
            argv: { type: 'array', items: { type: 'string' }, description: 'draft: the argument vector to run, with the prompt where this CLI expects it.' },
            recipe: { type: 'object', additionalProperties: true, description: 'validate/save: the recipe object itself.' },
            cwd: { type: 'string', description: 'draft: working directory (defaults to the bridge scratch directory).' },
            timeoutMs: { type: 'number', description: 'draft: hard timeout in milliseconds (default 120000).' },
          },
          required: ['action'],
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
        async execute(args) {
          const action = String(args.action || 'draft').toLowerCase()

          if (action === 'draft') {
            const argv = Array.isArray(args.argv) ? args.argv.map(String) : []
            if (argv.length === 0) throw new Error('draft needs argv, for example ["-p","hello","--output-format","json"]')
            const exe = typeof args.exe === 'string' && args.exe ? args.exe : ''
            if (!exe) throw new Error('draft needs exe: the absolute path of the CLI to run')
            const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : WORK_DIR
            mkdirSync(cwd, { recursive: true })
            const raw = await launch(ctx, exe, argv, {
              cwd,
              logDir: LOG_DIR,
              label: 'recipe-draft',
              timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 120000,
            })
            return {
              exe,
              exitCode: raw.exitCode,
              seconds: Number((raw.ms / 1000).toFixed(1)),
              timedOut: raw.timedOut,
              draft: draftFromRun({ stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode, argv }),
              stdoutChars: raw.stdout.length,
              stdoutHead: raw.stdout.slice(0, 1200),
              stderrHead: raw.stderr.slice(0, 400),
              rawFile: raw.outPath,
            }
          }

          if (action === 'import') return importRecipes(args.url)

          const recipe = args.recipe
          if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error(`${action} needs a recipe object`)
          const verdict = validateRecipe(recipe)
          const found = verdict.ok ? discover(recipe) : []

          if (action === 'validate') {
            return { valid: verdict.ok, problems: verdict.problems, warnings: verdict.warnings, discovery: found }
          }
          if (action !== 'save') throw new Error(`unknown action "${action}"`)
          if (!verdict.ok) return { saved: false, problems: verdict.problems, warnings: verdict.warnings }

          mkdirSync(LOCAL_RECIPE_DIR, { recursive: true })
          const target = join(LOCAL_RECIPE_DIR, `${recipe.id}.json`)
          let overridesBundled = false
          try { overridesBundled = readdirSync(RECIPE_DIR).includes(`${recipe.id}.json`) } catch { overridesBundled = false }
          writeFileSync(target, JSON.stringify(recipe, null, 2), 'utf8')
          return { saved: true, path: target, overridesBundled, warnings: verdict.warnings, discovery: found }
        },
      }), 'agent-bridge: agent_recipe tool'))
    } catch (error) {
      warn('agent_recipe registration failed', error)
    }

    try {
      disposers.push(ctx.effect(() => registerTool({
        name: 'agent_mode',
        description:
          'Read or change the agent-bridge state shown by the GUI button: auto (hand everything to DeepSeek Harness), ' +
          'defaultAgent, defaultMode, which role features are enabled, and the per-agent model selection.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set'], description: 'Read the state, or write the given fields.' },
            auto: { type: 'boolean', description: 'true = DSH handles everything itself and external agents are off by default.' },
            defaultAgent: { type: 'string', description: 'Recipe id used when a call does not name an agent.' },
            defaultMode: { type: 'string', enum: ['default', 'verify', 'bulk', 'second'], description: 'Mode used when a call does not name one.' },
            verify: { type: 'boolean', description: 'Enable the cross-model verification feature.' },
            bulk: { type: 'boolean', description: 'Enable the cheap bulk execution feature.' },
            second: { type: 'boolean', description: 'Enable the second-opinion feature.' },
            model: { type: 'string', description: 'Model for the agent named by the `agent` field.' },
            agent: { type: 'string', description: 'Which agent the `model` field applies to.' },
          },
          required: ['action'],
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderText },
        async execute(args) {
          const action = String(args.action || 'get').toLowerCase()
          const current = readState()
          if (action !== 'set') return { state: current, agents: agentsView(current) }
          const enabled = { ...current.enabled }
          for (const key of FEATURE_KEYS) if (typeof args[key] === 'boolean') enabled[key] = args[key]
          const agents = { ...current.agents }
          if (typeof args.agent === 'string' && args.agent && typeof args.model === 'string') {
            agents[args.agent] = { ...(agents[args.agent] || {}), model: args.model }
          }
          const next = coerceState({
            auto: typeof args.auto === 'boolean' ? args.auto : current.auto,
            defaultAgent: typeof args.defaultAgent === 'string' ? args.defaultAgent : current.defaultAgent,
            defaultMode: typeof args.defaultMode === 'string' ? args.defaultMode : current.defaultMode,
            enabled,
            agents,
          })
          return { state: next, saved: writeState(next), agents: agentsView(next) }
        },
      }), 'agent-bridge: agent_mode tool'))
    } catch (error) {
      warn('agent_mode registration failed', error)
    }

    /* Backward-compatible aliases for dsh-opencode-bridge, registered
     * best-effort: if the old plugin is still mounted it owns these names, the
     * registration throws, and the entry lives on instead of failing. */
    const ALIASES = [
      ['opencode_run', 'agent_run', 'opencode'],
      ['opencode_mode', 'agent_mode', null],
    ]
    for (const [aliasName, sourceName, forcedAgent] of ALIASES) {
      const source = definitions.get(sourceName)
      if (!source) continue
      try {
        disposers.push(ctx.effect(() => registerTool({
          name: aliasName,
          description: `Backward-compatible alias of ${sourceName}${forcedAgent ? ` with agent forced to "${forcedAgent}"` : ''}. Prefer ${sourceName} in new work.`,
          parameters: source.parameters,
          output: source.output,
          async execute(args, exec) {
            return source.execute(forcedAgent ? { ...args, agent: forcedAgent } : args, exec)
          },
        }), `agent-bridge: ${aliasName} alias`))
      } catch (error) {
        warn(`compatibility alias ${aliasName} was not registered`, error)
      }
    }

    toolsReady = disposers.length > 0
    return () => { for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } } }
  }, 'agent-bridge: tool registration')

  // The HTTP route goes inside a NESTED injection on `connection` — the pattern
  // DSH's own web-app bundle uses at packages/bundle/web-app/src/index.ts:253.
  // Two reasons it must not be a plain `ctx.get('connection')`:
  //   * cordis' context is a proxy that THROWS when a service is not in the
  //     fiber chain ("cannot get property connection without inject"), and a
  //     throw in apply() fails the entire entry — measured on the first
  //     web-profile boot of this plugin;
  //   * a nested injection keeps the plugin mountable in profiles with no
  //     connection service at all (headless/tui), where the tools still matter.
  ctx.inject(['connection'], (routeCtx) => {
    const connection = routeCtx.get('connection')
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      warn('connection service exposes no fetch.register; the GUI button has no backend')
      return
    }
    try {
      routeCtx.effect(() => connection.fetch.register({
        path: '/api/agent.bridge',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let url
          try { url = new URL(request.url, 'http://127.0.0.1') } catch { url = new URL('http://127.0.0.1/') }
          const params = url.searchParams
          let state = readState()
          let saved = false
          if (params.get('save') === '1') {
            const enabled = { ...state.enabled }
            for (const key of FEATURE_KEYS) {
              const value = params.get(key)
              if (value !== null) enabled[key] = value === '1' || value === 'true'
            }
            const agents = { ...state.agents }
            const agentId = params.get('agent')
            const model = params.get('model')
            if (agentId && model !== null) agents[agentId] = { ...(agents[agentId] || {}), model }
            const auto = params.get('auto')
            const defaultAgent = params.get('defaultAgent')
            const defaultMode = params.get('defaultMode')
            state = coerceState({
              auto: auto === null ? state.auto : auto === '1' || auto === 'true',
              defaultAgent: defaultAgent === null ? state.defaultAgent : defaultAgent,
              defaultMode: defaultMode === null ? state.defaultMode : defaultMode,
              enabled,
              agents,
            })
            saved = writeState(state)
          }
          const body = {
            state,
            saved,
            agents: agentsView(state),
            features: FEATURE_KEYS,
            diagnostics: { toolsRegistered: toolsReady },
          }
          if (params.get('last') === '1') body.last = readLastRun()
          if (params.get('selftest') === '1') {
            body.selftest = []
            for (const recipe of loadRecipes()) body.selftest.push(await selfTestRecipe(ctx, recipe, { probe: true }))
            body.testedAt = new Date().toISOString()
          }
          if (params.get('probe') === '1') {
            const probed = []
            for (const recipe of loadRecipes()) probed.push(await probeRecipe(ctx, recipe))
            body.probed = probed
            body.probedAt = new Date().toISOString()
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        },
      }), 'agent-bridge: /api/agent.bridge route')
    } catch (error) {
      warn('route registration failed', error)
    }
  })
}
