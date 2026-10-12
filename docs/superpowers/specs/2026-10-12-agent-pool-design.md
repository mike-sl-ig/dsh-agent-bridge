# 候选池（agent pool）— 设计

日期：2026-10-12
状态：已批准

## 1. 问题

面板用**单选 radio** 选一个「默认 agent」，而这三个能力（verify/bulk/second）本质上是
**跨模型**的：交叉验证要挑不同模型家族，第二意见要换个脑子。单选把用户锁在「一次只接一个
agent」的心智里。

用户原话：「之前是可以同时接很多 agent 的，现在怎么只能同时接一个了」+
「1 和 2 我都想要，任务调用的时候具体调用哪个或者哪几个主 agent 自己判断」。

**注意**：单选不是 0.2.0/0.3.0 引入的回归 —— `type: 'radio'` 与 `0.1.2`（`e37544b`）逐字相同。
这是一直以来的设计，现在要改的是设计本身。

## 2. 目标

1. 面板从「选一个默认」改为「勾选一组候选」。
2. 每个被勾选的 agent 都能各自配置模型（现在只有选中的那个显示下拉）。
3. 提醒列出**整个池**，并明确「用哪个、用几个由主 agent 判断」。
4. 旧的单选状态**无损迁移**，不丢用户配置。

## 3. 非目标

- 不改 `agent_run` 的调用契约：它依然一次调一个 agent。并行/多轮由主 agent 自行编排。
- 不引入主/副之分。池里第一个已安装的即默认。

## 4. 设计

### 4.1 状态

```jsonc
{
  "auto": true,
  "pool": ["opencode", "workbuddy"],   // 新增：候选集合，顺序即优先级
  "defaultAgent": "opencode",          // 保留，但改为「派生 = pool[0]」
  "defaultMode": "default",
  "enabled": { "verify": false, "bulk": false, "second": false },
  "agents": { "opencode": { "model": "opencode/mimo-v2.6-flash-free" } },
  "remind": true
}
```

**迁移规则（`coerceState`）**
- 有 `pool` → 取其中非空字符串
- 无 `pool` 但有 `defaultAgent` → `pool = [defaultAgent]`（0.3.x 状态无损）
- 有 `pool` 且为空但有 `defaultAgent` → 同上
- 最后**总是** `defaultAgent = pool[0] || ''`

`defaultAgent` 保留在状态里是刻意的：0.3.x 的消费者（`agent_mode` 的旧参数、路由的
`defaultAgent=` 查询串）继续可用，只是语义变成「池里的第一个」。

### 4.2 解析默认目标（`resolveTarget`）

不点名时：**池里第一个已安装的** → 退化为任一已安装的 → 退化为第一个 recipe。
与今天的行为差别只在「按池顺序而不是单个 defaultAgent 找」。

### 4.3 提醒文案

```
<system-reminder>
Agent 桥接（建议型）：已开启 跨模型交叉验证。
候选 agent：opencode (opencode/mimo-v2.6-flash-free) / workbuddy / claude。
当任务适合时，可先用 agent_run(mode="verify") 调用其中任意一个或多个；
用哪个、用几个由你判断。未开启的能力不要调用。
</system-reminder>
```

- 池里每个 agent 带自己的模型（未配置模型则只有名字）
- 池为空时退回旧行为（只点名 `defaultAgent`）
- 文本照旧转义 `<` `>`（recipe id / 模型名是外部数据）

### 4.4 面板

- radio → **checkbox**：勾选即加入池
- 模型下拉的渲染条件从 `selected` 改为 `pool.includes(agent.id)` —— 每个勾选的 agent 都有
- 未安装的 agent 仍不可勾选
- `put` 的查询串新增 `pool=<id>,<id>`

### 4.5 `agent_mode`

新增 `pool`（字符串数组）。`defaultAgent` 保留为「把池设成这一个」的简写，
两者同时给出时 `pool` 优先。

## 5. 验收标准

1. 勾选两个 agent 后，**两个**都显示各自的模型下拉
2. 提醒里出现**两个**候选及其模型，且含「用哪个、用几个由你判断」
3. `auto: true` 时照旧零注入；`remind: false` 时零注入
4. 池为空时提醒退回旧文案（不出现「候选 agent：」）
5. 0.3.x 的状态文件读入后 `pool` = 原来的 `defaultAgent`，不丢配置
6. `agent_mode` 不传 `agent` 时，`agent_run` 用池里第一个**已安装**的
7. 全量测试通过（含既有 17 个文件）

## 6. 测试计划

| 文件 | 覆盖 |
|---|---|
| `tests/migration.mjs`（改） | `pool` 派生、旧状态迁移、`defaultAgent` 兼容 |
| `tests/reminder.mjs`（改） | 多候选文案、空池回退、转义、原有不注入规则 |
| `tests/host-harness.mjs`（改） | 池顺序解析、HTTP 路由 `pool=` 往返 |
| `tests/client-render.mjs`（改） | 多选、每个勾选项显示下拉 |
| `package.json` / `CHANGELOG.md` / `README*.md` | 0.4.0 |

## 7. 风险

- **行为变化**：verify 可能不再用用户原本的「主 agent」。这是特性（跨模型），但必须在
  CHANGELOG 里写明。
- 池里勾了未安装的 agent：解析时跳过，提醒里照常列出（用户能看到自己勾了什么）。
