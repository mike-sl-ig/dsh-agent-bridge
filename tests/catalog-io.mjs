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

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
