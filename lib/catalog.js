/**
 * Model catalog — normalization half.
 *
 * The plugin ships two catalogs that spell the same fact differently: the
 * install bundle writes `"x0.79 credits"`, the account-level config writes
 * `"x0.21"`. Parsing is therefore written against the number, never against
 * one vendor's formatting, and an explicit `tier` in a recipe always wins over
 * anything inferred.
 */

import { readFileSync } from 'node:fs'
import { expandPath, pick } from './engine.js'

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
  /* `require` is a field-level keep-rule: the account catalog marks genuine chat
   * models with `supportsToolCall`, and the completion / NES / internal entries
   * simply do not carry it. A field is a far better signal than a name pattern. */
  const require = (spec.require && typeof spec.require === 'object' && !Array.isArray(spec.require)) ? spec.require : {}
  const requireKeys = Object.keys(require)
  /* A bad pattern must degrade to "no id filter", not take the picker down. */
  let idFilter = null
  if (typeof spec.excludeIdPattern === 'string' && spec.excludeIdPattern !== '') {
    try { idFilter = new RegExp(spec.excludeIdPattern, 'i') } catch { idFilter = null }
  }
  const out = []
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    if (!raw || typeof raw !== 'object') continue
    const id = String(mapped(raw, map.id, 'id') || '').trim()
    if (!id) continue
    if (idFilter && idFilter.test(id)) continue
    if (requireKeys.some((path) => pick(raw, path) !== require[path])) continue
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
