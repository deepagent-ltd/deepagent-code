# DeepAgent V3 人工验证测试文档

本文档面向**人工验证**。它列出需要在能运行 DeepAgent Code 应用的环境里手动验证的项目，因为这些项目依赖真实模型、真实编辑、真实 git 和浏览器 UI。

本文档中的测试数字只记录最近一次历史验证快照，不再作为当前通过结论。复跑时以当前终端输出和当前 git 工作树为准；如果输出不同，更新本文件或另写新的验证记录，不要沿用旧数字。

仓库根：`third-party module/deepagent-code`。运行时基于 **bun**。

---

## 0. 自动化验证命令（复跑确认）

这些是 DeepAgent V3 相关的单元/集成测试和类型检查入口。执行时以当前输出为准：

```bash
cd "third-party module/deepagent-code/packages/llm"
bun test
bun run typecheck

cd "../deepagent-code"
bun test test/deepagent/
bun run typecheck

cd "../app"
bun run typecheck
```

最近一次历史快照（仅供对照，不是当前事实）：

| 包                        | 命令                       | 历史结果                      |
| ------------------------- | -------------------------- | ----------------------------- |
| `packages/llm`            | `bun test`                 | 343 pass / 0 fail（39 files） |
| `packages/llm`            | `bun run typecheck`        | 通过                          |
| `packages/deepagent-code` | `bun test test/deepagent/` | 29 pass / 0 fail              |
| `packages/deepagent-code` | `bun run typecheck`        | 通过                          |
| `packages/app`            | `bun run typecheck`        | 通过                          |

覆盖的 V3 能力（自动化已证）：

- 防误导知识检索（强制 top-k、证据强度门、do_not_use、advisory）、**仅 promoted_at 可检索（F2 反污染）**
- 回归门 ablation、知识快照 ship-gate
- 多轮 loop 决策逻辑（diagnosis-before-retry、rollback-to-best、ensureSession F3）
- 文档图 DocumentStore（不变量/版本/双向链接）、run-graph、reviewer 投影
- 学习晋升门 R1/R2/R4 + rejected buffer + persistPromoted→可检索
- 领域包激活（GPU）、RUN_CONTEXT 工作记忆、prompt advisory、shell validation 执行器

> 历史注记：当时 deepagent-code **全量** `bun test` 有少量失败，审计判断与 DeepAgent V3 改动无关。该列表不是当前失败清单，复跑后必须重新判断：
>
> - TUI `attention.test.ts`：全量并发下 flaky（隔离跑 18/0 全绿）。
> - `session.llm-native.request` ×2：测试 `session/llm/request.ts`——该文件在本次会话**之前就已是未提交改动**（`git status` 为 M，非本人所改）。
> - `help-snapshots`：spawn CLI 二进制，环境性失败（F1–F5 之前就在失败）。
> - `httpapi-file > serves search endpoints`：文件搜索端点（独立 group，环境性）。
>
> 历史判据：当时 `git status` 可见工作树在该会话前已有大量未提交改动（request.ts / native-\* / provider.ts / sdk / core / 多个 app 文件）；该会话改动限于 deepagent/prompt.ts/server-deepagent/review.tsx，且定向测试通过。当前复跑时不要复用这个判据，必须重新看工作树和失败栈。

---

## 1. 前置：构建与启动 DeepAgent Code

```bash
cd "third-party module/deepagent-code"
bun install
# 按仓库 README 启动桌面/web 应用（app + server）。确认能打开 UI、能选 provider。
```

验收：应用能启动，能进入某个工作目录会话。

---

## 2. 模式语义：general / high / max（核心设计）

**目的**：验证 V3.1 的三级语义。`general` 是轻量 DeepAgent，`high` 是控制面增强，`max` 在 `high` 的基础上再开启 durable 知识检索。

| 步骤 | 操作                                                           | 期望                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | 用 `agent.mode=general` 跑一个普通编码请求                     | 走轻量 DeepAgent 路径：保留最小 runtime/audit 记录，不启用 durable 知识或多轮修复；不产生 `KNOWLEDGE_RETRIEVAL_RESULT.json` 这类知识产物                                                              |
| 2.2  | 切 `high` 跑同一请求                                           | 系统提示头部出现 DeepAgent Code high-mode 语义；run 目录产生控制面 artifacts；**不注入任何 durable 知识**（`KNOWLEDGE_RETRIEVAL_RESULT.json` 的 `enabled=false` 或无策略注入）                        |
| 2.3  | 切 `max` 跑一个 GPU/CUDA 相关请求（如"优化这个 sgemm kernel"） | `KNOWLEDGE_RETRIEVAL_RESULT.json` 出现策略/方法 refs，且带 `evidence_strength`、`do_not_use_refs`/`gap_analysis` 字段；`retrieval_policy.topk_by_kind` 存在；在多轮开关开启时可继续进入验证→诊断→修订 |

**怎么看**：DeepAgent run 目录在 `~/.deepagent/code/runs/`（或仓库配置的 runs 目录）下，每个 run 一个文件夹。

验收：三模式行为分层正确；`general` 轻量、`high` 控制面增强、`max` 再加知识检索；知识全部以"可选提示 + 证据强度 + 来源"呈现，无祈使步骤。

### 2.4 推荐组合

V3.1 把四类决策分开验证：情景模式（`direct/wish/design`）负责执行前准备，agent 强度（`general/high/max`）负责运行时深度，多轮 workflow 是执行策略，知识系统由 agent 强度和知识策略控制。

| 场景              | 推荐组合                              | 说明                                                   |
| ----------------- | ------------------------------------- | ------------------------------------------------------ |
| 普通快速任务      | `general` + `direct` 或 `wish` + 单轮 | 目标是低干预，允许最小审计，但不启动知识或多轮修复     |
| 需要先审阅再提交  | `wish` + `general` 或 `wish` + `high` | 先出草稿再确认；执行层是否要控制面增强，再看任务复杂度 |
| 结构化方案/大改动 | `design` + `high`                     | 先出草稿和风险/验收说明，再跑控制面增强的单轮任务      |
| 疑难任务          | `design` + `max`                      | 先结构化确认，再加知识检索；是否进入多轮由独立开关决定 |

验收：模型可以建议是否继续下一轮，但不能单独授权自动多轮；runner 必须根据开关、模式、验证结果、预算、轮次数和失败类型做最终裁决。

---

## 3. 反污染（F2，关键原则）

**目的**：验证未经人审的自学习候选**不会**被检索注入。

| 步骤 | 操作                                                                                  | 期望                                                                                             |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 3.1  | 用 max 模式连续完成几个任务（产生 learning 候选）                                     | runs 中出现 `LEARNING_WRITEBACK_MANIFEST.json`，候选 `promotion_decision` 为 staged/needs_review |
| 3.2  | 检查 memory 存储（`~/.deepagent/code/memory/.../memories.jsonl`、`strategies.jsonl`） | 候选条目存在，但**无 `promoted_at` 字段**                                                        |
| 3.3  | 再跑一个 max 任务，检查 `KNOWLEDGE_RETRIEVAL_RESULT.json`                             | 上述未晋升候选**不出现**在 `selected_refs`（只有 CORE/领域包 + 已人审晋升的才注入）              |

验收：staged（无 `promoted_at`）候选永不被检索注入——反污染门生效。
（晋升路径见 §7。）

---

## 4. 多轮自治 loop（A6 / F3，默认关闭）

**目的**：验证多轮 loop 真实驱动。它是执行策略开关，不是模式本身；默认 OFF，需显式开启。

> ⚠️ 这是动 session 主循环的功能，默认 `DEEPAGENT_MULTIROUND` 未设 → 行为与单轮一致（这是有意的 fail-closed 设计）。`general` 不进入多轮；只有 `high/max` 在开启后才允许进入验证→诊断→修订回路。

| 步骤 | 操作                                                                                                                                                              | 期望                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 4.1  | **不设**环境变量，max 模式跑任务                                                                                                                                  | 单轮完成，行为与之前一致（回归确认：开关关闭零影响）                                                                |
| 4.2  | 设 `DEEPAGENT_MULTIROUND=1` 重启，max 模式跑一个**带验证命令**的任务（仓库有 `package.json` typecheck/test，或 `AGENTS.md` 声明验证命令），故意让首次产出验证失败 | 系统**自动**跑验证命令 → 失败 → 注入一条诊断 follow-up → 模型再修一轮；最多 5 轮；全部失败则停止并保留最佳/干净状态 |
| 4.3  | 观察工作区 git 状态                                                                                                                                               | 失败轮不应把工作区留在破损状态（回滚到 best/clean）                                                                 |

验收：开启后 `high/max` 的多轮 loop 真实运行（验证→诊断→修订→回滚）；关闭时零影响，`general` 始终保持单轮。
（注：A5 真实 git checkpoint 已接入 live 路径——`prompt.ts` 经 `Snapshot.defaultLayer` 提供真实 `Snapshot.Service`，回滚为真实 git 级还原。见 §8。）

### 4.4 许愿/设计模式与多轮的配合

| 步骤  | 操作                                     | 期望                                                                                     |
| ----- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| 4.4.1 | 用 `wish + high` 提交任务并确认草稿      | 首轮执行使用确认后的 task prompt，后续多轮不得重新弹出 wish 确认                         |
| 4.4.2 | 用 `design + max` 提交复杂任务，开启多轮 | design 草稿、context plan、知识快照在确认后锁定；多轮诊断 follow-up 只围绕已确认目标修订 |
| 4.4.3 | 故意制造范围不清或风险越界               | runner 应停止并要求用户确认，而不是让模型自行扩大任务范围                                |

验收：情景模式只负责执行前准备；多轮 workflow 负责执行后的验证、诊断和修订。除非检测到范围变化、缺少用户决策或安全歧义，否则多轮不重新进入许愿/设计确认流。

---

## 4.5 AgentCode 软件经验提取验收

**目的**：验证 V3.1 吸收的 AgentCode 软件经验已经体现到产品行为中。

| 经验                 | 验收点                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 执行前准备           | `wish/design` 先生成草稿、上下文计划、假设和验收条件，确认后才进入主任务线程                                                     |
| 复用底层执行系统     | 工具、MCP、approval、provider auth、streaming、session 仍由继承 runtime 执行，DeepAgent 只加规划、审计、验证、复盘和学习控制面   |
| 用户目标不可静默改写 | Prompt refinement 只能结构化和澄清；不得悄悄改变用户核心目标                                                                     |
| 显式状态而非隐藏流程 | run state、router audit、work package、validation、checkpoint、learning、review artifacts 可在 run 目录和 review 页面检查        |
| 自主性有边界         | 多轮只有在策略允许、验证失败明确、预算允许、轮次未超限且可保持工作区可解释时继续                                                 |
| 知识受治理           | 自学习候选先 staged/needs_review；只有通过人审晋升的知识可被 `max` 检索                                                          |
| 失败 fail-closed     | disabled runtime、kill switch、provider-executed tool、checkpoint mismatch、cancel、预算耗尽等必须显式记录，不能静默走无审计路径 |

---

## 5. 文档图工作记忆（F5）

**目的**：验证每个 run 物化成文档图。

| 步骤 | 操作                                                           | 期望                                                                                                                         |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | 任意 high/max 跑一个 run 后，进入该 run 目录的 `graph/` 子目录 | 存在 `docs/<type>/*.json`：`run_state`、`run_context`、`candidate`、`decision`（失败时还有 `diagnosis`），文件名含版本 `@v1` |
| 5.2  | 打开 `decision` 文档                                           | `links` 含 `refines`→candidate；失败 run 的 decision 含 `triggered_by`→diagnosis                                             |
| 5.3  | 打开 candidate 文档                                            | 有内容寻址 `hash`（`sha256:...`）、`provenance`                                                                              |

验收：文档图按 docs/28 结构落盘（双向链接、版本、内容寻址）。

---

## 6. Reviewer UI（F4 / A7）

**目的**：验证复盘页面能读 run review。

| 步骤 | 操作                                                       | 期望                                                                                                                 |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 6.1  | 跑过几个 DeepAgent run 后，浏览器访问 `/<dir>/review` 路由 | 左侧列出最近的 run id                                                                                                |
| 6.2  | 点选一个 run                                               | 右侧显示：状态、候选谱系、诊断（若有）、"为何 accept/rollback" 的 decision 理由、可展开的 RUN_CONTEXT                |
| 6.3  | 直接调服务端点验证数据层                                   | `GET /deepagent/reviews`（带应用所需的 workspace 路由参数与鉴权）返回 `{reviews:[...]}`，每个含 candidates/diagnosis |

验收：reviewer 页面能由 run artifacts 投影出"为何接受/回滚"。
（注：页面已改用 SDK client `client.deepagent.reviews({ directory })` 取数，带应用的 workspace 路由参数，不再是 raw fetch。见 §8。）

---

## 7. 学习晋升门（人审 → durable，§3 的另一半）

**目的**：验证人审晋升后知识才可检索。

> review 页已接入 promote/reject 端点与按钮（`client.deepagent.knowledge.promote/reject`），人审晋升已有 UI；仍可用代码/脚本路径做受控晋升。

| 步骤 | 操作                                                                                                                                       | 期望                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 7.1  | 用代码/脚本调用晋升：对某个 staged 候选执行 `DeepAgentMemoryStore.promote(candidateId)`（或 `DeepAgentPromotion.persistPromoted(record)`） | 该候选 `memories/strategies.jsonl` 条目被加上 `promoted_at`           |
| 7.2  | 再跑 max 任务                                                                                                                              | 该已晋升知识现在**可**出现在 `selected_refs`（前提：过相关度+证据门） |
| 7.3  | 尝试晋升一个 `scope=sealed`（hidden）来源的候选                                                                                            | `promote(...)` 抛 R1 错误，拒绝晋升                                   |

验收：人审晋升后知识可用；sealed 永不可晋升（R1）。

---

## 8. 已知限制（设计层面、需你决策是否继续）

这些不是 bug，是当前实现的**边界**，列出供你知情。

> 历史更新（V3.1 复审）：原 §8 列的前三条已在后续提交修复，不再是限制，保留为历史记录：
>
> - ~~A5 git checkpoint 未接 live~~：`prompt.ts` 现已注入真实 `Snapshot.Service`，多轮 loop 的 `track/restore` 接到真实 git 实现（`src/snapshot/index.ts`）。
> - ~~Reviewer 页面 raw fetch~~：review 页已改用 SDK client（`client.deepagent.reviews()`），并新增 promote/reject 端点与 UI，人审晋升不再只是离线脚本。
> - ~~多轮 loop 默认 OFF~~：`multiRoundEnabled()` 现默认 ON（`DEEPAGENT_MULTIROUND` 仅在显式设为 `0`/`false` 时关闭）。

当前仍存在的边界：

1. **文档图是并行物化**：gateway 仍写扁平 artifacts（兼容现有），同时额外物化 `graph/`；尚未让文档图成为唯一真相源。
2. **V3.1 设计尚未实现**：scenario 模式 `design` 已移除；`wish` 第一轮仍是启发式 stub（未接模型）；结构化 round report、宏轮/wish 建议、`ultra` 强度、全局运行时（按强度而非 provider 激活）都还在 worklist 上（见 `docs/deepagent-v3-1-worklist.md`）。复跑本文件时以当前代码为准。

---

## 9. 回归确认（务必）

| 步骤 | 操作                                           | 期望                                                                             |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| 9.1  | general 模式正常使用一段时间                   | 保持轻量 DeepAgent 行为：最小 runtime/audit 记录正常，知识检索和多轮修复都不进入 |
| 9.2  | 不设 `DEEPAGENT_MULTIROUND`，high/max 正常使用 | 单轮行为正常，控制面 artifacts 正常产出，知识按模式生效，无卡死/异常             |

验收：DeepAgent 的所有新功能要么默认不改变既有行为（`general` 轻量、`high/max` 多轮关闭），要么只在对应模式下增强——**绝不拖累基线**。

---

## 附：本轮审计修复对照（F1–F5）

下表是历史修复快照，用于说明当时修了什么；自动化验证列不是当前测试状态。

| 项               | 修复                                                                     | 自动化验证                                  |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| F1 死代码        | 删除被取代的 `loop-driver.ts`                                            | llm 343 pass（39 files）                    |
| F2 反污染        | 检索只读 `promoted_at` 已晋升条目                                        | llm 测试绿（promotion 可检索、staged 不可） |
| F3 多轮 session  | `maybeRunRounds` 自己 `ensureSession`，不依赖被 gateway prune 的 session | deepagent-code deepagent 29 pass            |
| F4 reviewer 死链 | 加 `GET /deepagent/reviews` 端点 + 页面对齐                              | deepagent-code/app typecheck 干净           |
| F5 文档图未接线  | gateway run 完成时 best-effort 物化文档图到 `graph/`                     | llm typecheck 干净、测试绿                  |
