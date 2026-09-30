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

console.log(`\n${failures === 0 ? 'CLIENT RENDER: PASS' : `CLIENT RENDER: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
