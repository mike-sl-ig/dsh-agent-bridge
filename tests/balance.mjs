/**
 * Balance — read-only, four states, and a hard rule: a plugin that cannot
 * prove the balance says so instead of showing a number.
 */

import { credentialHeaders, normalizeBalance, readBalance } from '../lib/balance.js'

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

/* ---- a credential that cannot travel must be refused in words ----------- */
let attempted = false
const nonAscii = await readBalance(recipe, {
  token: 'sk-测试的不是令牌',
  httpJson: () => { attempted = true; throw new Error('must not be called') },
})
check('a non-ASCII credential is refused before any request',
  nonAscii.state === 'error' && attempted === false, JSON.stringify(nonAscii.detail))
check('and the words say what is wrong and what to do',
  nonAscii.detail.includes('非 ASCII') && nonAscii.detail.includes('重新复制'), nonAscii.detail)
check('and they name the offending character', nonAscii.detail.includes('第 4 个'), nonAscii.detail)

/* ---- the credential must reach the wire, not merely be counted ---------- */
check('no credential means no header at all', Object.keys(credentialHeaders(spec, '')).length === 0)
check('whitespace is not a credential', Object.keys(credentialHeaders(spec, '   ')).length === 0)
check('a cookie-shaped value travels as Cookie',
  credentialHeaders(spec, 'SESSION=abc; sid=2').Cookie === 'SESSION=abc; sid=2')
check('a bare token travels as a bearer credential',
  credentialHeaders(spec, 'sk-live-123').Authorization === 'Bearer sk-live-123')
check('a recipe can name the header itself',
  credentialHeaders({ auth: { header: 'X-Api-Key' } }, 'k1')['X-Api-Key'] === 'k1')
check('and name the prefix too',
  credentialHeaders({ auth: { header: 'Authorization', prefix: 'Token ' } }, 'k2').Authorization === 'Token k2')

const realFetch = globalThis.fetch
let sent = []
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), headers: (init && init.headers) || {} })
  return {
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/console/accounts') ? { data: { accounts: [{ uid: 1 }] } } : { data: rows }),
  }
}
try {
  const wired = await readBalance(recipe, { token: 'SESSION=abc; sid=2' })
  check('the default transport really issues both calls', sent.length === 2, JSON.stringify(sent.map((s) => s.url)))
  check('both calls carry the cookie', sent.every((s) => s.headers.Cookie === 'SESSION=abc; sid=2'))
  check('the summary is still a POST with a JSON body', sent[1].headers['Content-Type'] === 'application/json')
  check('the wire form still yields a balance', wired.state === 'ok' && wired.remaining === 380)

  sent = []
  await readBalance(recipe, { token: 'sk-live-123' })
  check('a bare token reaches the wire as bearer', sent[0].headers.Authorization === 'Bearer sk-live-123')

  sent = []
  await readBalance({ id: 'wb', balance: { ...spec, auth: { header: 'X-Api-Key', prefix: 'K ' } } }, { token: 'k3' })
  check('a declared header wins over the auto rule',
    sent[0].headers['X-Api-Key'] === 'K k3' && !sent[0].headers.Cookie)
} finally {
  globalThis.fetch = realFetch
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
