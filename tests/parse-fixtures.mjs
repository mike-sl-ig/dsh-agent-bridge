/**
 * Recipe + fixture tests: every recipe must parse its recorded real output into
 * the normalized shape, and the failure shapes must not be mistaken for answers.
 *
 * Fixtures are REAL captures committed next to the recipe they describe, so a
 * recipe whose CLI changes behaviour fails here before it fails for a user.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discover, loadRecipe, normalize } from '../lib/engine.js'
import { findLosslessViolation, isLosslessJson } from './lossless.mjs'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const RECIPES = join(HERE, '..', 'lib', 'recipes')
const FIXTURES = join(HERE, '..', 'fixtures')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

/** Run a fixture through a recipe exactly as a real launch would. */
function parseFixture(recipe, text, overrides = {}) {
  return normalize(recipe, {}, {
    spawned: true,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    stdout: text,
    stderr: '',
    ms: 1000,
    outPath: '(fixture)',
    errPath: '(fixture)',
    ...overrides,
  })
}

const claude = loadRecipe(join(RECIPES, 'claude.json'))
const claudeOut = readFileSync(join(FIXTURES, 'claude-result.json'), 'utf8')
const parsed = parseFixture(claude, claudeOut)

check('claude: fixture parses to Ok', parsed.Ok === true, `ok=${parsed.Ok}`)
check('claude: answer picked from .result', parsed.Answer === 'CLAUDE-OK', JSON.stringify(parsed.Answer))
check('claude: session picked from .session_id',
  parsed.Session === '717c86c7-c63e-46c5-a9bc-cc951ce0f3a5', parsed.Session)
check('claude: cost picked from .total_cost_usd', Math.abs(parsed.Cost - 0.094025) < 1e-9, String(parsed.Cost))
check('claude: tokens picked from .usage.*',
  parsed.Tokens.Input === 18775 && parsed.Tokens.Output === 6 && parsed.Tokens.CacheRead === 0,
  JSON.stringify(parsed.Tokens))
check('claude: the paid cost is surfaced, not hidden', parsed.Cost > 0 && claude.cost === 'paid')

// A failing Claude run still exits 0; only is_error says so.
const failed = JSON.parse(claudeOut)
failed.is_error = true
failed.subtype = 'error_during_execution'
failed.result = ''
const failedParsed = parseFixture(claude, JSON.stringify(failed))
check('claude: is_error forces Ok=false even with exit code 0',
  failedParsed.Ok === false && failedParsed.ErrorFlag === true, `ok=${failedParsed.Ok} flag=${failedParsed.ErrorFlag}`)

// A timed-out run must never look like a success.
const timedOut = parseFixture(claude, claudeOut, { timedOut: true, exitCode: null })
check('claude: a timeout beats a parseable answer', timedOut.Ok === false && timedOut.TimedOut === true)

// Discovery must prefer the real entry behind a package-manager shim.
const found = discover(claude)
check('claude: discovery returns at least one candidate', found.length > 0, JSON.stringify(found.slice(0, 3)))
if (found.length) {
  const first = found[0].path
  const isRealEntry = /claude(\.exe)?$/i.test(first) && !/\.(ps1|cmd|bat)$/i.test(first)
  check('claude: the spawnable entry outranks any .ps1/.cmd shim', isRealEntry, `${first} (source=${found[0].source})`)
}

// Every recipe in the directory must at least be loadable and self-consistent.
for (const file of readdirSync(RECIPES).filter((f) => f.endsWith('.json'))) {
  const recipe = loadRecipe(join(RECIPES, file))
  check(`${file}: declares id, run.argv, answer selector and a prompt transport`,
    Boolean(recipe.id && recipe.run && recipe.run.argv && recipe.run.prompt && recipe.output && recipe.output.answer),
    recipe.id)
  check(`${file}: declares a cost class`,
    ['free', 'paid', 'unknown'].includes(recipe.cost), `${file} cost=${recipe.cost}`)
}

// The OpenCode recipe gets the same treatment against a real recorded stream.
const opencode = loadRecipe(join(RECIPES, 'opencode.json'))
const opencodeOut = readFileSync(join(FIXTURES, 'opencode-result.jsonl'), 'utf8')
const opencodeParsed = parseFixture(opencode, opencodeOut)
check('opencode: recorded stream parses to Ok', opencodeParsed.Ok === true, `ok=${opencodeParsed.Ok}`)
check('opencode: the verify answer text survives the round trip',
  opencodeParsed.Answer.length > 50 && /caret|0\.1\.1|0\.2\.0/.test(opencodeParsed.Answer),
  `${opencodeParsed.Answer.length} chars`)
check('opencode: session id extracted from the stream', /^ses_/.test(opencodeParsed.Session), opencodeParsed.Session)
check('opencode: a verify run reports zero tool calls', opencodeParsed.Tools.length === 0, `${opencodeParsed.Tools.length}`)

/* ------------------------------- lossless JSON, the boundary DSH enforces ---
 * A tool result that is not lossless JSON fails the WHOLE tool call. The bug
 * this reproduces: OpenCode emits no `part.state.error` on success, so the tool
 * entry carried `Note: undefined`, which JSON.stringify silently drops. */

const claudeParsed = parseFixture(claude, readFileSync(join(FIXTURES, 'claude-result.json'), 'utf8'))
for (const [name, parsed] of [['claude', claudeParsed], ['opencode', opencodeParsed]]) {
  const violation = findLosslessViolation(parsed)
  check(`${name}: the normalized result is lossless JSON`, violation === '', violation || 'clean')
}

const sparseToolStream = [
  JSON.stringify({ type: 'tool_use', part: { tool: 'write' } }),
  JSON.stringify({ type: 'text', part: { text: 'done' } }),
].join('\n')
const sparse = parseFixture(opencode, sparseToolStream)
check('a tool event with missing optional fields still yields lossless JSON',
  sparse.Tools.length === 1 && isLosslessJson(sparse), findLosslessViolation(sparse) || JSON.stringify(sparse))
check('the missing optional field is ABSENT, never undefined',
  sparse.Tools[0].Tool === 'write' && !('Note' in sparse.Tools[0]) && !('Input' in sparse.Tools[0]),
  JSON.stringify(sparse.Tools[0]))

const bigInputStream = [
  JSON.stringify({ type: 'tool_use', part: { tool: 'write', state: { status: 'completed', input: { path: 'x', content: 'y'.repeat(5000) } } } }),
  JSON.stringify({ type: 'text', part: { text: 'done' } }),
].join('\n')
const bigInput = parseFixture(opencode, bigInputStream)
check('a large tool input is truncated instead of embedded whole',
  bigInput.Tools[0].Input.length <= 401 && bigInput.Tools[0].Input.endsWith('…'),
  `${bigInput.Tools[0].Input.length} chars`)

// The predicate itself has to be right, or every check above is worthless.
check('lossless predicate: accepts plain data', isLosslessJson({ a: [1, 'x', null, true], b: { c: 2 } }))
check('lossless predicate: rejects an undefined member', !isLosslessJson({ a: undefined }), findLosslessViolation({ a: undefined }))
check('lossless predicate: rejects NaN / Infinity / negative zero',
  !isLosslessJson(Number.NaN) && !isLosslessJson(Infinity) && !isLosslessJson(-0))
check('lossless predicate: rejects a non-enumerable own property',
  !isLosslessJson(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false })))
check('lossless predicate: rejects a sparse array', !isLosslessJson([1, , 3]))
check('lossless predicate: rejects a class instance', !isLosslessJson(new (class Point { constructor() { this.x = 1 } })()))

console.log(`\n${failures === 0 ? 'RECIPE FIXTURES: PASS' : `RECIPE FIXTURES: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
