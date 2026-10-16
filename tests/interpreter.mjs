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

/* ---- null means: keep this variable OUT of the child ------------------------
 * Presence alone can be identity. WorkBuddy reads ANY CODEBUDDY_AUTH_TOKEN — even
 * an empty one (measured: it reported token-length:1 and then answered 401) — as its
 * own credential, and a non-Latin1 value kills every run before a request leaves,
 * with a perfectly good stored login sitting right behind it. So a recipe must be
 * able to say "not this one". */
const stale = { CODEBUDDY_AUTH_TOKEN: 'leftover-from-the-host', KEEP: 'old' }
const dropped = resolveRunEnv({ run: { env: { CODEBUDDY_AUTH_TOKEN: null, KEEP: 'y' } } }, cliExe, stale)
check('null removes the variable from the child environment', !('CODEBUDDY_AUTH_TOKEN' in dropped))
check('and still sets the variables the recipe does name', dropped.KEEP === 'y')
check('and leaves the rest of the parent environment alone',
  resolveRunEnv({ run: { env: { GONE: null } } }, cliExe, { GONE: '1', STAY: '2' }).STAY === '2')
check('a null does not mutate the environment it was handed',
  stale.CODEBUDDY_AUTH_TOKEN === 'leftover-from-the-host')

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
