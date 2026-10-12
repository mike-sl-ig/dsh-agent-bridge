# 候选池 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 面板从单选一个默认 agent 改为多选候选池；提醒列出整个池并交由主 agent 自行判断用哪个。

**Architecture:** 状态新增 `pool: string[]`，`defaultAgent` 降级为「池里第一个」的派生字段（保留以兼容 0.3.x 消费者）。提醒文案与 `resolveTarget` 都改为消费池。

**Spec:** `docs/superpowers/specs/2026-10-12-agent-pool-design.md`

---

### Task 1: 状态与迁移

**Files:** Modify `lib/host.js`（`DEFAULT_STATE` 87-95、`coerceState` 110-127、`migrateLegacyState` 136-154）; Test `tests/migration.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/migration.mjs` 的既有断言后追加（该文件的 `state` 变量是迁移后的状态）：

```js
check('the pool is derived from the old single default agent', Array.isArray(state.pool) && state.pool.join(',') === 'opencode', JSON.stringify(state.pool))
check('defaultAgent still reports the first pool member', state.defaultAgent === 'opencode')
```

并在文件末尾 `process.exit` 前追加一段**独立**的状态往返测试：

```js
/* ---- 0.4.0: pool migration and derivation ---- */
const { apply: applyFresh } = await import('../lib/host.js')
```

> 注意：`lib/host.js` 已在本文件顶部导入过（动态 import 以在 import 前设置 DSH_HOME），
> 这里**不要**重复导入；直接用文末已有的方式断言即可。若需要新的临时 home，照抄本文件
> 开头的 `mkdtempSync` + `process.env.DSH_HOME` 模式另起一个小节，但必须放在既有 import 之后
> 且不能重新 import host.js。

改为：直接对 `tools.get('agent_mode')` 断言 pool 的读写：

```js
const pooled = await tools.get('agent_mode').execute({ action: 'set', pool: ['opencode', 'claude'] })
check('agent_mode sets a pool', Array.isArray(pooled.state.pool) && pooled.state.pool.join(',') === 'opencode,claude', JSON.stringify(pooled.state.pool))
check('defaultAgent follows the first pool member', pooled.state.defaultAgent === 'opencode', pooled.state.defaultAgent)
const single = await tools.get('agent_mode').execute({ action: 'set', defaultAgent: 'claude' })
check('the legacy defaultAgent param still works and collapses the pool', single.state.pool.join(',') === 'claude', JSON.stringify(single.state.pool))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/migration.mjs`
Expected: FAIL — `the pool is derived from the old single default agent -- undefined`

- [ ] **Step 3: 实现**

`DEFAULT_STATE` 增加 `pool: []`（放在 `defaultAgent` 之前）。

`coerceState` 在 `agents` 处理之前插入：

```js
  /* 0.4.0: a pool of candidate agents replaces the single "default agent" the
   * panel used to radio-select. `defaultAgent` is kept — 0.3.x consumers read
   * it — but it is now DERIVED, so the two can never disagree. */
  if (Array.isArray(raw.pool)) {
    out.pool = raw.pool.filter((id) => typeof id === 'string' && id.trim() !== '')
  }
  if (!out.pool.length && typeof raw.defaultAgent === 'string' && raw.defaultAgent.trim() !== '') {
    // A state written before the pool existed had exactly one agent selected.
    out.pool = [raw.defaultAgent.trim()]
  }
  out.defaultAgent = out.pool[0] || ''
```

并**删除**原来的 `if (typeof raw.defaultAgent === 'string') out.defaultAgent = raw.defaultAgent` 一行
（否则会覆盖派生值）。`migrateLegacyState` 的 `defaultAgent: 'opencode'` 保持不动 —— 迁移路径
会自动把它变成 `pool: ['opencode']`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/migration.mjs`
Expected: 全 PASS（live 段可能响亮 SKIP）

- [ ] **Step 5: 提交**

```bash
git add lib/host.js tests/migration.mjs
git commit -m "feat(state): an agent pool, with defaultAgent derived from it"
```

---

### Task 2: 解析默认目标 + agent_mode + 路由

**Files:** Modify `lib/host.js`（`resolveTarget` ~563、`agent_mode` ~901-931、路由 ~999-1021）; Test `tests/host-harness.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/host-harness.mjs` 追加：

```js
/* ---- 0.4.0: the pool decides the default target ---- */
const poolSaved = await routeFetch('?save=1&auto=0&pool=' + encodeURIComponent('workbuddy,opencode') + '&verify=1&bulk=0&second=0')
check('the route stores a pool', Array.isArray(poolSaved.state.pool) && poolSaved.state.pool.join(',') === 'workbuddy,opencode', JSON.stringify(poolSaved.state.pool))
check('and derives defaultAgent from it', poolSaved.state.defaultAgent === 'workbuddy', poolSaved.state.defaultAgent)
const hinted = await tools.get('agent_run').execute({ prompt: 'Reply with exactly: POOL-OK', mode: 'default', timeoutMs: 120000 })
check('an unnamed call uses the first INSTALLED pool member',
  hinted.result.Agent === 'workbuddy' || hinted.result.Agent === 'opencode', hinted.result.Agent)
await routeFetch('?save=1&pool=' + encodeURIComponent('opencode'))
```

> `routeFetch` 与 `tools` 用该文件里已有的变量名。`workbuddy` 在本机已安装但未认证，
> 所以断言放宽为「池里第一个已安装的」而不是硬编码 workbuddy —— 未认证时它会失败，
> **失败也是合法的解析结果**，断言要看的是 `Agent` 属于池，不是它跑成功。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/host-harness.mjs`
Expected: FAIL — `the route stores a pool`

- [ ] **Step 3: 实现**

`resolveTarget` 的 wanted 解析改为：

```js
  const pool = Array.isArray(state.pool) ? state.pool : []
  const wanted = String(requested || '').trim()
  const recipe = wanted
    ? recipes.find((r) => r.id === wanted)
    : (pool
        .map((id) => recipes.find((r) => r.id === id))
        .find((r) => r && discover(r).length)
      || recipes.find((r) => discover(r).length)
      || recipes[0])
```

`agent_mode`：`parameters` 增加

```js
pool: { type: 'array', items: { type: 'string' }, description: 'Candidate agent ids. The first INSTALLED one is used when a call names none.' },
```

`execute` 的 set 分支改为：

```js
          const next = { ...current }
          if (Array.isArray(args.pool)) {
            next.pool = args.pool.filter((id) => typeof id === 'string' && id.trim() !== '')
            next.defaultAgent = next.pool[0] || ''
          } else if (typeof args.defaultAgent === 'string') {
            // The 0.3.x shorthand: name one agent, get a one-member pool.
            next.defaultAgent = args.defaultAgent
            next.pool = args.defaultAgent ? [args.defaultAgent] : []
          }
```

（保留既有的 `defaultMode` / `enabled` / `remind` / `agents` 处理；`agents` 的 model 写入不变。）

路由 `save` 分支：在读取 `defaultAgent` 之后增加

```js
            const pool = params.get('pool')
            const poolList = pool === null
              ? (defaultAgent === null ? state.pool : (defaultAgent ? [defaultAgent] : []))
              : pool.split(',').map((id) => id.trim()).filter(Boolean)
```

并把 `coerceState({...})` 的入参改为传 `pool: poolList`（不再传 `defaultAgent` —— 它由
`coerceState` 从 pool 派生）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/host-harness.mjs && node tests/migration.mjs`
Expected: 都通过

- [ ] **Step 5: 提交**

```bash
git add lib/host.js tests/host-harness.mjs
git commit -m "feat(host): resolve the default target and the route through the pool"
```

---

### Task 3: 提醒列出整个池

**Files:** Modify `lib/reminder.js`; Test `tests/reminder.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/reminder.mjs` 追加（该文件的 `on()` 构造器已有 `agents`）：

```js
/* ---- 0.4.0: the reminder lists the whole candidate pool ---- */
const pooled = on({
  pool: ['opencode', 'workbuddy'],
  defaultAgent: 'opencode',
  agents: { opencode: { model: 'opencode/mimo-v2.6-flash-free' }, workbuddy: { model: 'fast-model' } },
})
const pooledText = planInjection(pooled, { turn: 7, messages: [{ role: 'user' }] }, null).text
check('the reminder lists every pooled agent', pooledText.includes('opencode') && pooledText.includes('workbuddy'))
check('each candidate carries its own model',
  pooledText.includes('opencode/mimo-v2.6-flash-free') && pooledText.includes('fast-model'), pooledText)
check('and it hands the choice to the model', /由你判断/.test(pooledText))
check('a pooled agent without a configured model still appears', planInjection(on({ pool: ['claude'], defaultAgent: 'claude', agents: {} }), { turn: 8, messages: [{ role: 'user' }] }, null).text.includes('claude'))
const emptyPool = planInjection(on({ pool: [], defaultAgent: 'opencode' }), { turn: 9, messages: [{ role: 'user' }] }, null).text
check('an empty pool falls back to naming the default agent', emptyPool.includes('opencode') && !emptyPool.includes('候选 agent'))
```

同时把**既有**那条断言改掉：原 `the injected text names its configured model` 用的是
`on()`（无 pool），空池回退仍会点名 `opencode` 及其模型，因此那条**应当继续通过**，
不要删除。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/reminder.mjs`
Expected: FAIL — `the reminder lists every pooled agent`

- [ ] **Step 3: 实现**

`buildDelegationReminder(state, info)` 里，把 `target` 的计算与第二行文案改为：

```js
  const candidates = Array.isArray(info.candidates) ? info.candidates : []
  const list = candidates.length
    ? candidates.map((c) => `${escapeReminderText(c.agent)}${c.model ? ` (${escapeReminderText(c.model)})` : ''}`).join(' / ')
    : (agent ? `${agent}${model ? ` (${model})` : ''}` : '')
  const who = candidates.length
    ? `候选 agent：${list}。\n当任务适合时，可先用 agent_run(mode="${escapeReminderText(mode)}") 调用其中任意一个或多个；用哪个、用几个由你判断。`
    : `当任务适合时，可先用 agent_run(mode="${escapeReminderText(mode)}") 调用 ${list || '已配置的外部 agent'}；`
```

（`mode` 与其余行不变；空池分支保持现有文案，以便既有断言继续通过。）

`planInjection` 把候选列表从状态里取出来：

```js
  const pool = Array.isArray(state && state.pool) ? state.pool : []
  const configured = (state && state.agents) || {}
  const candidates = pool.map((id) => ({ agent: id, model: (configured[id] && configured[id].model) || '' }))
  const info = { agent: agentId, model: (configured[agentId] && configured[agentId].model) || '', candidates }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/reminder.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add lib/reminder.js tests/reminder.mjs
git commit -m "feat(reminder): list the whole candidate pool and hand over the choice"
```

---

### Task 4: 面板多选

**Files:** Modify `lib/client.js`（agent 行 ~227-265、`put` ~191）; Test `tests/client-render.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/client-render.mjs` 追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/client-render.mjs`
Expected: FAIL — `both pooled agents render their own model picker`

- [ ] **Step 3: 实现**

agent 行里把 radio 换成 checkbox：

```js
          React.createElement('input', {
            type: 'checkbox', style: s.box,
            checked: pool.includes(agent.id), disabled: !agent.installed || cfg.auto,
            onChange: (ev) => put((n) => {
              const next = new Set(Array.isArray(n.pool) ? n.pool : [])
              if (ev.target.checked) next.add(agent.id)
              else next.delete(agent.id)
              n.pool = [...next]
              n.defaultAgent = n.pool[0] || ''
            }),
          }),
```

模型下拉的条件由 `selected && ...` 改为 `pool.includes(agent.id) && agent.models && agent.models.length`，
`value` 与 `onChange` 保持不变（`setModel(agent.id, ...)`）。

在组件顶部把池读出来（紧跟 `defaultAgent` 的取值处）：

```js
      const pool = Array.isArray(cfg.pool) && cfg.pool.length ? cfg.pool : (cfg.defaultAgent ? [cfg.defaultAgent] : [])
```

`put` 的查询串：在既有参数之外，当 `n.pool` 是数组时追加 `&pool=` + `n.pool.join(',')`
（`put` 内部如何拼串照该函数现有写法；`model` 与 `agent` 参数保持不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/client-render.mjs && node tests/client-boot.mjs`
Expected: 都通过

- [ ] **Step 5: 提交**

```bash
git add lib/client.js tests/client-render.mjs
git commit -m "feat(client): select a pool of agents instead of a single default"
```

---

### Task 5: 版本、文档、全量回归

**Files:** Modify `package.json`, `CHANGELOG.md`, `README.md`, `README.zh-CN.md`

- [ ] **Step 1: 升版本并写 CHANGELOG**

`package.json` → `"version": "0.4.0"`。`CHANGELOG.md` 顶部插入 `## 0.4.0`：

```markdown
## 0.4.0

- **More than one agent can be switched on at once.** The panel used to radio-select a single
  "default agent", which contradicted what the role features are for: cross-model verification
  wants a *different* model family, and a second opinion wants a different head. It is now a pool
  (checkboxes), every pooled agent keeps its own model picker, and the reminder lists the whole
  pool and hands the choice back: "用哪个、用几个由你判断".
- **Behaviour change worth knowing:** a `verify` call may no longer use the agent you had selected
  as "primary" — picking a different family is the point. The first *installed* pool member is the
  default when a call names none.
- `defaultAgent` is kept in the state file (0.3.x consumers read it) but is now derived from the
  pool, so the two cannot disagree. An old state migrates losslessly: the single selected agent
  becomes a one-member pool.
```

- [ ] **Step 2: 全量回归**

Run: `node tests/client-boot.mjs && node tests/client-render.mjs && node tests/recipe-wizard.mjs && node tests/parse-fixtures.mjs && node tests/parse-recorded.mjs && node tests/stdin-transport.mjs && node tests/discovery-matrix.mjs && node tests/registry-import.mjs && node tests/pack-check.mjs && node tests/migration.mjs && node tests/host-harness.mjs && node tests/catalog-normalize.mjs && node tests/catalog-io.mjs && node tests/balance.mjs && node tests/interpreter.mjs && node tests/reminder.mjs && node tests/error-surface.mjs`
Expected: 全部 exit 0

- [ ] **Step 3: 提交**

```bash
git add package.json CHANGELOG.md README.md README.zh-CN.md
git commit -m "chore: 0.4.0 — agent pool, docs and version"
```

---

## Self-Review

**Spec coverage**：4.1→Task 1；4.2→Task 2；4.3→Task 3；4.4→Task 4；4.5→Task 2；§5 验收 1/6→Task 4/2，2→Task 3，5→Task 1，7→Task 5。

**已发现的坑**：`coerceState` 里原有的 `if (typeof raw.defaultAgent === 'string') out.defaultAgent = raw.defaultAgent`
若不删除，会覆盖派生值，导致路由把 `pool` 写对、`defaultAgent` 却错。Task 1 Step 3 已显式要求删除。

**类型一致性**：`state.pool: string[]` 在 Task 1 定义，Task 2/3/4 消费；`planInjection` 的
`info.candidates: {agent, model}[]` 在 Task 3 定义并自用；面板的 `pool` 局部变量与状态字段同名。
