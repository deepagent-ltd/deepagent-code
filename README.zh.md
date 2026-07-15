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

<p align="center"><sub>桌面版 1.4.0 · DeepAgent Core V4.1</sub></p>

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

## DeepAgent Core V4.1

V4.1 把完整的 DeepAgent 控制平面汇聚在一起：

- **持久 Session V2：** prompt 先持久准入、再调度执行；精确重试不会复制用户意图；同一 Session 的唤醒会安全合并。
- **统一供应商轮次合同：** native 与 AI SDK provider 共享预算、权限、工件、审计、学习和关闭生命周期。
- **单一持久真相：** DocumentStore 通过原子、可恢复写入统一管理文档、计划、学习候选、治理状态和版本冲突。
- **事件驱动 Agent OS：** 持久事件、优先级路由、回压、Worker claim、租约、handoff、重试、死信恢复与分布式 placement 协调自主工作。
- **消费者驱动 Goal：** `goal.tick.requested` 每次认领并执行一个幂等 tick，记录事实，并只在持久目标仍满足条件时调度下一 tick。
- **人类监督：** 审批队列、全链路 trace、接管、回滚、Wiki 档案、通知，以及组织和 workspace 隔离始终位于执行路径上。
- **安全集成：** MCP 凭据使用环境变量引用或原生操作系统 secret storage；目录风险、运行时权限、可信来源和工具 capability 逐层失败关闭。

## 架构

```text
Desktop / Web / TUI / IM
          |
          v
Session V2 + System Context + Steering
          |
          v
DeepAgent 控制平面
  - Plan 与 Goal controller
  - Context 与图查询
  - 学习与治理
  - Event Router 与 Worker Pool
          |
          v
持久 DocumentStore + Event Bus + Audit
          |
          v
Provider / Tool / LSP / MCP / Git runtime
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
