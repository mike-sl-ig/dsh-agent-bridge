/**
 * Recipe trust-boundary tests: the validator must accept the shipped recipes,
 * reject the specific mistakes a community contributor will actually make, and
 * the drafter must recover the right fields from a real capture.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectFormat, draftFromRun, validateRecipe } from '../lib/recipe.js'
import { loadRecipe } from '../lib/engine.js'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = join(HERE, '..')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

// ---- shipped recipes must pass their own gate -----------------------------
for (const id of ['opencode', 'claude']) {
  const recipe = loadRecipe(join(ROOT, 'lib', 'recipes', `${id}.json`))
  const result = validateRecipe(recipe)
  check(`shipped recipe ${id} validates`, result.ok, result.problems.join('; ') || 'clean')
  check(`shipped recipe ${id} has no warnings`, result.warnings.length === 0, result.warnings.join('; '))
}

// ---- the mistakes contributors actually make -----------------------------
const base = loadRecipe(join(ROOT, 'lib', 'recipes', 'opencode.json'))
const clone = () => JSON.parse(JSON.stringify(base))

const cases = [
  ['rejects a missing id', () => { const r = clone(); delete r.id; return r }],
  ['rejects a UUID-ish id', () => { const r = clone(); r.id = 'My Agent!'; return r }],
  ['rejects an unknown cost class', () => { const r = clone(); r.cost = 'cheap'; return r }],
  ['rejects argv that is a shell string', () => { const r = clone(); r.run.argv = 'run --auto'; return r }],
  ['rejects a missing prompt transport', () => { const r = clone(); delete r.run.prompt; return r }],
  ['rejects an unknown output format', () => { const r = clone(); r.output.format = 'xml'; return r }],
  ['rejects an answer selector with neither pick nor where', () => { const r = clone(); r.output.answer = {}; return r }],
  ['rejects discovery with no source at all', () => { const r = clone(); r.discover = {}; return r }],
  ['rejects a non-string usage path', () => { const r = clone(); r.output.usage = { cost: 42 }; return r }],
]
for (const [name, build] of cases) {
  const result = validateRecipe(build())
  check(name, result.ok === false && result.problems.length > 0, result.problems[0] || 'accepted (bad)')
}

const warningCase = clone()
warningCase.discovry = { bin: ['typo'] }
const warned = validateRecipe(warningCase)
check('warns about an unknown key instead of silently ignoring it',
  warned.ok === true && warned.warnings.some((w) => w.includes('discovry')), warned.warnings.join('; '))

// ---- format detection ----------------------------------------------------
check('detects jsonl', detectFormat('{"a":1}\n{"a":2}\n') === 'jsonl')
check('detects a single json object', detectFormat('{"a":1}') === 'json')
check('detects plain text', detectFormat('hello\nthere\n') === 'text')
check('a banner line plus jsonl is still reported as text (honest, not lucky)',
  detectFormat('starting up...\n{"a":1}\n') === 'text')

// ---- drafting from a real capture ----------------------------------------
const claudeCapture = readFileSync(join(ROOT, 'fixtures', 'claude-result.json'), 'utf8')
const draft = draftFromRun({ stdout: claudeCapture, exitCode: 0, argv: ['-p', 'hi', '--output-format', 'json'] })

check('draft detects the json shape', draft.output.format === 'json', draft.output.format)
check('draft suggests the answer path .result', draft.output.answer && draft.output.answer.pick === 'result',
  JSON.stringify(draft.output.answer))
check('draft suggests the session path .session_id',
  draft.output.session && draft.output.session.pick === 'session_id', JSON.stringify(draft.output.session))
check('draft suggests the cost path .total_cost_usd',
  draft.output.usage && draft.output.usage.cost === 'total_cost_usd', JSON.stringify(draft.output.usage))
check('draft suggests token paths',
  draft.output.usage && typeof draft.output.usage.input === 'string', JSON.stringify(draft.output.usage))
check('draft keeps the evidence, not just the conclusion',
  Array.isArray(draft._draft.answerCandidates) && draft._draft.answerCandidates.includes('result')
  && draft._draft.topLevelKeys.includes('session_id'),
  JSON.stringify(draft._draft.answerCandidates))
check('draft never claims a cost class it cannot know', draft.cost === 'unknown')

const textDraft = draftFromRun({ stdout: 'just some text output\n', exitCode: 0, argv: ['ask', 'hi'] })
check('draft on a text CLI produces the text fallback with no invented paths',
  textDraft.output.format === 'text' && textDraft.output.answer === undefined, JSON.stringify(textDraft.output))

const LOG_DIR = process.env.BRIDGE_LOGS || 'C:\\Users\\ROG\\.dsh\\tools\\logs'
let opencodeCapture = null
try {
  const name = readdirSync(LOG_DIR).filter((f) => f.endsWith('.out.jsonl')).sort().pop()
  if (name) opencodeCapture = readFileSync(join(LOG_DIR, name), 'utf8')
} catch { /* no recorded stream on this machine */ }
if (opencodeCapture) {
  const lDraft = draftFromRun({ stdout: opencodeCapture, exitCode: 0, argv: ['run', '--auto', '--format', 'json', 'hi'] })
  check('draft detects an OpenCode-style jsonl stream',
    lDraft.output.format === 'jsonl' && lDraft.output.answer && lDraft.output.answer.pick === 'part.text',
    `${lDraft.output.format} ${JSON.stringify(lDraft.output.answer)}`)
} else {
  console.log('SKIP draft-on-jsonl: no recorded stream available')
}

console.log(`\n${failures === 0 ? 'RECIPE WIZARD: PASS' : `RECIPE WIZARD: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
