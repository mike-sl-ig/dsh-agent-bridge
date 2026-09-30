/**
 * Client-half boot regression.
 *
 * Reproduces the failure that once made the whole Web UI refuse to boot:
 * SlotCore.register THROWS when its target slot is not declared yet, and on a
 * fresh boot a plugin bundle can activate before the conversation UI declares
 * `conversation.session.header.utilities`. A bare register() inside apply() then
 * fails the entry's fiber and the boot audit rejects the entire web boot
 * ("web boot: 1 entry did not activate").
 *
 * A0 replays the old shape and must THROW.
 * A1 runs the shipped module and must survive the ordering, then register once
 *    the owning slot appears.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SRC = process.env.CLIENT_SRC || new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const EXPECTED_ID = process.env.CLIENT_ID || 'dsh-agent-bridge'
const SLOT = 'conversation.session.header.utilities'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

function loadRealModule() {
  const captured = []
  const sandbox = { window: { __ModuleLoader__: { load: (registration) => captured.push(registration) } }, console }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox)
  if (captured.length !== 1) throw new Error(`expected exactly one __ModuleLoader__.load call, saw ${captured.length}`)
  const registration = captured[0]
  const React = {
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    createElement: () => null,
  }
  const module = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration, module }
}

/** A ctx whose target slot starts UNDECLARED, like a fresh boot. */
function makeCtx() {
  const state = { declared: false, registered: [], injected: [] }
  const ctx = {
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    slots: {
      register: (options) => {
        if (!state.declared) throw new Error(`registering into an undeclared slot "${options.name}"`)
        state.registered.push(options.id)
        return () => {}
      },
      inject: (key, callback) => { state.injected.push({ key, callback }); return () => {} },
    },
  }
  state.declare = () => { state.declared = true; for (const item of state.injected) item.callback() }
  return { ctx, state }
}

// A0 — the old shape must reproduce the boot failure.
{
  const { ctx } = makeCtx()
  let threw = null
  try {
    ctx.effect(() => ctx.slots.register({ name: SLOT, id: 'agent-bridge-mode' }, () => null), 'legacy')
  } catch (error) { threw = error }
  check('A0 bare register() throws while the slot is undeclared (reproduces the boot failure)',
    threw !== null && /undeclared slot/.test(String(threw.message)), threw === null ? 'did not throw' : threw.message)
}

// A1 — the shipped module must survive it.
{
  const { registration, module } = loadRealModule()
  check('A1 loader row id equals the package name', registration.id === EXPECTED_ID, registration.id)
  check('A1 module exports apply + inject', typeof module.apply === 'function' && Array.isArray(module.inject),
    `apply=${typeof module.apply} inject=${JSON.stringify(module.inject)}`)
  check('A1 the factory needs nothing beyond react', typeof registration.factory === 'function')

  const { ctx, state } = makeCtx()
  let threw = null
  try { module.apply(ctx) } catch (error) { threw = error }
  check('A1 apply() does not throw while the slot is undeclared', threw === null, threw && threw.message)
  check('A1 it deferred through slots.inject',
    state.injected.length === 1 && state.injected[0].key === SLOT, JSON.stringify(state.injected.map((i) => i.key)))
  check('A1 nothing was registered before the slot existed', state.registered.length === 0)

  state.declare()
  check('A1 the button registers once the owner declares the slot',
    state.registered.length === 1 && state.registered[0] === 'agent-bridge-mode', JSON.stringify(state.registered))
}

console.log(`\n${failures === 0 ? 'CLIENT BOOT REGRESSION: PASS' : `CLIENT BOOT REGRESSION: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
