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
