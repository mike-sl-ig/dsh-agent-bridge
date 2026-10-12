# 建议型自动委派提醒 — 设计

日期：2026-10-12
状态：已批准（用户选定「建议型」）

## 1. 问题

0.2.0 的 verify / bulk / second 三个能力是**被动的**：它们只在 `agent_run` 被调用时才起作用。
用户的原话：「每次在跑任务时都需要我自己主动说一句带上某个 agent 一起运行，不能像开子
agent 一样自动分配任务。」

也就是说，模型不知道这些能力存在、也不知道何时该用，所以用户必须每轮点名。

## 2. 机制（已在 DSH 内确认）

DSH 提供 `agent/pre-step` 水位钩子，插件可注册并在进入批次里追加消息：

```js
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
  const decision = await next()
  // decision.kind === "enter" → decision.messages 是进入本轮的消息数组
})
```

`@deepseek-ai/dsh-agent-instructions` 正是这么注入它自己的 `<system-reminder>` 的
（其 README 原文：插件拥有完整的 `<system-reminder>` 框架，每条注入消息原样到达模型）。
本插件复用同一机制。

## 3. 范围

**做：** 每个用户回合注入**一条**建议型提醒，列出用户真正开启的能力与当前默认 agent/模型。

**不做：**
- 不强制、不阻断。模型仍自行决定是否调用 `agent_run`。
- 不外包任务（「派活型」不在本次范围）。
- 不写用户的 `AGENTS.md` 或任何工作区文件。

## 4. 设计

### 4.1 `lib/reminder.js`（新，纯函数）

| 导出 | 职责 |
|---|---|
| `escapeReminderText(v)` | 转义 `<` `>`。recipe id / 模型名是外部数据（社区 recipe 可导入），**不能让 `</system-reminder>` 从数据里闭合掉插件拥有的框架** |
| `enabledFeatures(state)` | 返回开启的能力键，顺序固定 |
| `buildDelegationReminder(state, info)` | 构造提醒文本；不该注入时返回 `null` |
| `turnKey(payload)` | 回合标识；payload 没有可靠字段时返回 `null` |
| `planInjection(state, payload, lastKey)` | 纯决策：`{ inject, key, text }` |

**不注入的条件（全部为硬条件）**
1. `state.auto === true` —— 用户选了「DSH 全权」，桥接必须闭嘴
2. 三个能力全关
3. 同一回合已经注入过（`key === lastKey`）

**回合去重（关键取舍）**
`agent/pre-step` 的 payload 字段尚未实测。因此：
- 若 payload 有可用回合标识 → 用它去重（每回合一条）
- 若没有 → 退化为「仅当进入批次含 user 消息时注入」

两条路径都必须有单测覆盖。运行时另记录前若干次 payload 的**键名形状**（只记键，不记内容）
到 `logs/pre-step-shape.log`，以便拿到真实字段后收紧规则。

### 4.2 宿主接线（`lib/host.js`）

`apply(ctx)` 内注册，并**加守卫**：现有测试的假 ctx（`tests/migration.mjs:35`）只有
`logger/get/effect/inject`，没有 `on`，不守卫会直接打挂测试。

```js
if (typeof ctx.on === 'function') {
  let lastKey = null
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    recordPreStepShape(payload)              // 首次若干次，只记键名
    const plan = planInjection(readState(), payload, lastKey)
    if (!plan.inject) return decision
    if (decision && decision.kind === 'enter' && Array.isArray(decision.messages)) {
      lastKey = plan.key
      return { ...decision, messages: [...decision.messages, reminderMessage(plan.text)] }
    }
    return decision
  })
}
```

`reminderMessage(text)` 构造 user 角色消息，形状照抄 DSH 的做法：
`{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'agent-bridge', form: 'instructions', changes: [] } }`
（若宿主的消息构造函数不可用则退化为同样的普通对象；以实测为准。）

### 4.3 状态与面板

- `agent_mode` 状态新增 `remind`（boolean，默认 `true`）
- 关闭后**零注入**
- `client.js` 面板在能力开关下方加一行「自动提醒（建议型）」复选框

## 5. 验收标准

1. `auto: true` 时零注入
2. 能力全关时零注入
3. 每回合恰好一条，且只列开启的能力
4. `remind: false` 时零注入
5. 注入文本里的 `<`/`>` 被转义，无法闭合框架
6. 假 ctx（无 `on`）不报错，既有 15 个测试文件全绿
7. 真实 GUI 中提醒确实出现

## 6. 测试计划

| 文件 | 覆盖 |
|---|---|
| `tests/reminder.mjs`（新） | 五条不注入/注入规则、转义、两条去重路径 |
| `tests/host-harness.mjs`（改） | 假 ctx 提供 `on`，断言监听器注册且注入行为正确 |
| `client-render.mjs`（改） | 面板出现「自动提醒」开关 |

## 7. 风险

- **payload 字段未实测**：去重规则已按两条路径实现并测试，另记形状日志以便收紧。
  最坏情况是提醒重复出现或过少，不会阻断任何功能。
- **token 成本**：每回合约几十 token，可忽略。
- **噪音**：提醒只列开启的能力；全部关闭即静默。
