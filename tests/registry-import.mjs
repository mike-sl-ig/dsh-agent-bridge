/**
 * Registry import test — offline, against a local HTTP server.
 *
 * The registry path is the one place where data arrives over the network, so the
 * test is deliberately adversarial: a valid recipe, a mix, a non-JSON body, an
 * oversized body, an empty payload, and a non-http scheme.
 */

import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/host.js'

// Disposable home when the machine has none (CI) — see tests/host-harness.mjs.
const DSH_HOME = process.env.DSH_HOME
  || (existsSync('C:\\Users\\ROG\\.dsh') ? 'C:\\Users\\ROG\\.dsh' : mkdtempSync(join(tmpdir(), 'agent-bridge-home-')))
const LOCAL_DIR = join(DSH_HOME, 'tools', 'agent-bridge', 'recipes')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

/* ------------------------------------------------------------- fake cordis ctx */
const tools = new Map()
const ctx = {
  logger: () => ({ warn: (...args) => console.log('[warn]', ...args) }),
  get: (key) => (key === 'tools' ? { register: (def) => { tools.set(def.name, def); return () => {} } } : undefined),
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  inject: (deps, callback) => { callback({ get: ctx.get, effect: ctx.effect, logger: ctx.logger }); return () => {} },
}
apply(ctx)

const recipeTool = tools.get('agent_recipe')
check('agent_recipe tool is mounted', Boolean(recipeTool))

/* --------------------------------------------------------------- test payloads */
const validRecipe = {
  id: 'registry-valid',
  label: 'Registry Valid Agent',
  vendor: 'community',
  cost: 'unknown',
  discover: { bin: ['registry-valid-not-installed'] },
  run: { argv: ['ask'], prompt: { via: 'positional' } },
  output: { format: 'text', answer: { pick: 'text' } },
}
const unknownKeyRecipe = { ...validRecipe, id: 'registry-smuggled', payload: { run: 'rm -rf /' } }
const badCostRecipe = { ...validRecipe, id: 'registry-badcost', cost: 'cheap' }

const payloads = {
  '/valid': JSON.stringify(validRecipe),
  '/mixed': JSON.stringify({ recipes: [validRecipe, unknownKeyRecipe, badCostRecipe] }),
  '/not-json': 'this is not json at all',
  '/empty': JSON.stringify({ recipes: [] }),
  '/huge': JSON.stringify({ recipes: [validRecipe], padding: 'x'.repeat(600 * 1024) }),
}

const server = createServer((request, response) => {
  const body = payloads[request.url] || 'not found'
  response.writeHead(request.url && payloads[request.url] ? 200 : 404, { 'content-type': 'application/json' })
  response.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/* ---------------------------------------------------------------- run the cases */
const before = new Set(existsSync(LOCAL_DIR) ? readdirSync(LOCAL_DIR) : [])

const valid = await recipeTool.execute({ action: 'import', url: `${base}/valid` })
check('a valid registry payload is stored', valid.saved === 1 && valid.results[0].saved === true, JSON.stringify(valid.results))
check('the stored recipe lands in the local recipe directory',
  valid.results[0].path && existsSync(valid.results[0].path), valid.results[0].path)
const listed = await tools.get('agent_list').execute({})
check('an imported recipe joins agent_list', listed.agents.some((a) => a.id === 'registry-valid' && a.installed === false),
  listed.agents.map((a) => a.id).join(', '))

const mixed = await recipeTool.execute({ action: 'import', url: `${base}/mixed` })
check('a mixed payload stores only the valid recipe', mixed.candidates === 3 && mixed.saved === 1,
  mixed.results.map((r) => `${r.id}:${r.saved ? 'saved' : 'rejected'}`).join(', '))
check('a recipe with an unknown top-level key is rejected (strict import)',
  mixed.results.find((r) => r.id === 'registry-smuggled')?.saved === false
  && mixed.results.find((r) => r.id === 'registry-smuggled').problems.join(' ').includes('unknown top-level key'),
  JSON.stringify(mixed.results.find((r) => r.id === 'registry-smuggled')?.problems))
check('a recipe with a bogus cost class is rejected',
  mixed.results.find((r) => r.id === 'registry-badcost')?.saved === false,
  JSON.stringify(mixed.results.find((r) => r.id === 'registry-badcost')?.problems))
check('nothing from the rejected recipe was written to disk',
  !existsSync(join(LOCAL_DIR, 'registry-smuggled.json')) && !existsSync(join(LOCAL_DIR, 'registry-badcost.json')))

let thrown = null
try { await recipeTool.execute({ action: 'import', url: `${base}/not-json` }) } catch (error) { thrown = String(error.message || error) }
check('a non-JSON payload is refused with a clear message', Boolean(thrown && /not JSON/.test(thrown)), thrown)

thrown = null
try { await recipeTool.execute({ action: 'import', url: `${base}/huge` }) } catch (error) { thrown = String(error.message || error) }
check('an oversized payload is refused before it is parsed', Boolean(thrown && /limit/.test(thrown)), thrown)

thrown = null
try { await recipeTool.execute({ action: 'import', url: `${base}/empty` }) } catch (error) { thrown = String(error.message || error) }
check('an empty payload is refused', Boolean(thrown && /no recipes/.test(thrown)), thrown)

thrown = null
try { await recipeTool.execute({ action: 'import', url: 'file:///etc/passwd' }) } catch (error) { thrown = String(error.message || error) }
check('a non-http(s) url is refused', Boolean(thrown && /http\(s\) url/.test(thrown)), thrown)

check('every import is recorded with its provenance',
  existsSync(join(LOCAL_DIR, '_provenance.json'))
  && readFileSync(join(LOCAL_DIR, '_provenance.json'), 'utf8').includes('/valid'),
  join(LOCAL_DIR, '_provenance.json'))
check('the provenance log is not mistaken for a recipe',
  !listed.agents.some((a) => a.id === '_provenance'))

/* -------------------------------------------------------------------- cleanup */
for (const file of existsSync(LOCAL_DIR) ? readdirSync(LOCAL_DIR) : []) {
  if (before.has(file)) continue
  if (file.startsWith('registry-') || file === '_provenance.json') {
    try { unlinkSync(join(LOCAL_DIR, file)) } catch { /* already gone */ }
  }
}
server.close()

console.log(`\n${failures === 0 ? 'REGISTRY IMPORT: PASS' : `REGISTRY IMPORT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
