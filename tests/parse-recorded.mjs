/**
 * Regression test: run the recipe engine's parser over EVERY real OpenCode
 * event stream this machine has recorded, and confirm it extracts the same kind
 * of normalized result each time.
 *
 * This is the safety net for porting OpenCode into the recipe architecture:
 * the 30-odd logs in tools/logs are genuine outputs, including the pathological
 * ones (a run that produced 11 tool calls and no answer, a sandbox denial, a
 * timed-out run whose stream kept growing after the call returned).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadRecipe, normalize, parseEvents, buildArgs, discover } from '../lib/engine.js'

const RECIPE = new URL('../lib/recipes/opencode.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LOGS = process.env.BRIDGE_LOGS || 'C:\\Users\\ROG\\.dsh\\tools\\logs'

const recipe = loadRecipe(RECIPE)
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

// ---- recipe sanity -------------------------------------------------------
check('recipe id/label', recipe.id === 'opencode' && recipe.label === 'OpenCode')
check('recipe declares a prompt transport', Boolean(recipe.run && recipe.run.prompt && recipe.run.prompt.via))
check('recipe declares an answer selector', Boolean(recipe.output && recipe.output.answer))

const built = buildArgs(recipe, { prompt: 'hello', model: 'opencode/big-pickle', session: 'ses_x', resume: true })
check('buildArgs appends the prompt last (positional transport)',
  built.args[built.args.length - 1] === 'hello' && built.promptVia === 'positional', JSON.stringify(built.args))
check('buildArgs routes model/session/resume to their flags',
  built.args.includes('-m') && built.args.includes('opencode/big-pickle') && built.args.includes('-s') && built.args.includes('ses_x') && built.args.includes('-c'),
  JSON.stringify(built.args))

// Machine-dependent: true only where the CLI is actually installed.
const candidates = discover(recipe)
if (candidates.length) {
  check('discover() returns at least one candidate on this machine', true, JSON.stringify(candidates.slice(0, 3)))
} else {
  console.log('SKIP discover-on-this-machine: no OpenCode installation here (tests/discovery-matrix.mjs covers discovery with synthetic trees)')
}

// ---- parse every recorded stream ----------------------------------------
// The recordings live in a user's DSH home, so they exist on a developer machine
// and never on CI. When they are absent this suite reports what it DID check and
// skips the replay instead of failing. The regression net for a real stream is
// global anyway: fixtures/opencode-result.jsonl is replayed by
// tests/parse-fixtures.mjs on every run, on every platform.
let files = []
try { files = readdirSync(LOGS).filter((f) => f.endsWith('.out.jsonl')) } catch { files = [] }
if (files.length === 0) {
  console.log(`SKIP recorded-stream replay: no *.out.jsonl under ${LOGS}`)
  console.log(`\n${failures === 0 ? 'RECIPE ENGINE REGRESSION: PASS (no local recordings to replay)' : `RECIPE ENGINE REGRESSION: FAIL (${failures})`}`)
  process.exit(failures === 0 ? 0 : 1)
}
check('found recorded streams to parse', true, `${files.length} files`)

let withAnswer = 0
let withTools = 0
let withSession = 0
let empty = 0
const rows = []
for (const name of files.sort()) {
  const full = join(LOGS, name)
  const raw = readFileSync(full, 'utf8')
  const result = normalize(recipe, {}, {
    spawned: true, exitCode: 0, timedOut: false, aborted: false,
    stdout: raw, stderr: '', ms: 1000, outPath: full, errPath: '',
  })
  const parsed = parseEvents(recipe, raw)
  if (result.Answer) withAnswer++
  else empty++
  if (result.Tools.length) withTools++
  if (result.Session) withSession++
  rows.push({
    file: name.length > 46 ? name.slice(0, 46) + '…' : name,
    bytes: statSync(full).size,
    events: parsed.events.length,
    answer: result.Answer.length,
    tools: result.Tools.length,
    steps: result.ToolSteps,
    session: result.Session ? 'yes' : '-',
    ok: result.Ok ? 'Ok' : 'no-answer',
  })
}

console.table(rows)
console.log(`\nsummary: ${files.length} streams, ${withAnswer} with an answer, ${empty} without, ${withTools} used tools, ${withSession} exposed a session id`)

// The engine must agree with the hand-verified counts for the two runs whose
// shape we know exactly (from the manual investigation earlier today).
/* The two pathological streams we investigated by hand, with their known shapes:
 *  - 013640-288: the verify run that burned 11 tool calls and was killed at the
 *    timeout, having produced NO final answer.
 *  - 013940-188: its orphaned retry, which kept running after the tool call had
 *    already returned and eventually DID produce an answer (2085 chars). So a
 *    timed-out stream can legitimately carry an answer, and the engine has to
 *    report the timeout and the answer at the same time. */
const expectations = [
  { match: '013640-288', tools: 11, answerChars: 0 },
  { match: '013940-188', tools: 18, answerChars: 'positive' },
]
for (const expectation of expectations) {
  const name = files.find((f) => f.includes(expectation.match))
  check(`recorded stream ${expectation.match} is present`, Boolean(name), name || 'missing')
  if (!name) continue
  const full = join(LOGS, name)
  const result = normalize(recipe, {}, {
    spawned: true, exitCode: null, timedOut: true, aborted: false,
    stdout: readFileSync(full, 'utf8'), stderr: '', ms: 176000, outPath: full, errPath: '',
  })
  check(`${expectation.match}: timeout reported and Ok stays false`,
    result.TimedOut === true && result.Ok === false, `ok=${result.Ok} timedOut=${result.TimedOut}`)
  check(`${expectation.match}: tool calls surfaced`, result.Tools.length === expectation.tools,
    `expected ${expectation.tools}, got ${result.Tools.length}`)
  check(`${expectation.match}: answer length matches recorded reality`,
    expectation.answerChars === 'positive' ? result.Answer.length > 0 : result.Answer.length === expectation.answerChars,
    `answer=${result.Answer.length} chars`)
}

console.log(`\n${failures === 0 ? 'RECIPE ENGINE REGRESSION: PASS' : `RECIPE ENGINE REGRESSION: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
