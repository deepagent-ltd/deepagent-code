<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>会记忆、会规划、会协作，也能把工作真正做完的 AI 编程智能体</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise 版本</a>
</p>

<p align="center"><sub>桌面版 1.4.2 · DeepAgent Core V4.0.4</sub></p>

---

DeepAgent Code 是一套面向长期工作的 AI 编程工作区。它把生产级编程智能体运行时与持久会话、相互连通的项目记忆、实时计划、代码智能、多智能体协作和人类监督组合在一起。

你可以让它完成一次小改动，在任务运行中继续补充指令，把一场迁移交给带客观完成判据的目标回路，或者召集多位专家共同审阅一项决策。DeepAgent 会让工作在多轮对话、进程重启、工具调用、团队成员和不同项目之间保持连贯。

## 一个工作区，三种协作方式

按任务选择最合适的协作方式：

| 模式 | 你提供 | DeepAgent 负责 |
|---|---|---|
| **自动（Auto）** | 一项需求 | 自行明确目标，按需设计和规划，再端到端执行 |
| **循环（Loop）** | 一个目标 | 生成可编辑的 `goal+plan.md`，按计划、执行、校验、迭代逐 tick 推进 |
| **设计（Design）** | 你编写的 `goal+plan.md` | 忠实执行你的设计，不重新定义目标或完成判据 |

自主程度和权限相互独立。你可以在不改变协作模式的情况下选择**只读**、**请求批准**或**完全访问**。

## 它在工作，你仍然掌控全局

DeepAgent 为持续协作而设计，不是一个发出指令后只能等待的黑盒。

- **实时 Steering：** 模型或工具仍在运行时继续发送指导。消息会先持久化，再在下一个安全的供应商轮次边界被吸收，不会中断在飞工作。
- **Goal Steering：** 发给活跃目标的指导会进入下一个 tick，同时保留当前工具状态和计划状态。
- **运行中计划热编辑：** 编辑正在运行或已暂停的目标。稳定的步骤 ID、证据、已完成工作和新计划版本会一起进入下一 tick。
- **显式排队：** 当一条指令应该在当前 activity 结束后独立开始时，把它放入未来队列，而不是改变当前工作。
- **暂停、恢复、接管或回滚：** 每个长跑流程都有清晰的人类控制路径和持久审计记录。

## 看得见、管得住的记忆

DeepAgent 不会把记忆藏在不可见的提示词里。项目状态保存在带类型、版本、来源、置信度、作用域、状态和链接的文档中。

- 会话私有工作上下文只属于当前对话。
- 项目共享事实与决策跟随代码仓库。
- 用户全局偏好可以跨项目使用。
- 内置技能与领域包保持系统级版本管理。
- 封存的评测材料仅用于审计，永不进入模型上下文。

学习遵循可治理的生命周期：证据生成候选，隔离审阅或人工决策改变候选状态，回归与消融门发布可复现的知识快照。拒绝理由会持久保存，因此被淘汰的模式不会在后台被悄悄重新学习。

**仓库与百科（Repo & Wiki）** 让这套系统对人可读。你可以浏览知识与执行档案、搜索整个仓库、沿文档到代码的链接探索上下文、检查来源链，并把有价值的运行证据升格为受治理知识。

## 相互连接的上下文，而不是更长的提示词

DeepAgent 把项目的四个视图连接在一起：

1. **代码图：** 文件、符号、导入、调用、诊断与引用。
2. **知识图：** 策略、方法论、事实、技能与故障档案。
3. **项目记忆：** 决策、约束、环境事实与已学习的项目约定。
4. **文档图：** 计划、设计、工作日志、评测、运行上下文与证据。

Session V2 运行器在持久 Context Epoch 下从明确的 Context Source 装配上下文。它在预算内选择相互关联的证据，记录每条引用为什么被准入或拒绝，并在压缩时保留当前目标、约束、决策、开放问题、后续步骤与相关文件。

长跑任务也能持续命中提示词缓存：稳定 system 指令保持字节级稳定，计划、Steering、预算、轮次结果等易变状态只追加到独立的尾部区块。

## 为困难工作而生

### AI IDE

按符号和意图查询代码，不再猜文件位置。DeepAgent 组合 LSP 定义、引用、调用链、类型信息、诊断、重命名预览与跨文件证据。未保存的编辑器 buffer 也会实时进入 LSP，因此分析看到的是你正在编辑的代码。

### 领域包

可组合的领域包提供语言、框架、平台、硬件、业务与风险知识，而不把专业逻辑硬编码进内核。领域包根据问题画像自动激活，以“更严格策略优先”解决冲突，并锁定快照以保证运行可复现。

### 专业子智能体与 Expert Panel

DeepAgent 可以把独立工作拆分给数量有界、相互隔离的 Worker。具备写权限的子智能体获得独立 worktree，只向父会话返回紧凑摘要和工件引用，完整执行记录仍可随时查看。

高风险决策可以召集 **Expert Panel**。正确性、安全、性能、架构与可复现性等专家视角审阅同一个冻结问题，进行最多三轮匿名辩论，再由确定性仲裁器生成裁定。少数派意见会被保留，无法安全达成一致时会失败关闭并交给人类。

### 团队与智能体消息

项目 IM 把团队成员和智能体放进同一条讨论。@ 某个智能体即可启动有明确作用域的运行，使用项目上下文、流式展示进度、关联执行工件，并把答案留在发起任务的对话里。

## DeepAgent Core V4.0.4

V4.0.4 在保持当前 turn 引擎稳定的前提下，关闭生产合同缺口：

- **单一持久真相：** DocumentStore 通过原子、可恢复写入统一管理文档、计划、学习候选、治理状态和版本冲突。
- **隔离子智能体：** 具备写权限的子智能体默认使用独立 worktree，并通过有界、可感知冲突的路径把改动回传到父工作区。
- **可靠事件投递：** Event Bus 提供可替换 transport、持久 consumer offset、离线补投、真实优先级排序和可观测队列深度。
- **受治理的学习与目标：** 知识晋升关联审阅证据与 ship-gate snapshot；事件驱动 goal tick 保持幂等并遵守 quiet hours。
- **安全集成：** MCP 凭据使用环境变量引用或 macOS、Linux、Windows 原生 secret storage；capability 与来源检查逐层失败关闭。
- **发布真实性：** 安装方式、CLI 示例、发布元数据、公开域名和支持版本文档与实际交付产品一致。

## 安装

> **说明：** `deepagent-code` npm 包尚未公开发布。
> 请通过桌面应用或下面的安装脚本安装。

```bash
# 安装脚本（macOS / Linux）
curl -fsSL https://deepagent.ltd/install | bash
```

然后运行：

```bash
deepagent-code
# 或使用别名：
deepagent
```

## 添加供应商

在运行任务之前，DeepAgent Code 至少需要一个模型供应商。它通过
[AI SDK](https://ai-sdk.dev/) 和 [models.dev](https://models.dev) 支持 75+ 家供应商，
以及任意 OpenAI 或 Anthropic 兼容的接口。按你习惯的方式选一种即可。

### 桌面应用（推荐）

打开 **设置 → 供应商（Settings → Providers）**：

- **官方供应商**（OpenAI、Anthropic、DeepSeek、Google、xAI、智谱/GLM）：点击
  **连接**，粘贴你的 API Key。
- **其他供应商或网关**：在「自定义供应商」上点击 **连接**，填入 **Base URL** 和
  **API Key**。DeepAgent Code 会自动探测协议（OpenAI 兼容或 Anthropic），并从接口的
  `/models` 列表自动发现可用模型——其余字段无需填写。

模型规格（上下文窗口、推理能力）会通过与 models.dev 目录按模型 id 匹配来自动补全。
你可以再次打开自定义供应商，覆盖某个模型的上下文/推理/温度；这些覆盖为尽力而为的默认值，
修改后不保证模型仍能正常使用。

### 终端

```bash
# 登录供应商（官方供应商，或插件鉴权流程）
deepagent auth login

# 查看已连接的供应商
deepagent auth list
```

### 配置文件

供应商也保存在 `~/.deepagent/code/config.jsonc` 中。一个自定义 OpenAI 兼容接口如下——
设 `discovery: true` 让模型在运行时从接口刷新，或在 `models` 下显式列出：

```jsonc
{
  "$schema": "https://deepagent-code.ai/config.json",
  "provider": {
    "myprovider": {
      "name": "My Provider",
      "npm": "@ai-sdk/openai-compatible",
      "discovery": true,
      "options": {
        "baseURL": "https://api.myprovider.com/v1",
        "apiKey": "sk-..."
      }
    }
  }
}
```

通过应用/CLI 添加的官方供应商密钥单独存放在 `~/.deepagent/code/auth.json`，不在配置文件里。
完整参考（Base URL 覆盖、请求头、逐模型配置、网关）见
[供应商文档](https://deepagent-code.ai/docs/providers/)。

## 快速示例

启动智能体并交给它一个任务：

```bash
deepagent-code run "为 /api/users 端点添加限流"
```

智能体将会：

1. 用 LSP 找到端点定义并理解其结构
2. 检查项目记忆中已有的中间件模式
3. 激活相关领域包（后端 API、项目所用语言）
4. 遵循项目约定实现限流
5. 运行测试、捕获诊断，并提出一条候选记忆："本项目使用 express-rate-limit 中间件"

下一次会话，当你要在别处添加限流时，智能体已经知道这套模式。

## 核心概念

**文档图** — 所有持久状态都存放在带类型的文档里：`knowledge`、`strategy`、`methodology`、`skill`、`memory`、`design`、`worklog`、`diagnosis`、`eval`。文档之间相互链接（支持/阻断/冲突/校验），构成一张可遍历的图。

**作用域分层** — `session-private`（当前对话）、`project-shared`（本项目所有会话）、`user-global`（跨项目偏好）、`public-system`（内置技能）、`sealed`（仅供审计，永不进入上下文）。

**上下文准入** — 检索命中要经过准入门。完整的工具输出（原始 LSP 转储、诊断、能力索引）被写入证据工件，带引用链接、仅工具可见；只有摘要与 `file:line` 片段进入模型上下文。敏感值（SSH 主机、令牌、内部路径）只被建议、绝不自动展开。

**AI IDE 微服务** — 按符号名与意图查询代码（例如 `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`），而非按 file:line 坐标。一次调用即可拿到定义、引用、调用链、类型层级与诊断。基于 LSP、支持 38 种语言服务器；当某文件类型未配置服务器时，优雅降级到 grep/read。

**预置 MCP 目录** — 面向 Git 平台、文件搜索、只读数据库与浏览器自动化的精选 MCP 服务器。风险等级在加载时由目录模板推导（不来自用户配置，因而无法被注入），服务器默认不连接，写操作与外部请求置于审批门之后。

## 架构

```text
┌─────────────────────────────────────────────────────────────┐
│  控制平面（DeepAgent 新增）                                  │
│  • 四图合一存储（代码 + 知识 + 记忆 + 文档）                 │
│  • 持续维护的工作状态（记忆 + 压缩）                         │
│  • 领域包系统（可组合、自动激活的知识）                     │
│  • 上下文装配与准入门                                       │
│  • 多智能体编排与对抗式审阅                                 │
│  • 受监督的目标回路与专家团（事件驱动）                     │
│  • 证据门控的学习 + 工作强度阶梯                            │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  运行时基座（来自 opencode）                                 │
│  • 智能体回路与工具执行                                     │
│  • 会话、分叉与供应商管理                                   │
│  • MCP 客户端运行时                                         │
│  • 权限系统                                                 │
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│  智能层                                                     │
│  • LSP 微服务（38 种语言服务器）                            │
│  • 预置 MCP 服务器（git/文件/数据库/浏览器）                │
│  • 领域适配器（校验与诊断）                                 │
│  • 诊断与校验回路                                           │
└─────────────────────────────────────────────────────────────┘
```

完整架构与不变量见 [架构与设计](design/README.md)。

## 从源码运行

DeepAgent Code 使用 Bun 1.3.14。

```bash
git clone https://github.com/deepagent-ltd/deepagent-code.git
cd deepagent-code
bun install
```

启动桌面应用：

```bash
bun run dev:desktop
```

启动终端界面：

```bash
bun run dev
```

执行一次性任务：

```bash
bun run --cwd packages/deepagent-code dev run "为 /api/users 添加限流"
```

导入已有 Codex 或 Claude Code 历史：

```bash
bun run --cwd packages/deepagent-code dev import-history --from codex --dry-run
```

## 文档

- [供应商与模型](https://deepagent-code.ai/docs/providers/)
- [架构与设计](design/README.md)
- [安全策略](SECURITY.md)
- [隐私策略](PRIVACY.md)
- [贡献指南](CONTRIBUTING.md)
- [更新日志](CHANGELOG.md)

## 许可与署名

DeepAgent Code 使用 **AGPL-3.0-or-later** 许可。如果你修改本项目并将其作为网络服务运行，必须向服务用户提供对应源代码。

DeepAgent Code 基于 [opencode](https://github.com/sst/opencode) 的 MIT 许可代码演进而来。上游署名见 [NOTICE](NOTICE)。本项目不暗示 opencode 或其贡献者的任何背书。

---

<p align="center"><sub>Built by DeepAgent</sub></p>
