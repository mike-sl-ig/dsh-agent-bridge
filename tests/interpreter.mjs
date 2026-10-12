/**
 * A recipe may point at a JavaScript CLI instead of an executable. WorkBuddy's
 * `bin/codebuddy` is a .js file, so without this the bridge would try to exec
 * a script Node owns.
 */

import { resolveSpawn, resolveRunEnv } from '../lib/engine.js'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const plain = resolveSpawn({}, 'C:\\tools\\opencode.exe', ['run', '-m', 'x'])
check('a recipe without an interpreter spawns the binary directly', plain.command === 'C:\\tools\\opencode.exe')
check('and keeps the argv untouched', plain.argv.join(' ') === 'run -m x')

const viaNode = resolveSpawn({ interpreter: { source: 'self' } }, 'C:\\wb\\bin\\codebuddy', ['-p', 'hi'])
check('source=self spawns the current node', viaNode.command === process.execPath)
check('and puts the CLI first in argv', viaNode.argv[0] === 'C:\\wb\\bin\\codebuddy')
check('and appends the original args after it', viaNode.argv.slice(1).join(' ') === '-p hi')
check('the original argv is not mutated', ['-p', 'hi'].join(' ') === '-p hi')

let threw = ''
try { resolveSpawn({ interpreter: { source: 'discover' } }, 'x', []) } catch (error) { threw = String(error.message) }
check('an unimplemented source throws instead of guessing', threw.includes('discover'))

/* ---- run.env: a recipe must be able to say HOW it is launched ---------------
 * CodeBuddy's binary takes its entire identity from ACC_PRODUCT_CONFIG_PATH:
 * without it the same executable is the CodeBuddy product and rejects a
 * WorkBuddy account with "Authentication required" — measured 2026-10-13, the
 * bridge failed exactly this way while the same CLI on the same machine worked
 * from a shell that had the variable set. */
const cliExe = 'C:\\pkg\\bin\\codebuddy'
const envRecipe = { run: { env: { ACC_PRODUCT_CONFIG_PATH: '{cliDir}/../product.json', PLAIN: 'x', WHO: '{cli}' } } }
const merged = resolveRunEnv(envRecipe, cliExe, { EXISTING: '1' })
check('run.env resolves {cliDir} relative to the CLI', merged.ACC_PRODUCT_CONFIG_PATH === 'C:\\pkg\\product.json', merged.ACC_PRODUCT_CONFIG_PATH)
check('run.env resolves {cli} to the CLI itself', merged.WHO === cliExe, merged.WHO)
check('run.env keeps literal values', merged.PLAIN === 'x')
check('the parent environment is inherited', merged.EXISTING === '1')
check('a recipe with no run.env inherits the environment untouched',
  resolveRunEnv({}, cliExe, { A: '1' }).A === '1' && Object.keys(resolveRunEnv({}, cliExe, { A: '1' })).length === 1)
check('a non-string env value is ignored rather than injected',
  resolveRunEnv({ run: { env: { BAD: 5 } } }, cliExe, {}).BAD === undefined)

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
