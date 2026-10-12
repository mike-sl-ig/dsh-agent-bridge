/**
 * A recipe may point at a JavaScript CLI instead of an executable. WorkBuddy's
 * `bin/codebuddy` is a .js file, so without this the bridge would try to exec
 * a script Node owns.
 */

import { resolveSpawn } from '../lib/engine.js'

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

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
