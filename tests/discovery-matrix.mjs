/**
 * Discovery matrix: the multi-platform claim, actually exercised.
 *
 * No Mac or Linux box is available here, so the three platforms are simulated
 * with synthetic trees and an explicit environment: PATH lookups, `%VAR%`
 * expansion, `*` globs for versioned directories, environment overrides, and the
 * shim→real-entry derivation each get their own case. The recipes under test are
 * the SHIPPED ones, so a recipe edit that breaks macOS/Linux discovery fails
 * here instead of on a stranger's machine.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover, loadRecipe } from '../lib/engine.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const claude = loadRecipe(join(ROOT, 'lib', 'recipes', 'claude.json'))
const opencode = loadRecipe(join(ROOT, 'lib', 'recipes', 'opencode.json'))

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const base = mkdtempSync(join(tmpdir(), 'agent-bridge-discovery-'))
const touch = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'x') }

/* ------------------------------------------------------------------- win32 */

const win = {
  npmBin: join(base, 'win', 'npm'),
  appdata: join(base, 'win', 'AppData', 'Roaming'),
  localappdata: join(base, 'win', 'AppData', 'Local'),
}
touch(join(win.npmBin, 'claude.cmd'))                                                       // the npm shim
touch(join(win.npmBin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')) // the real entry
touch(join(win.localappdata, 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe'))
touch(join(win.appdata, 'ai.opencode.desktop', 'cli', '2.0.19', 'opencode-cli.exe'))        // versioned glob

const winEnv = { PATH: win.npmBin, APPDATA: win.appdata, LOCALAPPDATA: win.localappdata }
const winClaude = discover(claude, winEnv, 'win32')
check('win32: the spawnable real entry outranks the .cmd shim',
  winClaude[0] && winClaude[0].path.endsWith('claude.exe') && /^derived/.test(winClaude[0].source),
  JSON.stringify(winClaude.slice(0, 2)))
check('win32: the shim is still reported as a candidate (read-only discovery, no guess)',
  winClaude.some((c) => c.path.endsWith('claude.cmd')),
  JSON.stringify(winClaude.map((c) => c.source)))

const winOpencode = discover(opencode, winEnv, 'win32')
check('win32: %LOCALAPPDATA% expansion finds the known install path',
  winOpencode.some((c) => c.source === 'known-path' && c.path.endsWith(join('@opencodedesktop', 'resources', 'opencode-cli.exe'))),
  JSON.stringify(winOpencode.map((c) => `${c.source}:${c.path.split(/[\\/]/).slice(-3).join('/')}`)))
check('win32: a versioned glob (%APPDATA%\\...\\cli\\*\\...) matches',
  winOpencode.some((c) => c.path.includes('2.0.19')), JSON.stringify(winOpencode.map((c) => c.path)))

/* ------------------------------------------------------------------ posix */

const posix = { bin: join(base, 'posix', 'bin'), home: join(base, 'posix', 'home') }
touch(join(posix.bin, 'claude'))
touch(join(posix.bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude'))
touch(join(posix.home, '.opencode', 'bin', 'opencode'))   // ~/.opencode/bin/opencode from the recipe's path list

for (const platform of ['linux', 'darwin']) {
  const found = discover(claude, { PATH: posix.bin, HOME: posix.home }, platform)
  check(`${platform}: derives the real entry behind a shell-script shim`,
    found[0] && found[0].path === join(posix.bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude')
    && /^derived/.test(found[0].source),
    JSON.stringify(found.slice(0, 2)))

  const foundOpencode = discover(opencode, { PATH: posix.bin, HOME: posix.home }, platform)
  check(`${platform}: expands ~ into the home directory from the recipe`,
    foundOpencode.some((c) => c.path === join(posix.home, '.opencode', 'bin', 'opencode')),
    JSON.stringify(foundOpencode.map((c) => c.path)))
}

/* ------------------------------------------------- overrides and negatives */

const override = join(base, 'custom', 'my-opencode')
touch(override)
const overridden = discover(opencode, { PATH: '', OPENCODE_CLI: override, HOME: join(base, 'nope') }, 'linux')
check('an environment override wins over every other source',
  overridden[0] && overridden[0].source === 'env:OPENCODE_CLI' && overridden[0].path === override,
  JSON.stringify(overridden.slice(0, 2)))

const nowhere = discover(opencode, { PATH: join(base, 'empty-path'), HOME: join(base, 'empty-home') }, 'linux')
check('nothing installed => an empty candidate list (no invented paths)', nowhere.length === 0, JSON.stringify(nowhere))
check('a nonexistent environment override is ignored', discover(opencode, { PATH: '', OPENCODE_CLI: join(base, 'missing.exe') }, 'win32').every((c) => c.source !== 'env:OPENCODE_CLI'))

const deduped = discover(claude, winEnv, 'win32')
const paths = deduped.map((c) => c.path)
check('candidates are deduplicated', new Set(paths).size === paths.length, `${paths.length} candidates`)

console.log(`\n${failures === 0 ? 'DISCOVERY MATRIX: PASS' : `DISCOVERY MATRIX: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
