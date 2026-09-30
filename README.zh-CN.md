# dsh-agent-bridge（中文说明）

[English](README.md) | **简体中文**

[![CI](https://github.com/mike-sl-ig/dsh-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mike-sl-ig/dsh-agent-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-agent-bridge.svg)](https://www.npmjs.com/package/dsh-agent-bridge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-agent-bridge.svg)](https://www.npmjs.com/package/dsh-agent-bridge)
[![license](https://img.shields.io/npm/l/dsh-agent-bridge.svg)](LICENSE)

把 **DeepSeek Harness** 接到你机器上**已经装好的**编码 agent CLI 上——OpenCode、Claude Code、Codex、Gemini，或者任何一个你写一份配方就能支持的 CLI——把它们当成独立工人来用：**跨模型交叉验证**、**廉价批量执行**、**第二意见**。

这个插件**不写死任何厂商**。一个 agent 就是一份 **JSON 配方（recipe）**：新增一个 agent、或者某个 CLI 改了参数，都是**改数据，不是改代码**。配方刻意做成纯数据，这正是它将来适合从社区注册表分发的原因——数据可以被审阅，代码不行。

---

## 它给你什么

- **会话标题栏右侧的一个按钮**：选默认 agent、开关三个角色功能、按 agent 选模型、看最近一次运行的报告卡。
- **四个工具**（模型可调用）：
  - `agent_list` —— 找到了哪些 agent、装在哪、什么**成本等级**、支持哪些能力；`probe: true` 会跑 `--version`，`selftest: true` 会**校验配方 + 回放真实录制样本**。
  - `agent_run` —— 把某个 agent 当独立工人跑一次，返回答案、会话 id、耗时、工具调用次数、tokens、成本与报告路径。
  - `agent_recipe` —— 给**陌生 CLI** 生成/校验/保存/导入配方：`draft`（跑一次并把候选字段连同证据交给你）、`validate`、`save`（写入本地配方目录，同名覆盖随包配方）、`import`（从 http(s) URL 拉取，**严格校验、绝不执行任何内容**）。
  - `agent_mode` —— 读写按钮上那份状态。
- **每次运行一份报告**：Markdown（提示词、答案、工具调用、tokens、成本、原始日志路径）+ 面板用的 `last-run.json`。
- **向后兼容**：旧的 `opencode_run` / `opencode_mode` 工具**仍然可用**，旧插件 `dsh-opencode-bridge` 的配置会**自动迁移**（旧文件保留，可回滚）。

## 安装

从 npm 安装：

```
dsh plugin --profile <你的档名> add dsh-agent-bridge
```

或直接从 Release 产物安装，不经过 npm：

```
dsh plugin --profile <你的档名> add https://github.com/mike-sl-ig/dsh-agent-bridge/releases/download/v0.1.1/dsh-agent-bridge-0.1.1.tgz
```

或从本地检出安装：

```
dsh plugin --profile <你的档名> add /绝对路径/dsh-agent-bridge
```

然后**刷新一下页面**（客户端插件要等页面重新加载客户端图之后才出现）。除了这个包本身，不会装任何东西：**零运行时依赖、无安装期脚本**。

## 四种模式（角色）

| 模式 | 会给工人加上什么 |
|---|---|
| `default` | 不加任何角色设定 |
| `verify` | 来自**另一个模型族**的独立验证者；**禁止调用工具**，单趟出答案 |
| `bulk` | 廉价机械工人；偏好直接作答，不做自检 |
| `second` | 独立第二意见；**禁止调用工具**，单趟出答案 |

> `verify` / `second` 禁止工具不是审美选择，是**实测结论**：放任调工具时，同一次任务出现 11 次工具调用、180 秒超时且**没有答案**；禁止后 0 次调用、8–10 秒给出正确答案。

## 配方长什么样

```json
{
  "id": "opencode",
  "label": "OpenCode",
  "cost": "free",
  "discover": {
    "bin": ["opencode", "opencode-cli"],
    "paths": { "linux": ["~/.opencode/bin/opencode"] },
    "derive": [{ "platforms": ["win32"], "append": "node_modules/…/claude.exe" }]
  },
  "run": { "argv": ["run", "--auto", "--format", "json"], "prompt": { "via": "positional" } },
  "output": { "format": "jsonl", "answer": { "where": { "type": "text" }, "pick": "part.text" } }
}
```

- `discover`：环境变量 → `PATH` → 已知安装路径 → **垫片反推真实入口**（npm 在 bin 里放的是 `.ps1`/`.cmd` 垫片，真正能直接 exec 的是包内的原生入口，推导出的入口**排在垫片之前**）；
- `run.prompt.via`：`positional`（追加到 argv 末尾）、`stdin`（写进子进程 stdin）、或某个 flag 名；
- `output`：`jsonl`（按事件累加）/ `json`（单个对象）/ `text`（兜底）；
- `caps`：声明这个 CLI 支持什么（模型、会话、续跑、附件…），面板据此决定显示哪些控件。

## 成本是真实的

`cost: "paid"` 的配方**会花你的钱**（实测 Claude Code 一次三个字的回答 $0.094）。面板会给它打上**付费**标记并在选中时提醒；测试里付费适配器也是**手动开启**（`LIVE_PAID=1`），默认不花钱。

## 质量与可验证性

- **11 套离线测试 / 223 项检查**：真实录制样本回放、win32·darwin·linux **三平台发现矩阵**、三种 prompt 传输、工具返回值的**「无损 JSON」契约**（这是 DSH 会整条拒绝工具调用的边界）、注册表导入的对抗性测试、打包/发布检查、客户端启动与渲染测试；
- **CI 在 ubuntu / macos / windows × node 20 / 22 上全绿**——跨平台不是声明，是实测；
- 真实环境验证：DSH web 档 + 无头浏览器（面板、自检、从 npm 与 Release 各装一次）**零控制台报错**；
- 零运行时依赖、无安装期生命周期钩子、`npm pack` 内容与 `files` 字段严格一致。

## 常见问题

**为什么不再依赖 PowerShell 脚本？**
启动走 `ctx.subprocess`（argv 向量，DSH 自己的执行世界），没有该服务时回退到 `node:child_process` + **真实文件描述符**。两者都不经过 shell，因此跨平台；也不再需要旧插件那个 `.ps1` 桥接脚本。

**我的 CLI 不在列表里怎么办？**
`agent_recipe` 的 `action: "draft"` 跑一次，它会把**草稿配方和它找到的每一个候选字段（连同证据）**一起交给你，你补上 id/label/cost 就能 `save`。

**它会不会自动运行我机器上的二进制？**
不会。**发现过程是只读的**（环境变量、PATH、已知路径、`--version`）。真正运行必须由模型的显式调用、或你在面板里明确选定的默认 agent 触发。

**配方从网上来安全吗？**
注册表导入只接受 JSON，且是**严格模式**：未知顶层键直接报错、超大/非 JSON 载荷在解析前就拒绝、每次导入记入 `_provenance.json` 可追溯，**载荷里的任何内容都不会被执行**——配方最终是被本插件自己的引擎读取的数据。

## 许可

MIT
