/**
 * Live smoke test for the launcher + engine, WITHOUT DSH in the picture.
 *
 * It exercises the direct (node:child_process, file-descriptor) path, which is
 * the path a user hits when no subprocess service is mounted — the same path
 * that once hung for 123s with inherited pipes. Expect a fast, clean answer.
 */

import { mkdirSync } from 'node:fs'
import { loadRecipe, discover, buildArgs, normalize } from '../lib/engine.js'
import { launch } from '../lib/launch.js'

const RECIPE = new URL('../lib/recipes/opencode.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const LOGS = process.env.BRIDGE_LOGS || 'C:\\Users\\ROG\\.dsh\\tools\\logs\\agent-bridge-smoke'
const WORK = process.env.BRIDGE_WORK || 'C:\\Users\\ROG\\.dsh\\tools\\agent-bridge\\work'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const recipe = loadRecipe(RECIPE)
const found = discover(recipe)
if (!found.length) {
  console.log('SKIP: no agent CLI found for this recipe on this machine')
  process.exit(0)
}
mkdirSync(LOGS, { recursive: true })
mkdirSync(WORK, { recursive: true })

const { args, promptVia } = buildArgs(recipe, { prompt: 'Reply with exactly: LAUNCH-OK' })
console.log(`exec: ${found[0].path}\nargs: ${JSON.stringify(args)}\npromptVia: ${promptVia}\n`)

const raw = await launch(undefined, found[0].path, args, {
  cwd: WORK,
  logDir: LOGS,
  label: 'smoke',
  timeoutMs: 120000,
})
const result = normalize(recipe, {}, raw)

check('process spawned and exited', raw.spawned === true && raw.exitCode !== null, `exit=${raw.exitCode} via=${raw.via}`)
check('did not time out (the old hang signature)', raw.timedOut === false, `ms=${raw.ms}`)
check('finished well under the timeout', raw.ms < 90000, `${(raw.ms / 1000).toFixed(1)}s`)
check('answer came back through the recipe parser', result.Answer.includes('LAUNCH-OK'), JSON.stringify(result.Answer))
check('session id was extracted', /^ses_/.test(result.Session), result.Session)
check('stdout log was written', result.OutFile !== '', result.OutFile)
check('stderr is empty', result.Stderr === '', result.Stderr.slice(0, 120))

console.log('\n' + JSON.stringify({ Ok: result.Ok, Seconds: result.Seconds, Session: result.Session, Answer: result.Answer, Tools: result.Tools.length, OutFile: result.OutFile }, null, 2))
console.log(`\n${failures === 0 ? 'LAUNCH SMOKE: PASS' : `LAUNCH SMOKE: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
