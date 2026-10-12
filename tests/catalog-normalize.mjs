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

/* The account catalog marks real chat models with `supportsToolCall`; the
 * completion / NES / internal ones simply do not carry it. Measured on the live
 * config: 43 of 55 have it, and the 12 without are exactly the ones that must
 * not appear in a picker for an agent that is expected to run tasks. */
const mixed = [
  { id: 'glm-5.2', name: 'GLM-5.2', supportsToolCall: true, credits: 'x0.79' },
  { id: 'codewise-jump', name: 'codewise-jump' },
  { id: 'completion-gf', name: 'completion-gf', supportsToolCall: true },
]
const ids = (spec) => normalizeCatalog(mixed, { map: { id: 'id', label: 'name' }, ...spec }).map((m) => m.id).join(',')
check('require drops entries that do not satisfy it', ids({ require: { supportsToolCall: true } }) === 'glm-5.2,completion-gf')
check('a require on a missing field drops the entry', normalizeCatalog([{ id: 'x' }], { require: { supportsToolCall: true } }).length === 0)
check('require is ignored when it is not an object', ids({ require: 'yes' }) === 'glm-5.2,codewise-jump,completion-gf')
check('excludeIdPattern drops matching ids', ids({ excludeIdPattern: 'completion' }) === 'glm-5.2,codewise-jump')
check('excludeIdPattern is case-insensitive', ids({ excludeIdPattern: 'CODEWISE' }) === 'glm-5.2,completion-gf')
check('require and excludeIdPattern combine', ids({ require: { supportsToolCall: true }, excludeIdPattern: 'completion' }) === 'glm-5.2')
check('an invalid excludeIdPattern is ignored rather than throwing', ids({ excludeIdPattern: '[' }).split(',').length === 3)
check('an empty excludeIdPattern changes nothing', ids({ excludeIdPattern: '' }).split(',').length === 3)

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
