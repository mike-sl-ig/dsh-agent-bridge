/**
 * Model catalog — the IO half. Every failure mode must degrade to the
 * recipe's own static list, because a broken catalog file may never take the
 * model picker (or a run) down with it.
 */

import { readCatalog, clearCatalogCache } from '../lib/catalog.js'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const file = '/fake/acc-product-config-v3.json'
const recipe = {
  id: 'workbuddy',
  models: ['auto'],
  catalog: { kind: 'jsonFile', path: [file], pick: 'models', map: { id: 'id', label: 'name', credits: 'credits' }, ttlMs: 1000 },
}
const payload = JSON.stringify({ models: [{ id: 'fast-model', name: '快速', credits: 'x0.21' }] })

clearCatalogCache()
let calls = 0
const readFile = () => { calls++; return payload }
const first = await readCatalog(recipe, { readFile, now: () => 1000 })
check('reads models from the catalog file', first.models.length === 1 && first.models[0].id === 'fast-model')
check('reports the source', first.source === 'jsonFile')
check('no error on success', first.catalogError === '')

const second = await readCatalog(recipe, { readFile, now: () => 1500 })
check('serves the second read from cache', calls === 1 && second.models[0].id === 'fast-model')

const third = await readCatalog(recipe, { readFile, now: () => 3000 })
check('refreshes after the TTL', calls === 2 && third.models.length === 1)

const broken = await readCatalog(recipe, { readFile: () => { throw new Error('ENOENT') }, now: () => 9000 })
check('falls back to the static list', broken.models.length === 1 && broken.models[0].id === 'auto')
check('reports the source as the recipe', broken.source === 'recipe')
check('explains why', broken.catalogError.includes('ENOENT'))

clearCatalogCache()
const badJson = await readCatalog(recipe, { readFile: () => '{ not json', now: () => 1 })
check('bad JSON degrades too', badJson.source === 'recipe' && badJson.catalogError !== '')

clearCatalogCache()
const emptyList = await readCatalog(recipe, { readFile: () => JSON.stringify({ models: [] }), now: () => 1 })
check('an empty catalog degrades instead of emptying the picker', emptyList.source === 'recipe' && emptyList.models[0].id === 'auto')

clearCatalogCache()
const multi = { ...recipe, catalog: { ...recipe.catalog, path: ['/nope/a.json', '/nope/b.json'] } }
let tried = []
const multiResult = await readCatalog(multi, { readFile: (p) => { tried.push(p); if (p.endsWith('a.json')) throw new Error('ENOENT'); return payload }, now: () => 1 })
check('tries the paths in order', tried.length === 2 && tried[1].endsWith('b.json'))
check('uses the first path that works', multiResult.source === 'jsonFile')

clearCatalogCache()
const noCatalog = await readCatalog({ id: 'opencode', models: ['opencode/big-pickle'] }, { now: () => 1 })
check('a recipe with no catalog block uses its static list', noCatalog.source === 'recipe' && noCatalog.models[0].id === 'opencode/big-pickle')

clearCatalogCache()
const objectsInRecipe = await readCatalog({ id: 'x', models: [{ id: 'glm-5.2', tier: 'paid' }] }, { now: () => 1 })
check('object models in a recipe survive', objectsInRecipe.models[0].tier === 'paid')

/* ---- argv catalogs: the CLI itself is the source of truth ----------------
 * A static list goes stale the moment the vendor ships a model (OpenCode's did:
 * 8 written down, 11 on offer), so a recipe may point at the CLI instead. */

clearCatalogCache()
const argvRecipe = {
  id: 'opencode',
  models: ['opencode/stale-static-entry'],
  catalog: { kind: 'argv', argv: ['models'], parse: 'lines', ttlMs: 1000 },
}
let runs = 0
const cliText = 'opencode/big-pickle\nopencode/mimo-v2.6-flash-free\n\n'
const argvResult = await readCatalog(argvRecipe, { run: async () => { runs++; return cliText }, now: () => 1 })
check('an argv catalog runs the CLI', runs === 1)
check('and parses one model per line',
  argvResult.models.map((m) => m.id).join(',') === 'opencode/big-pickle,opencode/mimo-v2.6-flash-free',
  argvResult.models.map((m) => m.id).join(','))
check('and strips the vendor prefix from the label', argvResult.models[0].label === 'big-pickle', argvResult.models[0].label)
check('and keeps the vendor', argvResult.models[0].vendor === 'opencode', argvResult.models[0].vendor)
check('and classifies -free as free', argvResult.models[1].tier === 'free')
check('blank lines are ignored', argvResult.models.length === 2)
check('and it reports the argv source', argvResult.source === 'argv')

clearCatalogCache()
runs = 0
await readCatalog(argvRecipe, { run: async () => { runs++; return cliText }, now: () => 1500 })
check('argv catalogs are cached like file catalogs', runs === 1)

clearCatalogCache()
const argvBroken = await readCatalog(argvRecipe, { run: async () => { throw new Error('CLI exited 1') }, now: () => 1 })
check('a failing catalog command degrades to the static list', argvBroken.models[0].id === 'opencode/stale-static-entry')
check('and says why', argvBroken.catalogError.includes('CLI exited 1'), argvBroken.catalogError)

clearCatalogCache()
const argvNoRunner = await readCatalog(argvRecipe, { now: () => 1 })
check('a missing runner degrades instead of throwing', argvNoRunner.source === 'recipe' && argvNoRunner.catalogError !== '')

clearCatalogCache()
const jsonRecipe = {
  id: 'x', models: [],
  catalog: { kind: 'argv', argv: ['list', '--json'], parse: 'json', pick: 'data', map: { id: 'id', label: 'name' } },
}
const jsonResult = await readCatalog(jsonRecipe, { run: async () => JSON.stringify({ data: [{ id: 'a', name: 'A' }] }), now: () => 1 })
check('an argv catalog can parse JSON instead of lines',
  jsonResult.models[0].id === 'a' && jsonResult.models[0].label === 'A', JSON.stringify(jsonResult.models))

clearCatalogCache()
const jsonBad = await readCatalog(jsonRecipe, { run: async () => 'not json', now: () => 1 })
check('unparseable JSON degrades instead of throwing', jsonBad.source === 'recipe')

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
