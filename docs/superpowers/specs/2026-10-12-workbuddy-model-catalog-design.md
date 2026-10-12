# dsh-agent-bridge 0.2.0 — WorkBuddy 接入 + 模型目录/免费付费/余额

日期：2026-10-12
状态：待评审

## 1. 目标

1. 把 **WorkBuddy**（腾讯 CodeBuddy Code 内核）作为一个可桥接的智能体加进插件。
2. 模型选择从「裸字符串下拉」升级为**带免费/付费标记的可视化选项**，opencode 与 WorkBuddy 共用同一套 UI 逻辑。
3. 显示各桥接智能体的**账户余额**（WorkBuddy 为积分），不同厂商计费逻辑不同 —— 余额来源必须由 recipe 声明，而不是写死在代码里。

## 2. 非目标（明确不做）

- **不调用任何写接口。** 具体地：`POST /v2/billing/meter/daily-checkin`（每日签到）不接。
  schema 里 `balance.write` 恒为 `null`，插件在数据结构层面就不具备调用写接口的能力。
  理由：账号资产变更 + 自动签到刷积分违反服务条款。要签到请用官方客户端。
- 不逆向桌面端的加密凭证（`keyblob` / `local_storage`）。凭证只从 CLI 自己的
  `~/.codebuddy/.credentials.json` 读取，用户显式 `codebuddy /login` 产生。
- 不改变 opencode / claude 两个现有 recipe 的任何行为。

## 3. 现状（已核实）

| 事实 | 依据 |
|---|---|
| `models` 被硬校验为 `string[]` | `lib/recipe.js:101` |
| `launch()` 只接受「可执行文件 + argv」 | `lib/launch.js:43` |
| 前端模型下拉是裸 `<select>`，只做 `m.replace(/^[^/]+\//,'')` 去前缀 | `lib/client.js:254-260` |
| WorkBuddy CLI 是 Node 脚本，非 exe | `<Install>\resources\app.asar.unpacked\cli\bin\codebuddy` |
| CLI 支持 `-p` / `--output-format json\|stream-json` / `--model` / `-c` / `-r` | `codebuddy --help`，v2.156.0 |
| 模型目录含 credits 元数据，49 条 | `product.json` → `models[]`，字段 `id/name/credits/vendor/tags` |
| `credits` 形如 `"x0.00 credits"`（免费）→ `"x2.00 credits"`（最贵） | 同上，`Hy3` = x0.00 |
| 余额端点存在（只读） | `app.asar` @76,683,964 |
| 签到状态端点存在（只读） | `app.asar` @82,133,226 |
| 签到端点存在（写，本设计不使用） | `app.asar` @82,133,912 |
| `/v2` 前缀来自桌面子类覆写 | `app.asar` @82,137,533 `get billingPrefix(){return\`/v2\`}` |
| 登录态探测：`GET /console/accounts`，401 不重试 | `app.asar` @76,559,790 / @76,679,565 |
| 本机 CLI **未登录**，无 `.credentials.json` | 实测 `Authentication required` |

## 4. 设计

### 4.1 recipe schema 扩展（全部可选，向后兼容）

```jsonc
{
  "models": [
    "opencode/mimo-v2.6-flash-free",                       // 旧格式仍合法
    { "id": "glm-5.2", "label": "GLM-5.2", "tier": "paid", "credits": "x0.79" }
  ],

  // 运行时模型目录：优先于静态 models
  "catalog": {
    "kind": "jsonFile",                 // jsonFile | argv | none
    "path": "%WORKBUDDY_CLI%\\..\\product.json",
    "pick": "models",
    "map": { "id": "id", "label": "name", "credits": "credits", "vendor": "vendor" },
    "excludeTags": ["text-to-image", "text-to-video", "image-to-video"],
    "ttlMs": 300000
  },

  // 余额：只读。write 恒为 null
  "balance": {
    "kind": "http",                     // http | argv | none
    "base": "https://www.workbuddy.cn",
    "loginProbe": { "method": "GET", "path": "/console/accounts", "pick": "data.accounts" },
    "summary": { "method": "POST", "path": "/v2/billing/meter/get-user-resource-summary", "body": {} },
    "map": { "id": "ResourceId", "label": "PackageName", "total": "total", "used": "used" },
    "unit": "积分",
    "write": null
  },

  // WorkBuddy CLI 是 .js，需要解释器
  "interpreter": { "source": "self" }
}
```

**tier 判定（纯函数，可测）**
- 有 `credits`：解析 `x(\d+(\.\d+)?)` → `0` 为 `free`，`>0` 为 `paid`
- 无 `credits`：回退到 id 规则（`-free` 后缀 → `free`），否则 `unknown`

### 4.2 新模块 `lib/catalog.js`

职责单一：把「某个 recipe 的模型目录和余额」变成一个稳定形状。**IO 与纯函数分离**，纯函数单独导出以便零依赖测试。

- `parseCredits(text) -> number | null`
- `classifyTier({ credits, id }) -> 'free' | 'paid' | 'unknown'`
- `normalizeCatalog(raw, catalogSpec) -> ModelInfo[]`，`ModelInfo = { id, label, tier, creditsText, vendor }`
- `readCatalog(recipe, ctx)`：按 `kind` 取数（jsonFile 读文件 / argv 跑命令），带 TTL 缓存，
  **失败一律降级到 recipe 的静态 `models`**，并把 `catalogError` 一并返回（前端可解释）。
- `normalizeBalance(raw, balanceSpec) -> { state, packages[], unit, at }`
- `readBalance(recipe, ctx)`：先 `loginProbe`，未登录直接返回
  `{ state: 'unauthenticated' }`，**不发起 summary 请求**。
  状态机：`ok | unauthenticated | unsupported | error`。

### 4.3 解释器支持（`lib/launch.js` + `host.js`）

`interpreter.source === 'self'` → 用 `process.execPath`（DSH 自身就是 Node），
spawn 变成 `[process.execPath, <cliPath>, ...args]`。
不新增 discover 配置，opencode 的原生 exe 路径完全不受影响。

### 4.4 WorkBuddy recipe `lib/recipes/workbuddy.json`

- `discover`：`env: ["WORKBUDDY_CLI","CODEBUDDY_CLI"]` + `paths.win32` 若干候选
  （本机 `D:\work Buddy\WorkBuddy\...`、`%LOCALAPPDATA%\Programs\WorkBuddy\...`、`%PROGRAMFILES%\WorkBuddy\...`）
- `interpreter`：`{ "source": "self" }`
- `run`：`["-p", "--output-format", "json"]`，prompt 走 positional，`model.flag=["--model"]`，
  `resume.flag=["-r"]`，`session.flag=["--session-id"]`
- `output`：`json`，按 CodeBuddy 返回结构映射 answer / session / usage
- `caps`：`model/session/resume` 为真，`files` 视 CLI 实际支持定
- `safety`：注明默认不加 `-y`，需要免确认时由 `autoApproveFlag` 声明

### 4.5 前端（`lib/client.js`）

- 模型下拉每项：`GLM-5.2 · 付费 x0.79` / `Hy3 · 免费`；免费绿徽章、付费黄徽章（复用 `s.badge`）
- 每个 agent 行加余额行：
  - `ok` → `积分 1,234`（多资源包时显示合计 + tooltip 明细）
  - `unauthenticated` → `未登录`，可点击展开授权指引
  - `unsupported` → 不显示（该 CLI 没有余额概念）
  - `error` → `余额获取失败`，可展开原因
- 保留现有「付费」警告徽章

### 4.6 契约与兼容

- 旧 recipe 零改动可用：`models` 为字符串数组时行为与 0.1.2 完全一致
- 新 key 进 `KNOWN_KEYS` 白名单，导入态（`strictKeys`）同样放行
- `agent_list` 返回的 `models` 字段由 `string[]` 变为对象数组 —— **这是破坏性变更**，
  因此 0.2.0 同时保留 `modelIds: string[]` 供老消费者使用

## 5. 验收标准

1. 全部现有测试通过（`node tests/*.mjs` 十一个文件）
2. GUI 面板出现 WorkBuddy；模型下拉列出过滤后的对话模型，**每条带免费/付费标记**
3. opencode 的 `-free` 模型同样显示「免费」
4. 未登录时余额显示「未登录」，点击给授权指引；**不显示假数字**
5. `codebuddy /login` 之后重开面板，余额显示真实资源包（合计 + 明细）
6. 全仓库不存在对 `daily-checkin` 或任何写方法的调用
7. `pack-check` 仍通过（无 BOM、包体内容完整）

## 6. 测试计划（TDD，先写用例）

| 文件 | 覆盖 |
|---|---|
| `tests/catalog-normalize.mjs`（新） | credits 解析、tier 判定、字段映射、排除标签、坏 JSON 降级 |
| `tests/catalog-io.mjs`（新） | jsonFile 读取、TTL 缓存、失败降级到静态 models |
| `tests/balance.mjs`（新） | 四态状态机、未登录短路、多资源包合计 |
| `tests/interpreter.mjs`（新） | `source:self` 的 argv 拼装 |
| `tests/recipe-wizard.mjs`（改） | 新 schema 校验 + 旧 recipe 兼容 |
| `tests/client-render.mjs`（改） | 徽章与余额行渲染（含四态） |

## 7. 风险与未决

- **余额尚未实测**：本机 CLI 未登录，结论全部来自静态代码证据。登录后需实测
  `/console/accounts` 与 summary 的真实返回，`map` 字段可能要按实测修正。
- `/v2` 前缀可能随部署形态变化（代码中另有不带前缀的调用点）。recipe 里保留
  `base` + 完整 path，便于用户本地覆盖。
- 余额端点属内部接口，可能无预告变更。因此 `balance` 全程可降级，
  失败只影响余额行，**绝不影响模型选择与运行**。
