/**
 * Host-half harness: mount the plugin against a FAKE cordis context and drive
 * its real tools and route. This covers everything except DSH's own service
 * wiring: state IO, recipe loading, discovery, launching a real agent, output
 * normalization, report writing, the HTTP route, and the tool-schema gate.
 *
 * It runs on the developer machine, so it also proves the plugin works with the
 * direct (no service) launch path.
 */

import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { findLosslessViolation, isLosslessJson } from './lossless.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where written state goes. The host half resolves DSH_HOME when it is IMPORTED,
 * so this must be exported to the module before importing it: a constant of the
 * test's own lets the host fall back to `~/.dsh` while the assertions look
 * somewhere else — which is exactly how this failed on CI. A machine with no DSH
 * home gets a disposable directory instead of a literal `C:\Users\...` path,
 * which on Linux would be created as a directory with that very name.
 */
const DSH_HOME = process.env.DSH_HOME
  || (existsSync('C:\\Users\\ROG\\.dsh') ? 'C:\\Users\\ROG\\.dsh' : mkdtempSync(join(tmpdir(), 'agent-bridge-home-')))
process.env.DSH_HOME = DSH_HOME
const LAST_RUN = join(DSH_HOME, 'tools', 'agent-bridge', 'logs', 'last-run.json')
const WORK_DIR = join(DSH_HOME, 'tools', 'agent-bridge', 'work')
const { apply } = await import('../lib/host.js')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

/* ------------------------------------------------------------- fake context */

const tools = new Map()
const routes = []
const warnings = []
const ctx = {
  logger: () => ({ warn: (...args) => { warnings.push(args.join(' ')); console.log('[warn]', ...args) } }),
  get: (key) => {
    if (key === 'tools') return { register: (definition) => { tools.set(definition.name, definition); return () => {} } }
    if (key === 'connection') return { fetch: { register: (route) => { routes.push(route); return () => {} } } }
    return undefined
  },
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  // Nested injection: a real cordis context hands the callback a child scope
  // whose `get` sees the injected services (and whose `.connection` access is
  // legal). The harness always has them, so it just runs the callback.
  inject: (deps, callback) => {
    const scope = { get: ctx.get, effect: ctx.effect, logger: ctx.logger }
    callback(scope)
    return () => {}
  },
}

apply(ctx)

/* ------------------------------------------------------- registration checks */

check('registers agent_run / agent_list / agent_mode',
  tools.has('agent_run') && tools.has('agent_list') && tools.has('agent_mode'),
  [...tools.keys()].join(', '))
check('registers the recipe wizard tool', tools.has('agent_recipe'), [...tools.keys()].join(', '))
check('registers the /api/agent.bridge route',
  routes.length === 1 && routes[0].path === '/api/agent.bridge', routes.map((r) => r.path).join(', '))

// The model API rejects the WHOLE request when any tool schema is not a full
// JSON Schema object, so this must hold for every tool, always.
for (const [toolName, definition] of tools) {
  const params = definition.parameters
  check(`${toolName}: parameters is a JSON Schema object`,
    params && params.type === 'object' && params.properties && typeof params.properties === 'object',
    `type=${params && params.type}`)
  check(`${toolName}: output.schema is an object schema`,
    definition.output && definition.output.schema && definition.output.schema.type === 'object')
}

/* Render contract: DSH calls render(args, value) and treats the result as
 * content blocks. Returning a bare string breaks the call in the live app with
 * "content.some is not a function" — a bug the execute()-only tests missed. */
const RENDER_SAMPLES = {
  agent_run: {
    result: {
      Ok: true, Agent: 'opencode', Mode: 'default', Seconds: 1, ExitCode: 0, Session: 'ses_x',
      Answer: 'hi', ModelReq: '', Tools: [], ToolSteps: 0, Cost: 0, Tokens: { Input: 0, Output: 0 },
      OutFile: 'x', ErrFile: 'y', Stderr: '', TimedOut: false, SpawnError: '',
    },
    summary: { Report: 'r' },
  },
  opencode_run: null, // filled below from agent_run
  agent_list: { agents: [{ id: 'opencode' }], probed: false },
  opencode_mode: null, // filled below from agent_mode
  agent_mode: { state: { auto: true }, agents: [] },
  agent_recipe: { valid: true, problems: [], warnings: [] },
}
RENDER_SAMPLES.opencode_run = RENDER_SAMPLES.agent_run
RENDER_SAMPLES.opencode_mode = RENDER_SAMPLES.agent_mode

for (const [toolName, definition] of tools) {
  const sample = RENDER_SAMPLES[toolName] === undefined ? { ok: true } : RENDER_SAMPLES[toolName]
  let rendered = null
  try { rendered = definition.output.render({}, sample) } catch (error) { rendered = `threw: ${error.message}` }
  check(`${toolName}: render() returns content blocks (not a bare string)`,
    Array.isArray(rendered) && rendered.length > 0
      && rendered.every((block) => block && block.type === 'text' && typeof block.text === 'string'),
    Array.isArray(rendered) ? `blocks=${rendered.length}` : String(rendered))
}

/* ------------------------------------------------------------ route contents */

const routeFetch = async (query) => {
  const response = await routes[0].fetch({ url: `http://127.0.0.1/api/agent.bridge${query}` })
  return response.json()
}

const initial = await routeFetch('?last=1')
check('route returns state + agents + features',
  Boolean(initial.state) && Array.isArray(initial.agents) && Array.isArray(initial.features),
  `agents=${initial.agents.length}`)
const opencodeRow = initial.agents.find((a) => a.id === 'opencode')
check('route lists the opencode recipe',
  Boolean(opencodeRow) && initial.agents.some((a) => a.id === 'claude'),
  JSON.stringify(initial.agents.map((a) => `${a.id}:${a.installed ? 'found' : 'missing'}`)))
if (opencodeRow && opencodeRow.installed) {
  check('the installed opencode binary is the one the route reports', /opencode/i.test(opencodeRow.path), opencodeRow.path)
} else {
  console.log('SKIP opencode binary discovery: not installed on this machine (tests/discovery-matrix.mjs covers discovery)')
}
check('every agent carries cost + caps', initial.agents.every((a) => typeof a.cost === 'string' && a.caps))

const saved = await routeFetch('?save=1&auto=0&defaultAgent=opencode&defaultMode=verify&verify=1&bulk=0&second=0&agent=opencode&model=opencode/mimo-v2.6-flash-free')
check('route persists state', saved.saved === true && saved.state.auto === false && saved.state.defaultMode === 'verify',
  JSON.stringify(saved.state))
check('route stores a per-agent model', saved.state.agents.opencode && saved.state.agents.opencode.model === 'opencode/mimo-v2.6-flash-free',
  JSON.stringify(saved.state.agents))
check('route keeps the model behind the agent key', saved.agents.find((a) => a.id === 'opencode').model === 'opencode/mimo-v2.6-flash-free')

/* ---------------------------------------------------------------- tool calls */

const list = await tools.get('agent_list').execute({ probe: false })
check('agent_list returns one row per recipe', Array.isArray(list.agents) && list.agents.length >= 2,
  list.agents.map((a) => `${a.id}(${a.cost}${a.installed ? '' : ',missing'})`).join(', '))
check('the paid agent is flagged as paid, not hidden',
  list.agents.some((a) => a.id === 'claude' && a.cost === 'paid'),
  JSON.stringify(list.agents.find((a) => a.id === 'claude') || null))

const probed = await tools.get('agent_list').execute({ probe: true })
const opencodeProbe = (probed.probed || []).find((p) => p.id === 'opencode')
// `--version` can only be asserted where the CLI exists. The probe PLUMBING is
// covered everywhere by the recorded fixtures, so a machine without it skips
// rather than fails.
if (opencodeProbe && opencodeProbe.installed) {
  check('probe reports an installed, usable opencode', Boolean(opencodeProbe.ok),
    `exit=${opencodeProbe.exitCode} version=${opencodeProbe.version}`)
  check('probe surfaces a version string', /opencode/i.test(opencodeProbe.version || ''), opencodeProbe.version)
} else {
  console.log('SKIP --version probe: no opencode installation on this machine')
}

const mode = await tools.get('agent_mode').execute({ action: 'get' })
check('agent_mode get returns state + agents', Boolean(mode.state) && Array.isArray(mode.agents))

if (process.env.SKIP_LIVE_RUN === '1') {
  console.log('\n(skipping the live agent run: SKIP_LIVE_RUN=1)')
} else {
  /* ----------------------------------------------------- recipe wizard flow */
  const recipeTool = tools.get('agent_recipe')
  const malformed = await recipeTool.execute({ action: 'validate', recipe: { id: 'Bad Id', label: '', cost: 'cheap' } })
  check('agent_recipe validate rejects a malformed recipe',
    malformed.valid === false && malformed.problems.length >= 4, malformed.problems.join('; '))

  const shipped = JSON.parse(readFileSync(join(PKG_ROOT, 'lib', 'recipes', 'opencode.json'), 'utf8'))
  const accepted = await recipeTool.execute({ action: 'validate', recipe: shipped })
  check('agent_recipe validate accepts a shipped recipe and finds its binary',
    accepted.valid === true && accepted.discovery.length > 0,
    `${accepted.valid} ${JSON.stringify(accepted.discovery.slice(0, 1))}`)

  const opencodePath = (list.agents.find((a) => a.id === 'opencode') || {}).path || ''
  const drafted = await recipeTool.execute({
    action: 'draft',
    exe: opencodePath,
    argv: ['run', '--auto', '--format', 'json', 'Reply with exactly: DRAFT-OK'],
    timeoutMs: 120000,
  })
  check('draft runs an unknown CLI and classifies its stream',
    drafted.exitCode === 0 && drafted.draft.output.format === 'jsonl',
    `exit=${drafted.exitCode} format=${drafted.draft && drafted.draft.output.format} seconds=${drafted.seconds}`)
  check('draft recovers the answer path from the REAL stream (part.text)',
    Boolean(drafted.draft.output.answer) && drafted.draft.output.answer.pick === 'part.text',
    JSON.stringify(drafted.draft.output.answer))
  check('draft hands back the evidence, not just a conclusion',
    Array.isArray(drafted.draft._draft.answerCandidates) && drafted.draft._draft.answerCandidates.includes('part.text'),
    JSON.stringify(drafted.draft._draft.answerCandidates))

  const localRecipe = {
    id: 'harness-fixture-agent',
    label: 'Harness Fixture Agent',
    cost: 'free',
    discover: { bin: ['definitely-not-installed-xyz'] },
    run: { argv: ['ask'], prompt: { via: 'positional' } },
    output: { format: 'text', answer: { pick: 'text' } },
  }
  const savedLocal = await recipeTool.execute({ action: 'save', recipe: localRecipe })
  check('agent_recipe save writes a local recipe', savedLocal.saved === true && existsSync(savedLocal.path), savedLocal.path)
  const withLocal = await tools.get('agent_list').execute({})
  check('a locally saved recipe joins agent_list immediately',
    withLocal.agents.some((a) => a.id === 'harness-fixture-agent' && a.installed === false),
    withLocal.agents.map((a) => a.id).join(', '))
  if (savedLocal.path) unlinkSync(savedLocal.path)

  /* ------------------------------------------------------------- self test */
  const selfTested = await tools.get('agent_list').execute({ selftest: true })
  check('selftest returns a verdict per recipe',
    Array.isArray(selfTested.selftest) && selfTested.selftest.length >= 2,
    JSON.stringify((selfTested.selftest || []).map((r) => r.id)))
  check('selftest passes every installed agent, including its recorded fixture',
    (selfTested.selftest || []).filter((r) => r.installed).every((r) => r.ok && r.fixture && r.fixture.ok),
    JSON.stringify((selfTested.selftest || []).map((r) => ({
      id: r.id, ok: r.ok, installed: r.installed,
      fixtureOk: r.fixture ? r.fixture.ok : null, probeOk: r.probe ? r.probe.ok : null,
    }))))

  const started = Date.now()
  const { result, summary } = await tools.get('agent_run').execute({
    prompt: 'Reply with exactly: HOST-OK',
    agent: 'opencode',
    mode: 'default',
    timeoutMs: 120000,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  check('agent_run produced an answer', result.Ok === true && result.Answer.includes('HOST-OK'),
    `ok=${result.Ok} answer=${JSON.stringify(result.Answer)} elapsed=${elapsed}s`)
  // What matters is "no retry" and "no runaway tool use"; step_finish events can
  // appear for a plain one-step answer depending on the CLI version, so the
  // assertion is on tool CALLS, not steps.
  check('agent_run did not retry, time out, or reach for tools',
    result.TimedOut === false && result.Tools.length === 0,
    `timedOut=${result.TimedOut} tools=${result.Tools.length} steps=${result.ToolSteps}`)
  check('agent_run reports the agent id and mode', result.Agent === 'opencode' && result.Mode === 'default',
    `${result.Agent}/${result.Mode}`)
  check('agent_run extracted a session id', /^ses_/.test(result.Session), result.Session)
  check('agent_run wrote a markdown report', Boolean(summary.Report) && existsSync(summary.Report), summary.Report)
  check('agent_run published last-run.json', existsSync(LAST_RUN) && JSON.parse(readFileSync(LAST_RUN, 'utf8')).Answer.includes('HOST-OK'), LAST_RUN)
  check('report contains the answer and the prompt', (() => {
    if (!summary.Report || !existsSync(summary.Report)) return false
    const text = readFileSync(summary.Report, 'utf8')
    return text.includes('HOST-OK') && text.includes('## 答案') && text.includes('## 提示词')
  })(), summary.Report)
  check('the run records HOW the process was launched',
    result.Via === 'subprocess-service' || result.Via === 'direct', result.Via)
  check('the report shows the launch method (parity with the predecessor)', (() => {
    if (!summary.Report || !existsSync(summary.Report)) return false
    return readFileSync(summary.Report, 'utf8').includes('| 启动方式 |')
  })(), result.Via)

  // DSH validates every tool result as lossless JSON and rejects the entire call
  // otherwise ("value is not lossless JSON") — so this is a hard contract.
  check('agent_run returns lossless JSON',
    isLosslessJson({ result, summary }), findLosslessViolation({ result, summary }) || 'clean')
  check('last-run.json carries a LOCAL time for the panel',
    Boolean(summary.TimeLocal) && /UTC[+-]\d{2}:\d{2}/.test(summary.TimeLocal), summary.TimeLocal)
  check('the report prints local time with its offset, not a bare UTC ISO string',
    /\| 时间 \| \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\) \|/.test(readFileSync(summary.Report, 'utf8')),
    summary.TimeLocal)
  check('stdout log file exists', existsSync(result.OutFile), result.OutFile)

  const verifyRun = await tools.get('agent_run').execute({
    prompt: '用一句话说明 semver 里 ^0.1.1-rc.2 为什么排除 0.2.0-rc.2',
    agent: 'opencode',
    mode: 'verify',
    timeoutMs: 120000,
  })
  check('verify mode forbids tools and still answers in one pass',
    verifyRun.result.Ok === true && verifyRun.result.Tools.length === 0 && verifyRun.result.Answer.length > 0,
    `ok=${verifyRun.result.Ok} tools=${verifyRun.result.Tools.length} seconds=${verifyRun.result.Seconds}`)
  check('verify mode really injected the no-tools prefix',
    /Do NOT call any tool/.test(verifyRun.result.Args) && /INDEPENDENT VERIFIER/.test(verifyRun.result.Args))
}

const unknown = await tools.get('agent_run').execute({ prompt: 'x', agent: 'definitely-not-installed' }).catch((e) => ({ error: String(e.message || e) }))
check('an unknown agent fails with an actionable message', Boolean(unknown.error && /known agents/.test(unknown.error)), unknown.error)

/* The paid adapter is opt-in: it spends the user's credits, so the default test
 * run must not touch it. Set LIVE_PAID=1 to verify it end to end. */
if (process.env.LIVE_PAID === '1') {
  const paid = await tools.get('agent_run').execute({
    prompt: 'Reply with exactly: CLAUDE-OK',
    agent: 'claude',
    mode: 'default',
    timeoutMs: 180000,
  })
  check('paid agent (claude) runs through the same pipeline',
    paid.result.Ok === true && /CLAUDE-OK/.test(paid.result.Answer),
    `ok=${paid.result.Ok} answer=${JSON.stringify(paid.result.Answer)} seconds=${paid.result.Seconds}`)
  check('paid agent surfaces its real cost', paid.result.Cost > 0, String(paid.result.Cost))
  check('paid agent extracted a session id', /^[0-9a-f-]{8,}$/.test(paid.result.Session), paid.result.Session)
}

/* ----------------------------------------------------------------------------
 * Opt-in: a run that actually USES a tool (LIVE_TOOLS=1).
 *
 * This is the scenario that exposed a real defect: a tool-using stream left an
 * optional field `undefined`, DSH rejected the whole result as "not lossless
 * JSON", and a perfectly successful agent_run was reported as a failed call.
 * It runs a real agent, so it stays opt-in.
 * ------------------------------------------------------------------------- */
if (process.env.LIVE_TOOLS === '1') {
  const proofPath = join(WORK_DIR, `tool-proof-${Date.now()}.txt`)
  const marker = `TOOL-PROOF-${Date.now()}`
  const toolRun = await tools.get('agent_run').execute({
    agent: 'opencode',
    prompt: `Create a file at ${proofPath} whose content is exactly ${marker} (no trailing newline). Then reply with the single word DONE.`,
    timeoutMs: 180000,
  })
  check('a run that USES a tool still returns lossless JSON',
    isLosslessJson({ result: toolRun.result, summary: toolRun.summary }),
    findLosslessViolation({ result: toolRun.result, summary: toolRun.summary }) || 'clean')
  check('the tool call is reported, with no undefined members in the entry',
    toolRun.result.Tools.length >= 1 && isLosslessJson(toolRun.result.Tools),
    JSON.stringify(toolRun.result.Tools))
  check('the external agent really executed the write (the file is on disk)',
    existsSync(proofPath) && readFileSync(proofPath, 'utf8').includes(marker),
    `${proofPath}`)
  check('tool-using runs report their token usage',
    toolRun.result.Tokens.Input + toolRun.result.Tokens.Output > 0,
    JSON.stringify(toolRun.result.Tokens))
  try { unlinkSync(proofPath) } catch { /* leave it if it is already gone */ }
}

console.log(`\nwarnings during mount: ${warnings.length}`)
console.log(`${failures === 0 ? 'HOST HARNESS: PASS' : `HOST HARNESS: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
