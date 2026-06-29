### DeepAgent Code 是什么

DeepAgent Code 是一个以文档系统为中心的 AI Coding Agent。它保留 opencode 的 runtime、tool、MCP、session 和 provider 基础能力，在此之上加入 DeepAgent 控制面，用于文档记忆、上下文装配、检索闸门、学习生命周期和领域适配包。

核心设计很明确：文档系统是 agent 的持久本体。知识、策略、方法论、技能、记忆、诊断、决策、工作日志和上下文快照都是 typed document。上下文系统是带宽管理器，在每个 provider turn 只选择最小且最有用的文档切片进入上下文，并把新的证据写回文档图。

DeepAgent Code 不是重写 opencode。opencode 原有默认 loop 保留为 `general` 强度，DeepAgent 在这个 loop 之上增加更强的模式，而不是替换底层 runtime。

### DeepAgent 增强能力

- **Document System**：统一的 typed-document 图，承载 run state 和 durable knowledge，支持版本、来源、语义链接、快照、晋升门和可审阅证据。
- **Context System**：在安全 provider-turn 边界进行确定性上下文准入，包含 baseline system context、context epoch、context snapshot、有界工具输出和渐进披露。
- **工作强度模式**：`general`、`high`、`xhigh`、`max`、`ultra` 是严格递增的能力梯度，高强度只增加能力，不静默改变低强度合同。
- **场景模式**：`direct` 保留用户原始 prompt 直接执行；`wish` 会先生成并确认任务 prompt，再进入更强的自动化流程。
- **检索与防误导闸门**：durable knowledge 永远是 advisory，会经过 top-k、相关度、证据强度、冲突处理、snapshot lock 和回归门约束。
- **领域适配包**：领域包是 DocumentStore 视图加 detector、index、skill、validation、diagnosis 和 policy profile，不拥有独立 agent loop。
- **学习生命周期**：完成的工作可以沉淀候选记忆、技能、事实、失败档案、策略和方法论；能否晋升由证据、敏感度、审批状态和审阅策略决定。

### 工作强度

| 强度 | 合同 |
| --- | --- |
| `general` | 继承 opencode 能力，只带最轻量 DeepAgent 控制面 |
| `high` | 增加 DeepAgent 上下文控制、自动 micro-rounds、skills、validation、diagnostic 和项目上下文记忆 |
| `xhigh` | 增加 domain knowledge 和跨项目事实记忆 |
| `max` | 在检索闸门保护下增加 strategies 和 methodologies |
| `ultra` | 增加自动化 workspace 和宏轮自动执行；面向已确认的 `wish` 任务，并带更严格的进展、预算和人工升级门 |

### 模式与领域包

DeepAgent Code 把用户场景和 agent 强度分开：

- `direct` 保留原始 prompt 并立即执行。
- `wish` 先优化并确认任务 prompt，再运行确认后的 work package。
- `general`、`high`、`xhigh`、`max`、`ultra` 控制 DeepAgent 机制参与到什么程度。

领域包可以由 ProblemProfile 自动激活，也可以显式选择。领域包暴露 refs、摘要、skills、validation adapter、diagnosis signals 和 policy profile；最终哪些内容能进入模型上下文，由 context gate 和 retrieval gate 决定。
