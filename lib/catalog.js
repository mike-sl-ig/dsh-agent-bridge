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
