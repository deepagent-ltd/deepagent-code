<p align="center">
  <picture>
    <source srcset="assets/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="assets/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="assets/logo-light.svg" alt="DeepAgent Code logo" width="520">
  </picture>
</p>

<p align="center"><strong>会记忆、会规划、会协作，也能把工作真正做完的 AI 编程智能体</strong></p>

<p align="center">DeepAgent Code <strong>2.0</strong>：持久化、崩溃可恢复的智能体内核，用更少的 token 完成真实工作</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="https://github.com/deepagent-ltd/deepagent-code-enterprise">Enterprise 版本</a>
</p>

---

DeepAgent Code 是一个面向长期任务的 AI 编程工作区。你可以让它改一个小地方，在任务运行中随时补充指令，把一场迁移交给带客观完成判据的目标回路，或者召集多位专家共同审阅一项决策——无论哪种，工作都会在多轮对话、进程重启、工具调用、团队成员和不同项目之间保持连贯。

## 它和其他编程智能体有什么区别

| 常见的编程智能体 | DeepAgent Code |
|---|---|
| 进程退出就忘掉一切 | **天然持久**：每条 prompt、每次工具调用、每个事件都先落盘再执行；崩溃重启后精确续跑 |
| 只理解当前 prompt 里的内容 | **记得你的项目**：你教过它的东西第二天还在，而且看得见、管得住 |
| 用大段 shell 叙述烧 token | **把 token 花在工作上**：结构化工具调用取代一遍遍转述的 shell 输出，输出 token 约为基线的三分之一（见下文） |
| 一次一个任务、单打独斗 | **规划并协作**：目标回路、独立 worktree、逐 SHA 审阅之后才合并 |
| 只能在一种环境、一个模型上运行 | **适配你的环境**：桌面或终端，75+ 模型供应商，用你自己的 API Key |

## 2.0 新特性：持久化内核

2.0 版本围绕一条原则重建了运行时：**先记录，再执行**。每条 prompt、每次工具调用、每个事件，都会在真正发生之前先写入本地持久日志。

- **持久会话。** prompt 在执行开始前先保存为持久记录。进程中途崩溃，会话从断点精确恢复；重试接起的是同一项工作，而不是悄悄另起一份。
- **事件溯源的历史。** 会话活动是一份只追加的事件日志，与它所描述的状态在同一事务中写入，回放、审计与恢复读到的永远是同一份事实。
- **持久化多智能体协作。** 委派工作本身就是一条持久记录：每个可写智能体在独立 git worktree 中工作，只提交自己作用域内的改动，并且要经过绑定精确提交的审阅才会合并。过期的 Worker 永远无法覆盖较新的工作。
- **写隔离。** 严格计划门默认开启：越出已批准计划的写入会被显式拒绝并报错，而不是静默落进你的代码树。
- **上下文保持精简。** 四张相互关联的项目图汇入同一个有预算约束的上下文窗口：稳定指令逐轮保持不变，易变状态只追加在末尾；已发送的历史逐字节稳定，只在跨过预算线时一次性批量收缩，让供应商的前缀缓存持续命中。

## 更少的 token，更少的步骤，更好的解决

在 DeepSWE 任务上，以相同模型对照 mini-swe-agent 基线：

- 输出 token 降至基线的约三分之一：结构化工具调用取代大段 shell 推理转述，而生成 token 恰恰是账单里最贵的部分。
- 较难的任务上修复通过率平均从 71.8% 提升到 98.4%。
- 平均步数少约 10%，端到端耗时与基线持平。
- 输入 token 总量更低：DeepSWE 上总输入约为基线的四到八成。旧工具输出按固定规则截断，既往思考不回放，提示词前缀逐字节稳定，实测前缀缓存命中率在 96% 以上。

## 一个工作区，三种协作方式

按任务选择最合适的协作方式：

| 模式 | 你提供 | DeepAgent 负责 |
|---|---|---|
| **自动（Auto）** | 一项需求 | 自行明确目标，按需设计和规划，再端到端执行 |
| **循环（Loop）** | 一个目标 | 生成可编辑的 `goal+plan.md`，按计划、执行、校验、迭代逐轮推进 |
| **设计（Design）** | 你编写的 `goal+plan.md` | 忠实执行你的设计，不重新定义目标或完成判据 |

自主程度和权限相互独立。你可以在不改变协作模式的情况下选择**只读**、**请求批准**或**完全访问**。

## 它在工作，你仍然掌控全局

DeepAgent 为持续协作而设计，不是一个发出指令后只能干等的黑盒。

- **实时引导（Live Steering）：** 模型或工具还在运行时，你可以继续发指令。消息先写入日志，再在模型调用之间的下一个安全时机并入，绝不中断正在执行的工作。
- **目标引导（Goal Steering）：** 发给活跃目标的指导会进入下一轮，同时保留当前工具和计划状态。
- **运行中计划热编辑：** 编辑正在运行或已暂停的目标。稳定的步骤 ID、证据、已完成工作和新计划版本会一起进入下一轮。
- **显式排队：** 当一条指令应该在当前任务结束后独立开始时，把它放入未来队列，而不是改变当前工作。
- **暂停、恢复、接管或回滚：** 每个长跑流程都有清晰的人类控制路径和持久审计记录。

## 看得见、管得住的记忆

DeepAgent 不会把记忆藏在不可见的提示词里。项目状态保存在带类型、版本、来源、置信度、作用域、状态和链接的文档中。

- 会话私有工作上下文只属于当前对话。
- 项目共享事实与决策跟随代码仓库。
- 用户全局偏好可以跨项目使用。
- 内置技能与领域包保持系统级版本管理。
- 封存的评测材料仅用于审计，永不进入模型上下文。

学习遵循可治理的生命周期：证据产生候选，隔离审阅或人工决策改变候选状态，回归与消融门禁发布可复现的知识快照。被拒绝的理由会持久保存，被淘汰的模式不会在后台悄悄复活。

**仓库与百科（Repo & Wiki）** 让这套系统对人可读。你可以浏览知识与执行档案、搜索整个仓库、沿文档到代码的链接探索上下文、检查来源链，并把有价值的运行证据升格为受治理知识。

## 相互连接的上下文，而不是更长的提示词

DeepAgent 把项目的四个视图连接在一起：

1. **代码图：** 文件、符号、导入、调用、诊断与引用。
2. **知识图：** 策略、方法论、事实、技能与故障档案。
3. **项目记忆：** 决策、约束、环境事实与已学习的项目约定。
4. **文档图：** 计划、设计、工作日志、评测、运行上下文与证据。

会话运行时只从明确记录的来源装配上下文：在预算内选择相互关联的证据，记录每条引用为什么被保留或舍弃，并在压缩时保留当前目标、约束、决策、开放问题、后续步骤与相关文件。

长跑任务也能持续命中提示词缓存：system 指令保持字节级不变，计划、引导、预算、轮次结果等易变状态只追加到独立的尾部区块。

## 为复杂任务而生

### AI IDE

按符号和意图查询代码，不再猜文件位置。DeepAgent 组合 LSP 定义、引用、调用链、类型信息、诊断、重命名预览与跨文件证据。未保存的编辑器 buffer 也会实时进入 LSP，因此分析看到的是你正在编辑的代码。

### 领域包

可组合的领域包提供语言、框架、平台、硬件、业务与风险知识，而不把专业逻辑硬编码进内核。领域包根据问题画像自动激活，以「更严格策略优先」解决冲突，并锁定快照以保证运行可复现。

### 专业子智能体与 Expert Panel

DeepAgent 可以把独立工作拆分给数量有界、相互隔离的 Worker。每次委派运行都是一条持久记录，记下它归属于谁、处于哪个阶段、结果如何、向哪个父任务回报，因此重试会恢复同一次运行，而不是静默再起一个重复的 Worker。具备写权限的子智能体获得独立 worktree，只向父会话返回紧凑摘要和工件引用，完整执行记录仍可随时查看。

自动写协作走一条持久 Git/PR 路径。Worker 只提交其作用域内的改动；一个 Reviewer Session 按精确 Worker SHA 逐项审阅，协调器在 Session 分支上串行执行 `--no-ff` merge，再由同一个 Senior Reviewer Session 审阅合并后的完整批次。恢复、超时、取消、接管、审阅反馈和清理都与工作版本绑定，过期的 Worker 无法敲定或覆盖较新的工作。

高风险决策可以召集 **Expert Panel**。正确性、安全、性能、架构与可复现性等专家视角审阅同一个冻结问题，进行最多三轮匿名辩论，再由确定性仲裁器生成裁定。少数派意见会被保留；无法安全达成一致时，交由人工裁决。

### 团队与智能体消息

项目内即时消息（IM）把团队成员和智能体拉进同一条讨论。@ 某个智能体即可启动一次有明确作用域的运行：它会带上项目上下文、流式展示进度、关联执行工件，并把答案留在发起任务的对话里。

## 安装

> **说明：** `deepagent-code` npm 包尚未公开发布。
> 请通过桌面应用或下面的安装脚本安装。

```bash
# 安装脚本（macOS / Linux）
curl -fsSL https://ai.deepagent.ltd/download/install | bash
```

然后运行：

```bash
deepagent-code
# 或使用别名：
deepagent
```

## 添加供应商

### DeepAgent API：官方平台（推荐）

DeepAgent Code 默认针对 DeepAgent API 调优。如需最契合的体验，请使用官方 **DeepAgent API 平台**
（[api.deepagent.ltd](https://api.deepagent.ltd)），为 DeepAgent 应用提供安全模型 API 的官方服务，
覆盖 GPT 与 DeepSeek 家族的 Chat Completions 与 Responses 协议，并提供 Anthropic 兼容端点。
在平台控制台获取 API Key，在 [Model Square 定价页](https://api.deepagent.ltd/pricing)查看套餐价格，
然后打开 **设置 → 供应商 → DeepAgent → 连接**，粘贴 Key 即可开始。

### 其他任何供应商

DeepAgent Code 不绑定供应商。它通过
[AI SDK](https://ai-sdk.dev/) 和 models.dev 支持 75+ 家供应商，
以及任意 OpenAI 或 Anthropic 兼容的接口。

### 桌面应用（推荐）

打开 **设置 → 供应商（Settings → Providers）**：

- **官方供应商**（DeepAgent、OpenAI、Anthropic、DeepSeek、Google、xAI、智谱/GLM）：点击
  **连接**，粘贴你的 API Key。
- **其他供应商或网关**：在「自定义供应商」上点击 **连接**，填入 **Base URL** 和
  **API Key**。DeepAgent Code 按供应商 SDK 包判定 API 协议族（OpenAI 兼容或 Anthropic），并从接口的
  `/models` 列表自动发现可用模型，其余字段无需填写。

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

供应商也保存在 `~/.deepagent/code/config.jsonc` 中。一个自定义 OpenAI 兼容接口的配置如下：
设 `discovery: true` 让模型列表在运行时从接口刷新，或在 `models` 下显式列出：

```jsonc
{
  "$schema": "https://ai.deepagent.ltd/config.schema.json",
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
[DeepAgent API 平台文档](https://api.deepagent.ltd/)；支持的模型与套餐见
[Model Square 定价](https://api.deepagent.ltd/pricing)。

DeepAgent Code 的所有私有文件数据都位于 `~/.deepagent/code/`，包括配置、凭据引用、数据库、桌面状态、日志、缓存和临时文件；原生 secret 值仍由操作系统凭据存储保管。测试使用显式隔离的独立目录；即使通过环境变量也无法重定向生产数据的存储位置。

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
5. 运行测试、捕获诊断，并提出一条候选记忆：「本项目使用 express-rate-limit 中间件」

下一次会话，当你要在别处添加限流时，智能体已经知道这套模式。

## 工作原理（技术内幕）

**持久会话内核**：prompt 先成为持久记录，再由单一串行执行器在安全点转为可见消息。Steering 消息并入正在运行的任务，排队指令在其结束后逐个开启，中断精确命中真正在运行的那份工作。

**事件图**：会话活动、任务运行与证据全部事件溯源化，与它们所描述的状态在同一事务中写入，回放与恢复始终和事实一致。

**文档图**：所有持久状态都存放在带类型的文档里：`knowledge`、`strategy`、`methodology`、`skill`、`memory`、`design`、`worklog`、`diagnosis`、`eval`。文档之间相互链接（支持/阻断/冲突/校验），构成一张可遍历的图。

**作用域分层**：`session-private`（当前对话）、`project-shared`（本项目所有会话）、`user-global`（跨项目偏好）、`public-system`（内置技能）、`sealed`（仅供审计，永不进入上下文）。

**上下文准入**：检索命中要经过准入门。完整的工具输出（原始 LSP 转储、诊断、能力索引）被写入证据工件，带引用链接、仅工具可见；只有摘要与 `file:line` 片段进入模型上下文。对于敏感值（SSH 主机、令牌、内部路径），智能体只会指出位置，绝不把原始值贴进上下文。

**AI IDE 微服务**：按符号名与意图查询代码（例如 `code_intel({ symbol: "AgentGateway.open", intent: "overview" })`），而非按 file:line 坐标。一次调用即可拿到定义、引用、调用链、类型层级与诊断。基于 LSP，支持 38+ 种语言服务器；没有配置语言服务器的文件类型会自动回退到 grep/read。

**预置 MCP 目录**：面向 Git 平台、文件搜索、只读数据库与浏览器自动化的精选 MCP 服务器。风险等级在加载时由目录模板推导（不来自用户配置，因而无法被注入），服务器默认不连接，写操作与外部请求置于审批门之后。

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

- [DeepAgent API 平台](https://api.deepagent.ltd/) · [Model Square 定价](https://api.deepagent.ltd/pricing)
- [架构与设计](design/README.md)
- [真实 LLM 测试指南](design/real-llm-testing.md)
- [安全策略](SECURITY.md)
- [隐私策略](PRIVACY.md)
- [贡献指南](CONTRIBUTING.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [更新日志](CHANGELOG.md)

## 许可与署名

DeepAgent Code 使用 **AGPL-3.0-or-later** 许可。如果你修改本项目并将其作为网络服务运行，必须向服务用户提供对应源代码。

DeepAgent Code 基于 [opencode](https://github.com/sst/opencode) 的 MIT 许可代码演进而来。上游署名见 [NOTICE](NOTICE)。本项目不暗示 opencode 或其贡献者的任何背书。

---

<p align="center"><sub>Built by DeepAgent</sub></p>
