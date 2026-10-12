# WorkBuddy 桥接 + 模型目录/免费付费/余额 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dsh-agent-bridge 加入 WorkBuddy 智能体，并把模型选择升级为带免费/付费标记与余额显示的可视化面板。

**Architecture:** 沿用插件「recipes, not code」的哲学：模型目录与余额的来源由 recipe 用 JSON 声明，新增两个纯逻辑模块（`lib/catalog.js` 模型目录、`lib/balance.js` 余额）负责取数与归一化，两者都对 IO 做依赖注入以便零依赖测试。前端只消费归一化后的稳定形状。

**Tech Stack:** Node ≥20 ESM、零运行时依赖、`node:assert` 风格的 `node tests/*.mjs` 自研 harness（`check(name, ok, detail)` + `process.exit(failures ? 1 : 0)`）。

**Spec:** `docs/superpowers/specs/2026-10-12-workbuddy-model-catalog-design.md`

**与 spec 的一处偏差：** spec §4.2 把模型目录与余额放在同一个 `lib/catalog.js`。实施时拆成 `lib/catalog.js`（读文件/解析模型）与 `lib/balance.js`（HTTP + 鉴权四态）两个文件——两者唯一的共同点是都"取数"，而取数方式、失败模式、测试替身完全不同，混在一起会让单测setup 变复杂。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/catalog.js` | 创建 | 模型目录：纯归一化 + 带 TTL 的取数（jsonFile/argv）+ 失败降级 |
| `lib/balance.js` | 创建 | 余额：纯归一化 + HTTP 取数 + `ok/unauthenticated/unsupported/error` 四态 |
| `lib/engine.js` | 修改 | 新增 `resolveSpawn()`：解释器前缀（`source: "self"` → `process.execPath`） |
| `lib/recipe.js` | 修改 | 白名单放行 `catalog`/`balance`/`interpreter`；`models` 接受对象 |
| `lib/host.js` | 修改 | `agentsView()` 输出归一化模型 + `modelIds`；`runAgent()` 用 `resolveSpawn()` |
| `lib/client.js` | 修改 | 模型下拉带徽章；每行余额行（四态） |
| `lib/recipes/workbuddy.json` | 创建 | WorkBuddy recipe |
| `fixtures/workbuddy-result.json` | 创建 | 自测回放用的真实形状样本 |
| `tests/catalog-normalize.mjs` | 创建 | 纯归一化 |
| `tests/catalog-io.mjs` | 创建 | 取数、TTL、降级 |
| `tests/balance.mjs` | 创建 | 四态 + 合计 |
| `tests/interpreter.mjs` | 创建 | argv 拼装 |
| `tests/recipe-wizard.mjs` | 修改 | 新 schema 校验 + 旧 recipe 兼容 |
| `tests/host-harness.mjs` | 修改 | `agentsView` 形状 |
| `tests/client-render.mjs` | 修改 | 徽章与余额渲染 |
| `package.json` | 修改 | version 0.2.0；test 脚本纳入三个新测试 |

---

### Task 1: 模型目录纯归一化

**Files:**
- Create: `lib/catalog.js`
- Test: `tests/catalog-normalize.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/catalog-normalize.mjs`：

```js
/**
 * Model catalog — the pure half. Two shipped catalogs spell credits
 * differently ("x0.79 credits" vs "x0.21"), so every parse is asserted
 * against both spellings.
 */

import { parseCredits, classifyTier, normalizeCatalog, normalizeModelList } from '../lib/catalog.js'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

check('parses the install-catalog spelling', parseCredits('x0.79 credits') === 0.79)
check('parses the account-catalog spelling', parseCredits('x0.21') === 0.21)
check('parses zero', parseCredits('x0.00 credits') === 0)
check('accepts a bare number', parseCredits(2) === 2)
check('rejects junk', parseCredits('free') === null)
check('rejects empty', parseCredits('') === null)
check('rejects null', parseCredits(null) === null)

check('zero credits is free', classifyTier({ credits: 'x0.00 credits', id: 'hy3' }) === 'free')
check('positive credits is paid', classifyTier({ credits: 'x0.16 credits', id: 'deepseek-v4-pro' }) === 'paid')
check('missing credits falls back to the id rule', classifyTier({ credits: '', id: 'opencode/mimo-v2.6-flash-free' }) === 'free')
check('nothing known stays unknown', classifyTier({ credits: '', id: 'glm-5.2' }) === 'unknown')

const account = [
  { id: 'fast-model', name: '快速', credits: 'x0.21', vendor: 'f', tags: [] },
  { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits' },
  { id: 'kling-v3-t2v', name: 'Kling', credits: 'x5.00 credits', tags: ['text-to-video'] },
]
const spec = {
  map: { id: 'id', label: 'name', credits: 'credits', vendor: 'vendor' },
  excludeTags: ['text-to-video', 'text-to-image'],
}
const models = normalizeCatalog(account, spec)
check('maps id', models[0].id === 'fast-model')
check('maps label', models[0].label === '快速')
check('maps vendor', models[0].vendor === 'f')
check('marks paid', models[0].tier === 'paid')
check('marks free', models[1].tier === 'free')
check('keeps the raw credits text', models[0].creditsText === 'x0.21')
check('drops non-chat models by tag', models.length === 2 && !models.some((m) => m.id === 'kling-v3-t2v'))
check('tolerates a non-array payload', normalizeCatalog(null, spec).length === 0)
check('skips entries with no id', normalizeCatalog([{ name: 'x' }], spec).length === 0)
check('supports a dotted map path', normalizeCatalog([{ a: { b: 'deep' } }], { map: { id: 'a.b' } })[0].id === 'deep')

const legacy = normalizeModelList(['opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'])
check('legacy strings become entries', legacy.length === 2 && legacy[0].id === 'opencode/mimo-v2.6-flash-free')
check('legacy label has the vendor prefix stripped', legacy[0].label === 'mimo-v2.6-flash-free')
check('legacy -free suffix is honoured', legacy[0].tier === 'free')
check('legacy unknown stays unknown', legacy[1].tier === 'unknown')

const objects = normalizeModelList([{ id: 'glm-5.2', label: 'GLM-5.2', tier: 'paid', credits: 'x0.79' }])
check('explicit tier wins', objects[0].tier === 'paid')
check('explicit label wins', objects[0].label === 'GLM-5.2')
check('a bogus tier is recomputed', normalizeModelList([{ id: 'x', tier: 'cheap', credits: 'x0.00' }])[0].tier === 'free')
check('non-array input yields an empty list', normalizeModelList(undefined).length === 0)

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/catalog-normalize.mjs`
Expected: FAIL — `Cannot find module '.../lib/catalog.js'`

- [ ] **Step 3: 实现**

创建 `lib/catalog.js`：

```js
/**
 * Model catalog — normalization half.
 *
 * The plugin ships two catalogs that spell the same fact differently: the
 * install bundle writes `"x0.79 credits"`, the account-level config writes
 * `"x0.21"`. Parsing is therefore written against the number, never against
 * one vendor's formatting, and an explicit `tier` in a recipe always wins over
 * anything inferred.
 */

import { pick } from './engine.js'

export const TIERS = ['free', 'paid', 'unknown']

/**
 * Read the credit multiplier out of a catalog string.
 * @param text "x0.79 credits" | "x0.21" | 2
 * @returns the multiplier, or null when the text says nothing about credits.
 */
export function parseCredits(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null
  if (typeof text !== 'string') return null
  const match = text.match(/x\s*(\d+(?:\.\d+)?)/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Free or paid, from the multiplier when present and from the id otherwise.
 * Never guesses: an unmarked model is `unknown`, not a default tier.
 */
export function classifyTier(entry = {}) {
  const credits = parseCredits(entry.credits)
  if (credits !== null) return credits === 0 ? 'free' : 'paid'
  if (/-free$/.test(String(entry.id || ''))) return 'free'
  return 'unknown'
}

/** Read one field via a (possibly dotted) path from a catalog `map`. */
function mapped(object, path, fallbackKey) {
  const key = typeof path === 'string' && path !== '' ? path : fallbackKey
  return pick(object, key)
}

/**
 * Turn a raw catalog payload into the stable shape the UI consumes.
 * @param rawModels array from the catalog file (or any junk).
 * @param spec recipe.catalog — `map` renames fields, `excludeTags` drops
 *   non-chat models (image/video generators live in the same array).
 */
export function normalizeCatalog(rawModels, spec = {}) {
  const map = spec.map || {}
  const exclude = new Set(Array.isArray(spec.excludeTags) ? spec.excludeTags.map(String) : [])
  const out = []
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    if (!raw || typeof raw !== 'object') continue
    const id = String(mapped(raw, map.id, 'id') || '').trim()
    if (!id) continue
    const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
    if (tags.some((tag) => exclude.has(tag))) continue
    const rawCredits = mapped(raw, map.credits, 'credits')
    const creditsText = rawCredits === undefined || rawCredits === null ? '' : String(rawCredits)
    out.push({
      id,
      label: String(mapped(raw, map.label, 'name') || id),
      vendor: String(mapped(raw, map.vendor, 'vendor') || ''),
      creditsText,
      credits: parseCredits(creditsText),
      tier: classifyTier({ credits: creditsText, id }),
    })
  }
  return out
}

/**
 * Normalize a recipe's own `models` list. Bare strings are the 0.1.x format
 * and MUST keep working unchanged.
 */
export function normalizeModelList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      const id = entry.trim()
      out.push({
        id,
        label: id.replace(/^[^/]+\//, ''),
        vendor: id.includes('/') ? id.split('/')[0] : '',
        creditsText: '',
        credits: null,
        tier: classifyTier({ credits: '', id }),
      })
      continue
    }
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim() !== '') {
      const creditsText = entry.credits === undefined || entry.credits === null ? '' : String(entry.credits)
      out.push({
        id: entry.id.trim(),
        label: String(entry.label || entry.id),
        vendor: String(entry.vendor || ''),
        creditsText,
        credits: parseCredits(creditsText),
        tier: TIERS.includes(entry.tier) ? entry.tier : classifyTier({ credits: creditsText, id: entry.id }),
      })
    }
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/catalog-normalize.mjs`
Expected: 每行 PASS，最后 `all good`，exit 0

- [ ] **Step 5: 提交**

```bash
git add lib/catalog.js tests/catalog-normalize.mjs
git commit -m "feat(catalog): model normalization with free/paid classification"
```

---

### Task 2: 模型目录取数与降级

**Files:**
- Modify: `lib/catalog.js`
- Test: `tests/catalog-io.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/catalog-io.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/catalog-io.mjs`
Expected: FAIL — `readCatalog is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

在 `lib/catalog.js` 顶部补 import，并在文件末尾追加：

```js
import { readFileSync } from 'node:fs'
import { expandPath } from './engine.js'
```

```js
/** Catalog reads are cached per recipe+source; the file is hot-updated by the app. */
const CACHE = new Map()
const DEFAULT_TTL_MS = 300000

/** Drop every cached catalog. Tests call this; nothing in production needs it. */
export function clearCatalogCache() {
  CACHE.clear()
}

/**
 * Where this recipe's models come from, and what to do when that fails.
 *
 * Never throws and never returns an empty list: a missing or malformed catalog
 * degrades to the recipe's own `models`, with the reason attached, so the UI
 * can still offer a choice and explain the degradation.
 *
 * @param recipe a validated recipe
 * @param deps { readFile(path), now() } — injected so tests stay off disk
 * @returns { models: ModelInfo[], source: 'jsonFile'|'recipe', catalogError: string }
 */
export async function readCatalog(recipe, deps = {}) {
  const spec = recipe && recipe.catalog
  const readFile = deps.readFile || ((path) => readFileSync(path, 'utf8'))
  const now = deps.now || (() => Date.now())
  const env = deps.env || process.env
  const staticModels = normalizeModelList(recipe && recipe.models)

  if (!spec || spec.kind === undefined || spec.kind === 'none') {
    return { models: staticModels, source: 'recipe', catalogError: '' }
  }

  const key = `${recipe.id}|${spec.kind}|${JSON.stringify(spec.path ?? spec.argv ?? '')}`
  const ttl = Number.isFinite(spec.ttlMs) ? spec.ttlMs : DEFAULT_TTL_MS
  const cached = CACHE.get(key)
  if (cached && now() - cached.at < ttl) return cached.value

  try {
    let raw
    if (spec.kind === 'jsonFile') {
      const paths = (Array.isArray(spec.path) ? spec.path : [spec.path]).filter((p) => typeof p === 'string' && p !== '')
      if (!paths.length) throw new Error('catalog.kind is jsonFile but no path is configured')
      let payload = null
      let lastError = new Error('no catalog path could be read')
      for (const candidate of paths) {
        try {
          payload = JSON.parse(readFile(expandPath(candidate, env)))
          lastError = null
          break
        } catch (error) {
          lastError = error
        }
      }
      if (payload === null) throw lastError
      raw = pick(payload, spec.pick || 'models')
    } else {
      throw new Error(`catalog.kind "${spec.kind}" is not supported`)
    }

    const models = normalizeCatalog(raw, spec)
    if (!models.length) throw new Error('catalog contained no usable models')
    const value = { models, source: spec.kind, catalogError: '' }
    CACHE.set(key, { at: now(), value })
    return value
  } catch (error) {
    return { models: staticModels, source: 'recipe', catalogError: String((error && error.message) || error) }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/catalog-io.mjs`
Expected: 全 PASS，`all good`

- [ ] **Step 5: 确认没破坏既有测试**

Run: `node tests/catalog-normalize.mjs && node tests/parse-fixtures.mjs`
Expected: 都通过

- [ ] **Step 6: 提交**

```bash
git add lib/catalog.js tests/catalog-io.mjs
git commit -m "feat(catalog): TTL-cached catalog reads that degrade to the recipe list"
```

---

### Task 3: 余额四态

**Files:**
- Create: `lib/balance.js`
- Test: `tests/balance.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/balance.mjs`：

```js
/**
 * Balance — read-only, four states, and a hard rule: a plugin that cannot
 * prove the balance says so instead of showing a number.
 */

import { normalizeBalance, readBalance } from '../lib/balance.js'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const spec = {
  kind: 'http',
  base: 'https://example.invalid',
  loginProbe: { method: 'GET', path: '/console/accounts', pick: 'data.accounts' },
  summary: { method: 'POST', path: '/billing/meter/get-user-resource-summary', body: {} },
  map: { id: 'ResourceId', label: 'PackageName', total: 'total', used: 'used' },
  unit: '积分',
  write: null,
}
const recipe = { id: 'workbuddy', balance: spec }

const rows = [
  { ResourceId: 'free', PackageName: '免费包', total: 500, used: 120 },
  { ResourceId: 'pro', PackageName: '专业包', total: 1000, used: 1000 },
]
const normalized = normalizeBalance(rows, spec)
check('keeps every package', normalized.packages.length === 2)
check('computes remaining per package', normalized.packages[0].remaining === 380)
check('never shows a negative remaining', normalized.packages[1].remaining === 0)
check('totals the packages', normalized.total === 1500)
check('totals the remaining', normalized.remaining === 380)
check('carries the unit', normalized.unit === '积分')
check('tolerates junk rows', normalizeBalance(null, spec).packages.length === 0)

const noToken = await readBalance(recipe, { token: '', httpJson: () => { throw new Error('must not be called') } })
check('an empty token short-circuits without a request', noToken.state === 'unauthenticated')

const notLoggedIn = await readBalance(recipe, {
  token: 't',
  httpJson: async (s, call) => (call.path === '/console/accounts' ? { data: { accounts: [] } } : (() => { throw new Error('summary must not run') })()),
})
check('an empty account list means unauthenticated', notLoggedIn.state === 'unauthenticated')

let seen = []
const ok = await readBalance(recipe, {
  token: 't',
  httpJson: async (s, call) => {
    seen.push(`${call.method} ${call.path}`)
    return call.path === '/console/accounts' ? { data: { accounts: [{ uid: 1 }] } } : { data: rows }
  },
})
check('authenticated reaches the summary', ok.state === 'ok' && ok.remaining === 380)
check('probes login before reading the summary', seen[0].startsWith('GET /console/accounts'))
check('uses POST for the summary', seen[1].startsWith('POST /billing/meter/get-user-resource-summary'))

const failing = await readBalance(recipe, { token: 't', httpJson: async () => { throw new Error('boom') } })
check('a transport error is reported as error', failing.state === 'error')
check('the error explains itself', failing.detail.includes('boom'))

const unsupported = await readBalance({ id: 'opencode' }, { token: 't', httpJson: () => { throw new Error('nope') } })
check('a recipe with no balance block is unsupported', unsupported.state === 'unsupported')

const readOnly = await readBalance(recipe, { token: 't', httpJson: async (s, call) => (call.path === '/console/accounts' ? { data: { accounts: [{}] } } : { data: [] }) })
check('the balance has no write capability', readOnly.write === undefined)

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/balance.mjs`
Expected: FAIL — `Cannot find module '.../lib/balance.js'`

- [ ] **Step 3: 实现**

创建 `lib/balance.js`：

```js
/**
 * Account balance — READ ONLY, by construction.
 *
 * The recipe declares where the balance lives; this module only ever issues
 * the two calls a recipe names (`loginProbe`, `summary`). There is no write
 * path in this file and there must never be one: the vendor's daily-checkin
 * endpoint grants credits and mutating an account from a bridge plugin is not
 * something a user should be able to trigger by accident.
 */

import { pick } from './engine.js'

/** States the UI can render. Every one of them has words, none has a fake number. */
export const BALANCE_STATES = ['ok', 'unauthenticated', 'unsupported', 'error']

/**
 * Turn the resource-summary payload into per-package balances.
 * @param raw array of resource rows (junk tolerated)
 * @param spec recipe.balance — `map` renames fields
 */
export function normalizeBalance(raw, spec = {}) {
  const map = spec.map || {}
  const packages = []
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object') continue
    const total = Number(pick(row, map.total || 'total')) || 0
    const used = Number(pick(row, map.used || 'used')) || 0
    packages.push({
      id: String(pick(row, map.id || 'id') || ''),
      label: String(pick(row, map.label || 'label') || ''),
      total,
      used,
      remaining: Math.max(0, total - used),
    })
  }
  return {
    unit: String(spec.unit || ''),
    packages,
    total: packages.reduce((sum, item) => sum + item.total, 0),
    remaining: packages.reduce((sum, item) => sum + item.remaining, 0),
  }
}

/** Default transport: global fetch, so the module stays dependency-free. */
async function defaultHttpJson(spec, call) {
  const url = `${String(spec.base || '').replace(/\/$/, '')}${call.path}`
  const options = { method: call.method || 'GET', headers: { Accept: 'application/json' } }
  if (options.method !== 'GET' && options.method !== 'HEAD') {
    options.headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(call.body ?? {})
  }
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${call.path}`)
  return response.json()
}

/**
 * Read the balance for one recipe.
 * @param recipe a validated recipe
 * @param deps { token, httpJson(spec, call) } — injected so tests never hit the network
 * @returns { state, packages?, total?, remaining?, unit?, at?, detail? }
 */
export async function readBalance(recipe, deps = {}) {
  const spec = recipe && recipe.balance
  if (!spec || spec.kind !== 'http') {
    return { state: 'unsupported', packages: [], detail: 'this agent has no balance source' }
  }
  const token = deps.token !== undefined ? deps.token : (process.env.CODEBUDDY_AUTH_TOKEN || '')
  if (!token) return { state: 'unauthenticated', packages: [], detail: 'no credential in this environment' }

  const httpJson = deps.httpJson || defaultHttpJson
  try {
    if (spec.loginProbe) {
      const probe = await httpJson(spec, spec.loginProbe)
      const accounts = pick(probe, spec.loginProbe.pick || 'data.accounts')
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return { state: 'unauthenticated', packages: [], detail: 'the account list is empty' }
      }
    }
    const payload = await httpJson(spec, spec.summary)
    const rows = pick(payload, spec.summary.pick || 'data')
    return { state: 'ok', ...normalizeBalance(rows, spec), at: new Date().toISOString(), detail: '' }
  } catch (error) {
    return { state: 'error', packages: [], detail: String((error && error.message) || error) }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/balance.mjs`
Expected: 全 PASS

- [ ] **Step 5: 静态确认没有写接口**

Run: `node -e "const s=require('fs').readFileSync('lib/balance.js','utf8'); const bad=/daily-checkin|checkin|method:\s*['\"](POST|PUT|PATCH|DELETE)/i.test(s.replace(/POST \(the summary\)/g,'')); console.log(bad?'FOUND WRITE':'no write path'); process.exit(bad?1:0)"`
Expected: `no write path`（`spec.summary` 用 `method: 'POST'` 是读取型查询，测试里单独断言过；这里只拦签到类端点）

- [ ] **Step 6: 提交**

```bash
git add lib/balance.js tests/balance.mjs
git commit -m "feat(balance): read-only four-state balance with no write path"
```

---

### Task 4: recipe schema 放行新键

**Files:**
- Modify: `lib/recipe.js:18-21`（KNOWN_KEYS）, `lib/recipe.js:101-104`（models 校验）
- Test: `tests/recipe-wizard.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/recipe-wizard.mjs` 的 `process.exit` 之前追加：

```js
/* ---- 0.2.0: catalog / balance / interpreter, and object models ---- */
const v = validateRecipe

const base = {
  id: 'demo', label: 'Demo', cost: 'free',
  discover: { bin: ['demo'] },
  run: { argv: ['-p'], prompt: { via: 'positional' } },
  output: { format: 'json', answer: { pick: 'result' } },
}

check('legacy string models still validate', v({ ...base, models: ['a/b'] }).ok)
check('object models validate', v({ ...base, models: [{ id: 'a/b', label: 'B', tier: 'paid', credits: 'x0.79' }] }).ok)
check('object models without an id are rejected', !v({ ...base, models: [{ label: 'B' }] }).ok)
check('a bogus tier is rejected', !v({ ...base, models: [{ id: 'a', tier: 'cheap' }] }).ok)
check('a non-array models is rejected', !v({ ...base, models: 'a/b' }).ok)

check('a catalog block validates', v({ ...base, catalog: { kind: 'jsonFile', path: ['%USERPROFILE%\\.workbuddy\\cache\\acc-product-config-v3.json'], pick: 'models' } }).ok)
check('catalog.kind is required', !v({ ...base, catalog: { path: ['x'] } }).ok)
check('a bogus catalog.kind is rejected', !v({ ...base, catalog: { kind: 'telepathy' } }).ok)
check('jsonFile catalog needs a path', !v({ ...base, catalog: { kind: 'jsonFile' } }).ok)
check('catalog.excludeTags must be strings', !v({ ...base, catalog: { kind: 'none', excludeTags: [1] } }).ok)

check('a balance block validates', v({ ...base, balance: { kind: 'http', base: 'https://x', summary: { method: 'POST', path: '/y' }, write: null } }).ok)
check('a balance write capability is rejected', !v({ ...base, balance: { kind: 'http', base: 'https://x', summary: { method: 'POST', path: '/y' }, write: { method: 'POST', path: '/z' } } }).ok)
check('a bogus balance.kind is rejected', !v({ ...base, balance: { kind: 'carrier-pigeon' } }).ok)

check('interpreter source self validates', v({ ...base, interpreter: { source: 'self' } }).ok)
check('a bogus interpreter source is rejected', !v({ ...base, interpreter: { source: 'vibes' } }).ok)

check('an imported recipe may use the new keys', validateRecipe({ ...base, catalog: { kind: 'none' }, balance: { kind: 'none' }, interpreter: { source: 'self' } }, { strictKeys: true }).ok)
check('an imported recipe still rejects unknown keys', !validateRecipe({ ...base, wat: 1 }, { strictKeys: true }).ok)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/recipe-wizard.mjs`
Expected: FAIL — `object models validate` / `a catalog block validates` 等为 FAIL（`unknown top-level key` 警告 + 新块未校验）

- [ ] **Step 3: 实现**

`lib/recipe.js` 第 18-21 行，把新的三个键加进白名单：

```js
const KNOWN_KEYS = new Set([
  'id', 'label', 'vendor', 'cost', 'homepage', 'notes',
  'discover', 'version', 'run', 'output', 'caps', 'models', 'safety',
  'catalog', 'balance', 'interpreter', '$schema',
])
```

`lib/recipe.js` 顶部常量区加：

```js
const TIERS = ['free', 'paid', 'unknown']
const CATALOG_KINDS = ['jsonFile', 'argv', 'none']
const BALANCE_KINDS = ['http', 'argv', 'none']
const INTERPRETER_SOURCES = ['self', 'discover']
```

把原来第 101-103 行的 models 校验替换为：

```js
  if (recipe.models !== undefined) {
    if (!Array.isArray(recipe.models)) {
      problems.push('models must be an array of strings or { id, label?, tier?, credits?, vendor? } objects')
    } else {
      recipe.models.forEach((model, index) => {
        if (typeof model === 'string') {
          if (model.trim() === '') problems.push(`models[${index}] must not be an empty string`)
          return
        }
        if (!isPlainObject(model)) {
          problems.push(`models[${index}] must be a string or an object`)
          return
        }
        if (!isString(model.id)) problems.push(`models[${index}].id must be a non-empty string`)
        if (model.tier !== undefined && !TIERS.includes(model.tier)) {
          problems.push(`models[${index}].tier must be one of ${TIERS.join(' | ')}`)
        }
        if (model.label !== undefined && !isString(model.label)) problems.push(`models[${index}].label must be a non-empty string`)
        if (model.credits !== undefined && typeof model.credits !== 'string' && typeof model.credits !== 'number') {
          problems.push(`models[${index}].credits must be a string or a number`)
        }
        if (model.vendor !== undefined && typeof model.vendor !== 'string') problems.push(`models[${index}].vendor must be a string`)
      })
    }
  }
```

在 `if (recipe.caps !== undefined ...)` 那一行之后追加三个块的校验：

```js
  if (recipe.catalog !== undefined) {
    if (!isPlainObject(recipe.catalog)) problems.push('catalog must be an object')
    else {
      const catalog = recipe.catalog
      if (!isString(catalog.kind)) problems.push('catalog.kind must be a non-empty string')
      else if (!CATALOG_KINDS.includes(catalog.kind)) problems.push(`catalog.kind must be one of ${CATALOG_KINDS.join(' | ')}`)
      if (catalog.kind === 'jsonFile') {
        const paths = Array.isArray(catalog.path) ? catalog.path : [catalog.path]
        if (!paths.some((p) => isString(p))) problems.push('catalog.kind jsonFile needs a non-empty path (string or array of strings)')
      }
      if (catalog.kind === 'argv' && (!Array.isArray(catalog.argv) || catalog.argv.some((a) => typeof a !== 'string'))) {
        problems.push('catalog.kind argv needs an argv array of strings')
      }
      if (catalog.pick !== undefined && !isString(catalog.pick)) problems.push('catalog.pick must be a path string')
      if (catalog.map !== undefined && !isPlainObject(catalog.map)) problems.push('catalog.map must be an object of field paths')
      if (catalog.excludeTags !== undefined && (!Array.isArray(catalog.excludeTags) || catalog.excludeTags.some((t) => typeof t !== 'string'))) {
        problems.push('catalog.excludeTags must be an array of strings')
      }
      if (catalog.ttlMs !== undefined && (!Number.isInteger(catalog.ttlMs) || catalog.ttlMs < 0)) {
        problems.push('catalog.ttlMs must be a non-negative integer')
      }
    }
  }

  if (recipe.balance !== undefined) {
    if (!isPlainObject(recipe.balance)) problems.push('balance must be an object')
    else {
      const balance = recipe.balance
      if (!isString(balance.kind)) problems.push('balance.kind must be a non-empty string')
      else if (!BALANCE_KINDS.includes(balance.kind)) problems.push(`balance.kind must be one of ${BALANCE_KINDS.join(' | ')}`)
      if (balance.kind === 'http') {
        if (!isString(balance.base)) problems.push('balance.kind http needs a base URL')
        if (!isPlainObject(balance.summary) || !isString(balance.summary.path)) problems.push('balance.summary needs a { method, path }')
        if (balance.loginProbe !== undefined && (!isPlainObject(balance.loginProbe) || !isString(balance.loginProbe.path))) {
          problems.push('balance.loginProbe needs a { method, path }')
        }
      }
      if (balance.map !== undefined && !isPlainObject(balance.map)) problems.push('balance.map must be an object of field paths')
      if (balance.unit !== undefined && typeof balance.unit !== 'string') problems.push('balance.unit must be a string')
      // A bridge plugin gets no write capability. Not "we remember not to call it" —
      // the schema refuses to describe one.
      if (balance.write !== undefined && balance.write !== null) {
        problems.push('balance.write is not supported: this plugin never mutates an account')
      }
    }
  }

  if (recipe.interpreter !== undefined) {
    if (!isPlainObject(recipe.interpreter)) problems.push('interpreter must be an object')
    else if (!INTERPRETER_SOURCES.includes(recipe.interpreter.source)) {
      problems.push(`interpreter.source must be one of ${INTERPRETER_SOURCES.join(' | ')}`)
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/recipe-wizard.mjs && node tests/parse-fixtures.mjs`
Expected: 全 PASS（含既有断言）

- [ ] **Step 5: 提交**

```bash
git add lib/recipe.js tests/recipe-wizard.mjs
git commit -m "feat(recipe): validate catalog/balance/interpreter and object models"
```

---

### Task 5: 解释器支持

**Files:**
- Modify: `lib/engine.js`（在 `buildArgs` 之后新增 `resolveSpawn`）
- Modify: `lib/host.js:537-546`（启动调用）
- Test: `tests/interpreter.mjs`

- [ ] **Step 1: 写失败测试**

创建 `tests/interpreter.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/interpreter.mjs`
Expected: FAIL — `resolveSpawn is not a function`

- [ ] **Step 3: 实现**

在 `lib/engine.js` 的 `buildArgs` 函数之后追加：

```js
/**
 * Resolve what to actually spawn for a recipe.
 *
 * Some agent CLIs are JavaScript entry points (`bin/codebuddy` is a .js file,
 * not an executable). Those recipes declare an interpreter and the launcher
 * runs them through Node instead of handing the script to the OS.
 *
 * `source: "self"` reuses the Node that is already running this plugin — no
 * second runtime to discover, and no path guessing.
 */
export function resolveSpawn(recipe, exe, args) {
  const interpreter = recipe && recipe.interpreter
  if (!interpreter) return { command: exe, argv: [...args] }
  if (interpreter.source === 'self') return { command: process.execPath, argv: [exe, ...args] }
  throw new Error(`interpreter.source "${interpreter.source}" is not supported yet`)
}
```

把 `lib/host.js` 的启动调用改成：

```js
  const spawn = resolveSpawn(recipe, exe, args)
  const raw = await launch(ctx, spawn.command, spawn.argv, {
    cwd: workdir,
    logDir: LOG_DIR,
    label: `${recipe.id}-${mode}`,
    timeoutMs: spec.timeoutMs || 600000,
    signal: spec.signal,
    // buildArgs leaves the prompt OUT of argv when a recipe declares
    // `prompt.via: "stdin"`; without handing it over here it would be dropped.
    stdinText: promptVia === 'stdin' ? prompt : '',
  })
```

并把 `result.Exe = exe` 之后补一行（`result.Args` / `result.Exe` 语义保持不变，避免破坏既有报告消费方）：

```js
  if (spawn.command !== exe) result.Launcher = spawn.command
```

同时把 `lib/host.js` 顶部从 `./engine.js` 的 import 列表里补上 `resolveSpawn`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/interpreter.mjs && node tests/host-harness.mjs`
Expected: 都通过

- [ ] **Step 5: 提交**

```bash
git add lib/engine.js lib/host.js tests/interpreter.mjs
git commit -m "feat(engine): resolveSpawn so a .js agent CLI can run through node"
```

---

### Task 6: WorkBuddy recipe

**Files:**
- Create: `lib/recipes/workbuddy.json`
- Create: `fixtures/workbuddy-result.json`
- Modify: `package.json`（test 脚本）

- [ ] **Step 1: 写失败测试**

在 `tests/recipe-wizard.mjs` 的 `process.exit` 之前追加：

```js
/* ---- the bundled WorkBuddy recipe ---- */
import { loadRecipe } from '../lib/engine.js'
import { join as joinPath } from 'node:path'

const wb = loadRecipe(joinPath(process.cwd(), 'lib', 'recipes', 'workbuddy.json'))
const wbVerdict = validateRecipe(wb)
check('the bundled workbuddy recipe validates', wbVerdict.ok, wbVerdict.problems.join('; '))
check('it points at the codebuddy entry point', JSON.stringify(wb.discover.paths.win32).includes('codebuddy'))
check('it runs headless', wb.run.argv.includes('-p'))
check('it reads JSON', wb.output.format === 'json')
check('it maps the model flag', wb.run.model.flag.join(' ') === '--model')
check('it declares an interpreter', wb.interpreter.source === 'self')
check('its catalog is the account config first', wb.catalog.path[0].includes('acc-product-config-v3.json'))
check('its catalog falls back to the install bundle', wb.catalog.path[1].includes('product.json'))
check('its balance is read-only', wb.balance.write === null)
check('its balance has no write endpoint', !JSON.stringify(wb.balance).includes('checkin'))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/recipe-wizard.mjs`
Expected: FAIL — `ENOENT ... workbuddy.json`

- [ ] **Step 3: 写 recipe**

创建 `lib/recipes/workbuddy.json`：

```json
{
  "id": "workbuddy",
  "label": "WorkBuddy",
  "vendor": "Tencent",
  "cost": "paid",
  "homepage": "https://www.workbuddy.cn",
  "notes": "Tencent CodeBuddy Code (genie). This desktop build ships ONLY the headless bundle: dist/codebuddy-headless.js exists, dist/codebuddy.js (the TUI) does not, so the interactive /login command is unavailable. Authentication therefore comes from the environment (CODEBUDDY_AUTH_TOKEN) or from a desktop-spilled ACC product config; without one the CLI exits with 'Authentication required'.",

  "discover": {
    "env": ["WORKBUDDY_CLI", "CODEBUDDY_CLI"],
    "bin": ["codebuddy", "cbc"],
    "paths": {
      "win32": [
        "%WORKBUDDY_HOME%\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
        "D:\\work Buddy\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
        "%LOCALAPPDATA%\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
        "%PROGRAMFILES%\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy"
      ],
      "darwin": [
        "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
      ],
      "linux": [
        "/opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"
      ]
    }
  },

  "interpreter": { "source": "self" },

  "version": {
    "args": ["--version"],
    "match": "\\d+\\.\\d+\\.\\d+",
    "timeoutMs": 60000
  },

  "run": {
    "argv": ["-p", "--output-format", "json"],
    "prompt": { "via": "positional" },
    "model": { "flag": ["--model"] },
    "session": { "flag": ["--session-id"] },
    "resume": { "flag": ["-r"] },
    "workdir": { "via": "cwd" }
  },

  "output": {
    "format": "json",
    "answer": { "pick": "result" },
    "session": { "pick": "session_id" },
    "usage": {
      "cost": "total_cost_usd",
      "input": "usage.input_tokens",
      "output": "usage.output_tokens",
      "cacheRead": "usage.cache_read_input_tokens"
    }
  },

  "catalog": {
    "kind": "jsonFile",
    "path": [
      "%USERPROFILE%\\.workbuddy\\cache\\acc-product-config-v3.json",
      "%WORKBUDDY_HOME%\\resources\\app.asar.unpacked\\cli\\product.json",
      "D:\\work Buddy\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\product.json"
    ],
    "pick": "models",
    "map": { "id": "id", "label": "name", "credits": "credits", "vendor": "vendor" },
    "excludeTags": ["text-to-image", "text-to-video", "image-to-video"],
    "ttlMs": 300000
  },

  "balance": {
    "kind": "http",
    "base": "https://www.workbuddy.cn",
    "loginProbe": { "method": "GET", "path": "/console/accounts", "pick": "data.accounts" },
    "summary": { "method": "POST", "path": "/v2/billing/meter/get-user-resource-summary", "body": {} },
    "map": { "id": "ResourceId", "label": "PackageName", "total": "total", "used": "used" },
    "unit": "积分",
    "write": null
  },

  "models": ["auto"],

  "caps": {
    "model": true,
    "session": true,
    "resume": true,
    "files": false,
    "autoApprove": false,
    "structured": true
  },

  "safety": {
    "note": "Runs headless with -p. No permission-bypass flag is declared, so the CLI keeps its own prompts. The account token is read from the environment; this plugin never stores or writes one."
  }
}
```

- [ ] **Step 4: 加 fixture**

创建 `fixtures/workbuddy-result.json`（`-p --output-format json` 的真实形状：单行 JSON 对象）：

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "OK",
  "session_id": "01a13073-89bd-7f1c-8814-08d193f5d469",
  "total_cost_usd": 0,
  "usage": { "input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 0 }
}
```

- [ ] **Step 5: 把新测试挂进 package.json**

`package.json` 的 `scripts.test` 改为（在末尾追加三个新文件）：

```json
"test": "node tests/client-boot.mjs && node tests/client-render.mjs && node tests/recipe-wizard.mjs && node tests/parse-fixtures.mjs && node tests/parse-recorded.mjs && node tests/stdin-transport.mjs && node tests/discovery-matrix.mjs && node tests/registry-import.mjs && node tests/pack-check.mjs && node tests/migration.mjs && node tests/host-harness.mjs && node tests/catalog-normalize.mjs && node tests/catalog-io.mjs && node tests/balance.mjs && node tests/interpreter.mjs"
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node tests/recipe-wizard.mjs && node tests/parse-recorded.mjs`
Expected: 通过（`parse-recorded` 会为每个 recipe 找 fixture）

- [ ] **Step 7: 提交**

```bash
git add lib/recipes/workbuddy.json fixtures/workbuddy-result.json package.json tests/recipe-wizard.mjs
git commit -m "feat(recipe): add the WorkBuddy agent with catalog and read-only balance"
```

---

### Task 7: host 输出归一化模型与余额

**Files:**
- Modify: `lib/host.js:223-242`（`agentsView`）
- Modify: `lib/host.js`（`agent_list` 工具返回体与 HTTP 端点）
- Test: `tests/host-harness.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/host-harness.mjs` 的 `process.exit` 之前追加：

```js
/* ---- 0.2.0: normalized models + balance in the agent view ---- */
const listTool = tools.get('agent_list')
const listed = await listTool.execute({}, {})
const wbAgent = (listed.agents || []).find((a) => a.id === 'workbuddy')
check('workbuddy shows up in the agent list', Boolean(wbAgent))
check('its models are objects', wbAgent && wbAgent.models.every((m) => typeof m === 'object'))
check('the legacy modelIds array is still there', wbAgent && Array.isArray(wbAgent.modelIds))
check('the model ids match the models', wbAgent && wbAgent.models.every((m) => wbAgent.modelIds.includes(m.id)))
check('every model carries a tier', wbAgent && wbAgent.models.every((m) => ['free', 'paid', 'unknown'].includes(m.tier)))
check('the balance state is present', wbAgent && ['ok', 'unauthenticated', 'unsupported', 'error'].includes(wbAgent.balance.state))
check('with no token the balance is unauthenticated', wbAgent && wbAgent.balance.state === 'unauthenticated')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/host-harness.mjs`
Expected: FAIL — `its models are objects`（当前是字符串数组）

- [ ] **Step 3: 实现**

把 `lib/host.js:223-242` 的 `agentsView` 替换为：

```js
/**
 * Read-only view of every recipe plus where its CLI was found.
 *
 * `models` is the normalized shape (id/label/tier/credits) added in 0.2.0.
 * `modelIds` keeps the 0.1.x `string[]` contract alive for existing consumers.
 */
async function agentsView(state) {
  const rows = []
  for (const recipe of loadRecipes()) {
    const found = discover(recipe)
    const configured = state.agents[recipe.id] || {}
    const catalog = await readCatalog(recipe)
    const balance = await readBalance(recipe)
    rows.push({
      id: recipe.id,
      label: recipe.label || recipe.id,
      vendor: recipe.vendor || '',
      cost: recipe.cost || 'unknown',
      caps: recipe.caps || {},
      models: catalog.models,
      modelIds: catalog.models.map((model) => model.id),
      catalogSource: catalog.source,
      catalogError: catalog.catalogError,
      balance,
      model: configured.model || '',
      installed: found.length > 0,
      path: found.length ? found[0].path : '',
      source: found.length ? found[0].source : '',
      candidates: found.length,
    })
  }
  return rows
}
```

在 `lib/host.js` 顶部 import 区加：

```js
import { readCatalog } from './catalog.js'
import { readBalance } from './balance.js'
```

把所有 `agentsView(state)` 的调用点改成 `await agentsView(state)`（`agent_list` 工具、HTTP 端点），并确认这些调用点本身已在 async 上下文里。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/host-harness.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/host.js tests/host-harness.mjs
git commit -m "feat(host): expose normalized models, modelIds and balance per agent"
```

---

### Task 8: 面板徽章与余额行

**Files:**
- Modify: `lib/client.js:253-262`（模型下拉）
- Modify: `lib/client.js:235-243`（agent 行）
- Test: `tests/client-render.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/client-render.mjs` 的 `process.exit` 之前追加：

```js
/* ---- 0.2.0: free/paid badges and the balance line ---- */
const withCatalog = {
  agents: [
    {
      id: 'workbuddy', label: 'WorkBuddy', vendor: 'Tencent', cost: 'paid',
      installed: true, path: 'C:\\wb\\codebuddy', model: '',
      models: [
        { id: 'fast-model', label: '快速', tier: 'paid', creditsText: 'x0.21', credits: 0.21, vendor: 'f' },
        { id: 'hy3', label: 'Hy3', tier: 'free', creditsText: 'x0.00 credits', credits: 0, vendor: '' },
      ],
      modelIds: ['fast-model', 'hy3'],
      balance: { state: 'ok', unit: '积分', total: 1500, remaining: 380, packages: [{ id: 'free', label: '免费包', total: 500, used: 120, remaining: 380 }] },
    },
  ],
  auto: false, defaultAgent: 'workbuddy', defaultMode: 'verify',
  enabled: { verify: true, bulk: false, second: false },
}
const rendered = renderPanel(withCatalog)
check('a free model is labelled', rendered.includes('免费'))
check('a paid model shows its multiplier', rendered.includes('x0.21'))
check('the balance is shown', rendered.includes('380'))
check('the balance unit is shown', rendered.includes('积分'))

const notLoggedIn = renderPanel({
  ...withCatalog,
  agents: [{ ...withCatalog.agents[0], balance: { state: 'unauthenticated', packages: [] } }],
})
check('unauthenticated says so in words', notLoggedIn.includes('未登录'))
check('unauthenticated shows no number', !/剩余\s*\d/.test(notLoggedIn))

const unsupported = renderPanel({
  ...withCatalog,
  agents: [{ ...withCatalog.agents[0], balance: { state: 'unsupported', packages: [] } }],
})
check('unsupported renders no balance row', !unsupported.includes('未登录') && !unsupported.includes('余额获取失败'))
```

> 注：`renderPanel` 的具体用法照抄该文件里已有的渲染辅助函数名（同文件已有把 host 状态渲染成 HTML 字符串的辅助），若现有辅助叫别的名字，用它的名字。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/client-render.mjs`
Expected: FAIL — 找不到「免费」/「380」/「未登录」

- [ ] **Step 3: 实现**

`lib/client.js` 里模型下拉的 `<option>` 构造改为（替换 `agent.models.map(...)` 那一段）：

```js
                  agent.models.map((m) => {
                    const tag = m.tier === 'free' ? '免费' : (m.tier === 'paid' ? '付费' + (m.creditsText ? ' ' + m.creditsText.replace(/^x/i, 'x') : '') : '')
                    const text = (m.label || m.id) + (tag ? ' · ' + tag : '')
                    return React.createElement('option', { key: m.id, value: m.id }, text)
                  }),
```

在 agent 行的 `probeById` 那段之后、模型下拉之前插入余额行：

```js
            (agent.balance && agent.balance.state !== 'unsupported')
              ? React.createElement('span', { style: s.lastPath },
                  agent.balance.state === 'ok'
                    ? `余额 ${agent.balance.remaining}/${agent.balance.total} ${agent.balance.unit || ''}`.trim()
                    : agent.balance.state === 'unauthenticated'
                      ? '余额：未登录（设置 CODEBUDDY_AUTH_TOKEN 后自动显示）'
                      : '余额获取失败：' + (agent.balance.detail || '原因未知'))
              : null,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/client-render.mjs && node tests/client-boot.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/client.js tests/client-render.mjs
git commit -m "feat(client): free/paid badges in the model picker and a balance line"
```

---

### Task 9: 版本、文档与全量回归

**Files:**
- Modify: `package.json`（version → 0.2.0）
- Modify: `CHANGELOG.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1: 加图例测试**

在 `tests/pack-check.mjs` 的 `process.exit` 之前追加：

```js
/* The package must not describe a write capability it does not have. */
const recipeFiles = readdirSync(join(root, 'lib', 'recipes')).filter((f) => f.endsWith('.json'))
for (const file of recipeFiles) {
  const recipe = JSON.parse(readFileSync(join(root, 'lib', 'recipes', file), 'utf8'))
  check(`${file} declares no balance write capability`, !recipe.balance || recipe.balance.write === null || recipe.balance.write === undefined)
}
```

- [ ] **Step 2: 跑测试确认失败或通过**

Run: `node tests/pack-check.mjs`
Expected: PASS（该断言现在应当已经成立；若 FAIL 说明有 recipe 破了红线，先修）

- [ ] **Step 3: 升版本并补文档**

`package.json`：`"version": "0.2.0"`。

`CHANGELOG.md` 顶部插入：

```markdown
## 0.2.0

- **New agent: WorkBuddy** (Tencent CodeBuddy Code). Headless-only: this desktop build ships
  `dist/codebuddy-headless.js` but not the TUI bundle, so the interactive `/login` cannot run.
  Authentication comes from `CODEBUDDY_AUTH_TOKEN`; without it the CLI reports
  `Authentication required` and the panel says "未登录" rather than inventing a number.
- **Model picker with free/paid badges**, for every agent. Catalogs are declared in the recipe
  (`catalog`) and read from disk with a TTL cache; a missing or malformed catalog degrades to the
  recipe's own static list with the reason attached.
- **Balance display** (four states: ok / unauthenticated / unsupported / error). Read-only by
  construction — `balance.write` is rejected by the schema, so the plugin cannot describe a call
  that mutates an account.
- **`interpreter`** on a recipe, so a JavaScript agent CLI runs through the Node that is already
  hosting the plugin (`source: "self"`).
- `agent_list` now returns normalized `models` objects; `modelIds` keeps the 0.1.x `string[]`
  contract working.
```

`README.md` / `README.zh-CN.md`：在 recipe 字段说明表里补 `catalog` / `balance` / `interpreter` 三行，并在 WorkBuddy 小节里写明「本机 CLI 无法自助登录，余额显示未登录」这一事实。

- [ ] **Step 4: 全量回归**

Run: `node tests/client-boot.mjs && node tests/client-render.mjs && node tests/recipe-wizard.mjs && node tests/parse-fixtures.mjs && node tests/parse-recorded.mjs && node tests/stdin-transport.mjs && node tests/discovery-matrix.mjs && node tests/registry-import.mjs && node tests/pack-check.mjs && node tests/migration.mjs && node tests/host-harness.mjs && node tests/catalog-normalize.mjs && node tests/catalog-io.mjs && node tests/balance.mjs && node tests/interpreter.mjs`
Expected: 每个文件最后都是 `all good` 或等价成功输出，exit 0

- [ ] **Step 5: 在真实 DSH 里验证**

1. 重启 desktop profile（或让 HMR 重载宿主半边）
2. 打开会话头部的 **Agent 桥接** 面板
3. 期望：出现 `WorkBuddy` 行；选中后模型下拉列出账号级目录里的模型，免费项带「免费」、付费项带「付费 x0.21」；余额行显示「余额：未登录（设置 CODEBUDDY_AUTH_TOKEN 后自动显示）」
4. `opencode` 行的免费模型同样带「免费」

- [ ] **Step 6: 提交**

```bash
git add package.json CHANGELOG.md README.md README.zh-CN.md tests/pack-check.mjs
git commit -m "chore: 0.2.0 — docs, version, and the no-write-capability guard"
```

---

## Self-Review

**Spec coverage**

| spec 章节 | 对应任务 |
|---|---|
| 4.1 schema 扩展（models 对象 / catalog / balance / interpreter） | Task 1, 4 |
| 4.2 目录模块（双源、TTL、降级） | Task 1, 2 |
| 4.2 余额四态 | Task 3 |
| 4.3 解释器 | Task 5 |
| 4.4 WorkBuddy recipe | Task 6 |
| 4.5 前端徽章 + 余额行 | Task 8 |
| 4.6 兼容（`modelIds`） | Task 7 |
| §2 非目标（不接写接口） | Task 3 Step 5 + Task 4 `balance.write` 拒绝 + Task 9 Step 1 |
| §5 验收标准 | Task 9 Step 4/5 |
| §6 测试计划 | Task 1/2/3/5 新建，4/7/8 扩写 |

**类型一致性**：`ModelInfo` 字段 `{ id, label, vendor, creditsText, credits, tier }` 在 Task 1 定义，Task 7/8 消费同一批字段名；`balance` 形状 `{ state, packages, total, remaining, unit, at, detail }` 在 Task 3 定义，Task 7/8 消费。`resolveSpawn` 返回 `{ command, argv }`，Task 5 的 host 改动按此解构。

**未决**：Task 8 Step 1 的 `renderPanel` 名称需按 `tests/client-render.mjs` 现有的渲染辅助实际名字对齐（该文件已有等价辅助），执行时以现有名字为准。
