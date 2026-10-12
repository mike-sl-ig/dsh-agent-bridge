/**
 * Render-level test for the client half.
 *
 * The complaint that produced this file: 「刷新 / 连通检查」 ran a real `--version`
 * probe for seconds and the panel said NOTHING, so success and failure looked
 * identical. A boot regression cannot catch that — `client-boot.mjs` never
 * renders. So this harness renders the REAL component with a minimal React
 * (hook state that survives re-renders) plus a fake fetch returning the route
 * payload, clicks the REAL button, and asserts on the text a user would read.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SRC = new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

function makeHarness() {
  const loaded = []
  let values = []
  let index = 0
  let fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })

  const React = {
    useState: (initial) => {
      const slot = index++
      if (values[slot] === undefined) values[slot] = initial
      return [values[slot], (next) => { values[slot] = typeof next === 'function' ? next(values[slot]) : next }]
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props || {}, { children: children.flat() }) }),
  }

  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => loaded.push(registration) } },
    console,
    fetch: (url) => fetchImpl(url),
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox)
  const registration = loaded[0]
  const module = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })

  let component = null
  module.apply({
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    slots: {
      register: (options, rendered) => { component = rendered; return () => {} },
      inject: (key, callback) => { callback(); return () => {} },
    },
  })

  return {
    /** Seed the hook values (once); later renders keep whatever setters changed. */
    seed(initial) { values = initial.slice(); index = 0; return component() },
    /** Re-render with the current state, exactly like React would. */
    render() { index = 0; return component() },
    setFetch(fn) { fetchImpl = fn },
    /** Answer the next `api/agent.bridge` GET with this payload. */
    setPayload(payload) {
      fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
    },
  }
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.props) return textOf(node.props.children)
  return ''
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findButton(item, label); if (hit) return hit }
    return null
  }
  if (node.type === 'button' && textOf(node).includes(label)) return node
  return findButton(node.props && node.props.children, label)
}

/* ------------------------------------------------------------ fixtures */

const CFG = { auto: false, defaultAgent: 'opencode', defaultMode: 'default', enabled: { verify: true, bulk: false, second: false }, agents: {} }
const AGENTS = [
  { id: 'opencode', label: 'OpenCode', cost: 'free', installed: true, path: 'C:\\x\\opencode-cli.exe', models: [], model: '' },
  { id: 'claude', label: 'Claude Code', cost: 'paid', installed: true, path: 'C:\\y\\claude.exe', models: [], model: '' },
]
// [open, state, agents, last, selftest, probe, status, busy, note]
const hooks = (over = {}) => [
  true, CFG, AGENTS, null, null, null, null, false, '',
].map((value, at) => (over[at] === undefined ? value : over[at]))

/* ------------------------------------------------- 1. nothing is claimed yet */

const h = makeHarness()
let tree = h.seed(hooks())
check('the panel renders', textOf(tree).includes('Agent 桥接') && textOf(tree).includes('默认 agent'))
check('it claims no outcome before a check has run',
  !/(✓|✗|…)\s*连通检查/.test(textOf(tree)) && !textOf(tree).includes('正在检查'),
  textOf(tree).slice(0, 90))

/* ------------------------------------------------------- 2. a successful probe */

h.setPayload({
  state: CFG,
  agents: AGENTS,
  probed: [
    { id: 'claude', installed: true, ok: true, version: '2.1.284 (Claude Code)' },
    { id: 'opencode', installed: true, ok: true, version: 'opencode v2.0.19' },
  ],
})
const refresh = findButton(tree, '刷新 / 连通检查')
check('the refresh button exists and is clickable', Boolean(refresh && typeof refresh.props.onClick === 'function'))
await refresh.props.onClick()
await settle()
const successText = textOf(h.render())
check('a successful check says so in words', successText.includes('连通检查 2/2 可用'), successText.slice(0, 120))
check('the line names every agent with its probed version',
  successText.includes('opencode v2.0.19') && successText.includes('claude 2.1.284'), successText.slice(0, 160))
const rowOk = successText.includes('连通 ✓ opencode v2.0.19') && successText.includes('连通 ✓ 2.1.284 (Claude Code)')
check('each agent row carries its own connectivity answer', rowOk, rowOk ? '' : successText.replace(/\s+/g, ' '))
check('the outcome is timestamped, so the user knows when', /\d{2}:\d{2}:\d{2}/.test(successText))

/* --------------------------------------------------------- 3. a failed probe */

h.setPayload({
  state: CFG,
  agents: AGENTS,
  probed: [{ id: 'opencode', installed: true, ok: false, note: 'exit 1' }],
})
await findButton(h.render(), '刷新 / 连通检查').props.onClick()
await settle()
const failText = textOf(h.render())
check('a failed check is reported as a failure', failText.includes('连通检查 0/1') && failText.includes('✗'), failText.slice(0, 120))
check('the failure carries the agent\'s own reason', failText.includes('exit 1') && failText.includes('连通 ✗'))

/* --------------------------------------------------- 4. the transport failed */

const h2 = makeHarness()
tree = h2.seed(hooks())
h2.setFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }))
await findButton(tree, '刷新 / 连通检查').props.onClick()
await settle()
const httpText = textOf(h2.render())
check('an HTTP failure is visible instead of silent',
  httpText.includes('检查失败') && httpText.includes('HTTP 500'), httpText.slice(0, 120))

/* ------------------------------------------------------------- 5. busy state */

const h3 = makeHarness()
const busyText = textOf(h3.seed(hooks({ 7: true })))
check('while a check runs the buttons say so', busyText.includes('检查中…'), busyText.slice(0, 80))
check('while a check runs the header says so', busyText.includes('同步中…'))

/* ---------------------------------------------------- 6. the selftest action */

const h4 = makeHarness()
tree = h4.seed(hooks())
h4.setPayload({
  state: CFG,
  agents: AGENTS,
  selftest: [
    { id: 'opencode', label: 'OpenCode', ok: true, recipeValid: true, installed: true, probe: { ok: true }, fixture: { ok: true } },
    { id: 'claude', label: 'Claude Code', ok: false, recipeValid: true, installed: true, probe: { ok: false }, problems: ['boom'] },
  ],
})
await findButton(tree, '自检').props.onClick()
await settle()
const selfText = textOf(h4.render())
check('the selftest action reports its own outcome', selfText.includes('自检 1/2 通过'), selfText.slice(0, 140))
check('the selftest lists each agent verdict', selfText.includes('OK  OpenCode') && selfText.includes('FAIL  Claude Code'))

/* ---- 0.2.0: free/paid badges and the balance line ---- */
/* NOTE: this file has no `renderPanel` helper. Its real helpers are
 * makeHarness() / hooks(over) / textOf(node), so renderPanel is defined here in
 * terms of them: hook slot 1 is the host state, slot 2 the agent rows. */
function renderPanel(payload) {
  const h = makeHarness()
  return textOf(h.seed(hooks({ 1: payload, 2: payload.agents })))
}

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

const reminded = renderPanel({ ...withCatalog, remind: true })
check('the panel offers the advisory reminder switch', reminded.includes('自动提醒'))

/* Hook slots are seed-by-index: 0=open 1=state 2=agents 3=last — so the
 * "最近一次运行" card is reachable by seeding slot 3. */
function renderWithLast(payload, last) {
  const h = makeHarness()
  return textOf(h.seed(hooks({ 1: payload, 2: payload.agents, 3: last })))
}
const refused = renderWithLast(withCatalog, {
  Ok: false, Agent: 'opencode', Mode: 'verify', Seconds: 1, ToolCalls: 0,
  Error: 'Upstream request failed: Invalid credential', ErrorCode: 'provider.auth/401',
})
check('a failed run shows the CLI reason, not a bare placeholder',
  refused.includes('失败原因') && refused.includes('Invalid credential'))
check('and shows the error code', refused.includes('provider.auth/401'))
const unexplained = renderWithLast(withCatalog, { Ok: false, Agent: 'opencode', Mode: 'verify', Error: '' })
check('an unexplained failure still says there was no answer',
  unexplained.includes('没有产出最终答案') && !unexplained.includes('失败原因'))

/* ---- 0.4.0: a pool, so more than one agent can be switched on ---- */
const twoAgents = {
  ...withCatalog,
  pool: ['workbuddy', 'opencode'],
  agents: [
    withCatalog.agents[0],
    { id: 'opencode', label: 'OpenCode', vendor: 'opencode.ai', cost: 'free', installed: true, path: 'C:\\oc\\opencode.exe',
      models: [{ id: 'opencode/big-pickle', label: 'big-pickle', tier: 'unknown' }], modelIds: ['opencode/big-pickle'],
      balance: { state: 'unsupported', packages: [] }, model: '' },
  ],
}
const pooledPanel = renderPanel(twoAgents)
check('both pooled agents render their own model picker',
  pooledPanel.includes('big-pickle') && pooledPanel.includes('快速'), pooledPanel.slice(0, 400))
check('the pool is not limited to one selection (no radio for the default)',
  !/name="agent-bridge-default"/.test(pooledPanel))

console.log(`\n${failures === 0 ? 'CLIENT RENDER: PASS' : `CLIENT RENDER: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
