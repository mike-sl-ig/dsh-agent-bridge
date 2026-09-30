/**
 * Migration test: run the plugin in a THROWAWAY DSH home that contains the
 * OpenCode-only predecessor's state file, and check that
 *   - the state is migrated into the new shape (and the legacy file survives),
 *   - the compatibility aliases are registered and keep their semantics.
 *
 * DSH_HOME must be redirected BEFORE importing the host half, so the import is
 * dynamic on purpose.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agent-bridge-migrate-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/host.js')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

/* The legacy state, exactly as dsh-opencode-bridge wrote it. */
const legacyState = {
  auto: false,
  enabled: { verify: true, bulk: false, second: false },
  defaultMode: 'verify',
  model: 'opencode/mimo-v2.6-flash-free',
}
writeFileSync(join(home, 'opencode-bridge.json'), JSON.stringify(legacyState, null, 2), 'utf8')

const tools = new Map()
const ctx = {
  logger: () => ({ warn: () => {} }),
  get: (key) => (key === 'tools' ? { register: (def) => { tools.set(def.name, def); return () => {} } } : undefined),
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  inject: (deps, callback) => { callback({ get: ctx.get, effect: ctx.effect, logger: ctx.logger }); return () => {} },
}
apply(ctx)

const migratedPath = join(home, 'agent-bridge.json')
check('the new state file is created by the migration', existsSync(migratedPath), migratedPath)
check('the legacy file is left untouched (rollback stays possible)', existsSync(join(home, 'opencode-bridge.json')))

const state = (await tools.get('agent_mode').execute({ action: 'get' })).state
check('auto is carried over', state.auto === false, String(state.auto))
check('defaultMode is carried over', state.defaultMode === 'verify', state.defaultMode)
check('feature flags are carried over', state.enabled.verify === true && state.enabled.bulk === false, JSON.stringify(state.enabled))
check('the single model moves under the opencode agent',
  state.agents.opencode && state.agents.opencode.model === 'opencode/mimo-v2.6-flash-free',
  JSON.stringify(state.agents))
check('the migrated default agent is opencode', state.defaultAgent === 'opencode', state.defaultAgent)

const written = JSON.parse(readFileSync(migratedPath, 'utf8'))
check('the migrated state is persisted, not just in memory',
  written.defaultAgent === 'opencode' && written.agents.opencode.model === 'opencode/mimo-v2.6-flash-free',
  JSON.stringify(written))

/* ---------------------------------------------------- compatibility aliases */
check('the compatibility aliases are registered',
  tools.has('opencode_run') && tools.has('opencode_mode'), [...tools.keys()].join(', '))
check('alias schemas stay wire-legal',
  tools.get('opencode_run').parameters.type === 'object' && tools.get('opencode_mode').parameters.type === 'object')
check('the alias advertises itself as an alias',
  /alias of agent_run/i.test(tools.get('opencode_run').description), tools.get('opencode_run').description.slice(0, 90))

if (process.env.SKIP_LIVE_RUN === '1') {
  console.log('\n(skipping the live alias run: SKIP_LIVE_RUN=1)')
} else {
  /* A real call through the alias, and a hijack attempt that must be ignored. */
  const viaAlias = await tools.get('opencode_run').execute({ prompt: 'Reply with exactly: ALIAS-OK', timeoutMs: 120000 })
  check('opencode_run really runs the opencode agent through the new pipeline',
    viaAlias.result.Ok === true && /ALIAS-OK/.test(viaAlias.result.Answer) && viaAlias.result.Agent === 'opencode',
    `ok=${viaAlias.result.Ok} agent=${viaAlias.result.Agent} answer=${JSON.stringify(viaAlias.result.Answer)}`)

  const hijack = await tools.get('opencode_run').execute({ prompt: 'Reply with exactly: HIJACK-OK', agent: 'claude', timeoutMs: 120000 })
  check('the alias refuses to be pointed at another (paid) agent',
    hijack.result.Agent === 'opencode', `agent=${hijack.result.Agent}`)
  check('the ignored agent override costs nothing extra', hijack.result.Cost === 0, String(hijack.result.Cost))
}

console.log(`\n${failures === 0 ? 'MIGRATION: PASS' : `MIGRATION: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
