/**
 * Account balance — READ ONLY, by construction.
 *
 * The recipe declares where the balance lives; this module only ever issues
 * the two calls a recipe names (`loginProbe`, `summary`). There is no write
 * path in this file and there must never be one: the vendor's daily sign-in
 * endpoint grants credits and mutating an account from a bridge plugin is not
 * something a user should be able to trigger by accident. (That endpoint is
 * deliberately not named here: the static guard in the plan greps this file for
 * any mention of it, and prose counts.)
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
