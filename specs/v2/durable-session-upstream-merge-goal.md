# Goal + Plan：迁移上游 Durable Session 基建

状态：**实施中。** S0、S1 已完成；S2-S6 仍是显式工作包，不能把本文件理解为“上游 V2 已全部合入”。

## 目标

从本地 OpenCode 上游按能力迁移最小、可验证的 Durable Session V2 基建，不批量复制 UI、产品特性或 legacy 应用行为，并为 subagent/Goal 控制面提供稳定执行底座。

迁移必须优先复用本仓库已有的 durable admission、EventV2、Location 和 System Context 能力。文件名相同不代表可以覆盖；只有语义缺口明确、依赖边界闭合且测试可移植的能力才进入实施计划。

本计划不把 Goal 从 legacy prompt loop 切到目标控制面，也不启用 hard-crash 后的 provider/tool 自动重放。

## 基线

- 上游仓库：`/Users/xiuranli/code/deepagent-ai/opencode`
- 上游 `dev`：`1882c33827cf0ce5c948b69ab5a87ed8f6790cf8`
- 上游 `v2`：`3f30203b72412ba7b324e86cb2ebbf6208d152ac`
- 两个上游 ref 的 merge base：`0e2dd4ad150d0182fc9e43d81424d8db11465977`
- 目标基线：`dev@ee1d325cfb04ded09ee0b7cb3307ea9bc25eeea2`
- 目标分支：`codex/merge-upstream-durable`
- 已完成提交：`2fba253b56cba9dc7a78a43de83d80fcfb090645`

`origin/dev` 和 `origin/v2` 已长期分叉，互相都不是祖先。最新 `dev` 有 2026-06 版本的 Session V2 service、`session_input`、EventV2、runner 和 server route wiring，但没有 `time_suspended`、`SessionRestart`、`awaitIdle`、execution lifecycle，也没有 2026-07 后 `v2` 的 pending、compaction、retry 和 tool-settlement 演进。因此不能用“最新 dev”替代对 `origin/v2` 的能力审计。

Git ancestry 与目标仓库已经切割。迁移按能力和测试适配，不保留上游 commit ancestry。

## 目标仓库已经具备的能力

以下能力继续作为权威，不重写、不改名：

- caller-supplied Session ID；
- caller-supplied prompt message ID 和 exact-retry conflict reconciliation；
- durable `session_input` admission、projection 和 `admitted_seq`；
- `steer`、`queue` 和 DeepAgent 专用 `goal_steer` delivery；
- per-Session synchronized EventV2 aggregate sequence；
- process-global、Session-ID-based execution routing；
- Location-scoped runner、model、tool registry、permission 和 filesystem；
- durable assistant/provider/tool events，以及 stale tool 的保守 settlement；
- Session-owned System Context、History selection 和 Context Epoch；
- context federation、Goal steering 和本仓库已有的 outbox/consumer 扩展。
- assistant text/reasoning/tool content 的 provider metadata 持久化与 same-model continuation projection。

## 最近两周分支筛选

审计窗口为 2026-07-20 至 2026-08-03。除 `origin/dev` 和 `origin/v2` 外，逐项检查了所有在该窗口修改 `packages/core/src/session`、Session migration 或 managed process wiring 的远端分支。下表只列出可能影响 Durable Session substrate 的候选；UI、catalog、browser、archive、title 和普通 provider feature 已按非目标排除。

| 分支/提交 | 发现 | 决策 |
| --- | --- | --- |
| `origin/renamed-tool-execution@4086aa8079` | 修复 context hook 重命名 tool 后“对 model 可见但无法回到原 registry capability 执行”的 provenance 丢失 | **纳入 S3。** DeepAgent request preparation 必须冻结 advertised name 到 registered capability 的映射，并在 wake 前测试 permission/capability 不可伪造 |
| `origin/undo-pending-input@d7ffc7fec1` | 优化 pending-only history/event 查询，并让 withdrawal 与 promotion 复用删除原语；其核心假设是 promoted row 已从 `session_pending` 删除 | **不直接迁移。** 目标保留 promoted `session_input`；只吸收 exact retry、withdraw/promotion race 和 conflict fixture 到 S4 |
| `origin/text-phase-state@ce1203ce83` | 把 assistant text provider state 持久化，并在 same-model continuation 恢复 | **目标已有等价能力。** `AssistantText.providerMetadata`、EventV2 text projection 和 `to-llm-message` 已覆盖；保留 continuation regression，不复制 schema |
| `origin/bound-tool-output@aa1f91e0d0/f7a72fdf32/98be51b74c` | 补齐 tool output store、bounded receipt 和 structured-output 边界 | **按不变量审计 S2。** 迁移 durable first-terminal/bounded-receipt fixture；不批量复制该分支的 tool registry/output-store 架构 |
| `origin/tui-inbox-tabs@094dac1541` | 把 Session activity 投影到 ancestors，主要服务 inbox/recency UI | **排除。** 不是 execution ownership、activity fence 或 Goal recovery evidence |
| `origin/prompt-cache-key@a214ac39de`、`origin/codex-input-limit@b1a61aaf55`、`origin/cache-diagnostics@34ed5bb399` | request sizing/cache diagnostics | **排除本次迁移。** 可独立产品化，不属于 durable control-plane 最小底座 |
| `origin/gpt56-stream-fix@917d18203a`、`origin/session-http-middleware@1eec3e640a` | 最新更新分别处理认证刷新和 plugin HTTP hook | **排除。** 不改变 durable admission、settlement、restart 或 recovery contract |

没有发现任何最近分支实现 Session activity claim/fence、provider dispatch exactly-once proof 或 tool external-status reconciliation。因此 hard-crash recovery 仍是 S6 的本地设计工作，不能从“存在更新分支”推导上游已经支持。

## 上游证据索引

| 能力 | 固定证据路径 |
| --- | --- |
| Pending algebra/exact retry | `packages/core/src/session/pending.ts`、`packages/core/src/database/migration/20260709190621_session_pending_table.ts` |
| Compaction barrier | `packages/core/src/session/pending.ts`、`packages/core/src/session/compaction.ts`、`packages/core/src/session/runner/llm.ts` |
| Execution lifecycle/restart | `packages/core/src/session/execution.ts`、`packages/core/src/session/execution/restart.ts`、`packages/core/src/session/store.ts`、`packages/server/src/process.ts` |
| Provider retry | `packages/core/src/session/runner/retry.ts`、`packages/core/src/session/runner/llm.ts` |
| Request/tool capability snapshot | `packages/core/src/session/model-request.ts`；补充候选 `origin/renamed-tool-execution@4086aa8079` |
| Tool fiber/settlement | `packages/core/src/session/runner/llm.ts`、`packages/core/src/session/runner/publish-llm-event.ts` |
| Instruction delta/context | `packages/core/src/session/instruction-state.ts`、`packages/core/src/session/instructions.ts`、`packages/core/src/session/context.ts` |
| Replay watermark | `packages/core/src/bus.ts` |
| Fork cutoff | `packages/core/src/database/migration/20260729022634_session_fork_boundary.ts`、`packages/core/src/session/history.ts` |
| Hard-crash recovery absence | 两个固定 ref 中没有 activity claim/fence 或 external tool status contract；唯一 restart proof 是 `time_suspended` 的 graceful one-shot consume |

## 上游能力审计与迁移决策

| 能力 | 上游 `v2` 行为 | 目标现状 | 决策 | 进入门禁 |
| --- | --- | --- | --- | --- |
| Generalized pending algebra | `session_pending` 只保存未 promotion 的 `user`、`synthetic`、`compaction`，promotion 后删除；exact retry 从 history + admitted event 重建 | `session_input` 保留 admitted/promoted row，额外支持 `goal_steer`，控制面需要稳定 `admitted_seq` binding | **适配语义，不改表名、不直接复制 migration。** 后续扩展 typed input kind；继续保留历史 row 和 internal sequence | S4 |
| Durable compaction barrier | Manual compaction 作为唯一 pending barrier，阻止后续 input promotion，成功或失败后原子消费 | 已有自动/overflow compaction 和 durable compaction events，但 manual compact 仍 unavailable，没有 pending barrier | **迁移。** 在现有 `session_input` algebra 上实现 coalesced typed barrier；不得引入第二个 inbox authority | S4 |
| Execution lifecycle | 每个 local busy period 发布 started 和一个 terminal observation；提供 `active`、`awaitIdle` | 原目标缺失 | **已适配合入。** EventV2 lifecycle 是观察，不是 distributed ownership claim | S1，完成 |
| Graceful restart | `time_suspended` + atomic consume；managed shutdown 标记 active Session，startup 并发 resume | 原目标缺失 | **core 已合入，host 未启用。** 只表示 orderly suspension，不是 live status 或 crash fence | S1 完成；S5 激活 |
| Narrow provider retry | 只在 durable assistant/tool evidence 之前重试 typed rate-limit/internal/transport failure；复用 logical step/message ID，并发布 retry schedule | 当前 V2 runner 没有等价的 typed、observable retry boundary | **适配迁移。** Session physical retry 与 task `task_attempt` retry 必须分层，不能同时包裹同一失败 | S3 |
| Model-request preparation | Location-scoped `prepare` 固定 model、request、tool snapshot、hook outcome 和 execution capability，`llm.stream` 仍由 runner 调用一次；side branch 另修复 renamed-tool provenance | request assembly 位于 runner，DeepAgent system prompt/context 路径不同 | **迁移边界，不复制实现。** 建立 DeepAgent-compatible prepare/dispatch seam，并冻结 advertised-to-registered tool mapping，为 activity evidence 和 tool capability fencing 提供单一入口 | S3 |
| Tool settlement hardening | eager local tools；先 join 所有 owned fibers，再串行 terminal settlement；typed decline；hosted/local missing result 分开；malformed input 保守收敛；side branch 补 bounded receipt/structured output 边界 | 已有 durable tool events、并发 local tools、hosted missing-result 和 stale-tool settlement，但 fiber join、typed decline、first-terminal/bounded-receipt preservation 尚未逐项对齐 | **优先适配。** 移植不变量和 kill-point fixtures，不批量迁移 tool architecture/output store | S2 |
| Instruction value-delta sync | 上游使用 `instruction_state`/blob/value delta 和 fork cutoff | DeepAgent 已有更强的 System Context algebra、registry、Context Source、Context Epoch 和 federation | **拒绝直接迁移。** 仅复用 observation-before-promotion、epoch/fork cutoff 不变量 | 保持现状 |
| Bus/session log watermark | 上游 `Bus` 提供 aggregate replay、synced watermark 和 live follow | DeepAgent EventV2 已有 durable aggregate/outbox/consumer ownership语义 | **不替换 EventV2。** 只有外部 replay API 需要 watermark 时再单独设计 adapter | 暂缓 |
| Explicit fork boundary | 上游持久化 parent boundary 和 instruction cutoff | 控制面已把 context mode 与 delivery mode 拆分，但 child context fork 尚未迁移到 V2 boundary | **按能力适配。** 作为 context-fork adapter，不与 retry 或 background mode混合 | W4/S4 后 |
| Title/generate/archive/remove/UI/tool consolidation | 产品 API、展示或大范围工具架构迁移 | 非 Durable Goal 最小底座 | **排除。** 不因文件邻接被带入 | 非目标 |
| Hard-crash activity recovery | 上游明确不支持 exactly-once provider/tool recovery | 目标同样缺少 activity claim、dispatch evidence、tool idempotency proof | **必须自行设计实现。** 不存在可复制的上游实现 | S6/W6B/G2 |

## 关键架构结论

### 保留 `session_input`

不把目标表改名为 `session_pending`。上游 pending-only projection 的优点是公开 pending API 简洁，但 DeepAgent 控制面需要 durable child input binding、`admitted_seq`、`goal_steer` 和历史 exact-retry evidence。S4 只借用 typed input algebra 与 compaction barrier，不删除 promoted row，也不暴露 admission sequence 给普通 public API。

### 两层 retry 必须分离

1. Session physical retry：同一个 logical step 内的 provider physical attempt，只允许 typed transient failure 且尚无 durable assistant/tool evidence；不创建 `task_attempt`。
2. Control-plane retry：Session execution 已停止后，在相同 logical run 下创建新的 `task_attempt`；只有 Session evidence 证明没有 ambiguous dispatch/side effect 时才允许。
3. Overflow compaction rebuild：仍属于同一 logical step，但产生新的 physical provider attempt；必须有独立 identity 和 evidence。

任何 failure 最多由一层 retry owner 消费。Session 已安排 physical retry 时，task coordinator 不得同时创建 attempt；task attempt retry 也不能清空或重放 Session retry history。

### `SessionRestart` 不能直接恢复 control-plane child

上游 managed host 的直接 `resumeSuspendedSessions` 只恢复 Session drain，不会恢复 task/Goal attempt lease、finalizer、worktree、result settlement 或 Goal checkpoint。对 control-plane-owned child 直接 resume 会绕过 coordinator claim。

因此 S1 的 `SessionRestart` 保持 inert，S5 之前不得在 production host 无条件调用。S5 必须增加 startup arbitration：

- 普通 retained Session 可以原子 consume suspension 后调用 `SessionExecution.resume`；
- 绑定 active task/Goal run 的 child Session 交给 coordinator reconciliation；
- terminal、closed、stopped 或 ambiguous binding 不得直接 resume；
- 同一 suspension 只能由 Session resumer 或 control-plane reconciler 其中一个原子领取；
- host shutdown 顺序必须是 stop admission、持久化 control-plane shutdown intent、标记 Session suspension、再 teardown execution scope。

### Graceful restart 不是 hard-crash recovery

`time_suspended` 只证明旧 managed process 在 orderly shutdown 时授权一次续跑。SIGKILL、provider completion unknown 和 tool side-effect unknown 不会从 lifecycle history推导 suspension。S6 之前，这些状态进入 `recovery_required` 或保持人工 resume，不自动创建新 provider/tool work。

## 非目标

- 不迁移 TUI、desktop、app、SDK、plugin、catalog、browser 或产品路由；
- 不批量替换 DeepAgent Session runner；
- 不迁移 `session_input -> session_pending` 的上游表重建；
- 不用上游 instruction state 覆盖 System Context/Context Epoch；
- 不把 Goal/task adapter 从 legacy 路径切换到未完成的 substrate；
- 不实现 clustered Session ownership；
- 不盲重试 hard-crash provider request；
- 不重放 ambiguous tool side effects；
- 不声称 exactly-once provider、tool 或 end-to-end delivery。

## 实施计划

| ID | 状态 | 依赖 | 工作 | 退出门禁 |
| --- | --- | --- | --- | --- |
| S0 | 完成 | none | 审计最新 `origin/dev`、`origin/v2`、最近两周相关远端分支和目标等价能力，冻结本决策矩阵 | 每项能力都有 import/adapt/defer/reject 结论；source commit 固定 |
| S1 | 完成于 `2fba253b` | S0 | execution lifecycle、`active`、`awaitIdle`、`time_suspended`、atomic consume、inert `SessionRestart` | 175 项聚焦测试；两个包 typecheck；无 UI diff |
| S2 | 待实施 | S1 | 对齐 runner/tool settlement：owned fiber join、typed decline、first terminal、bounded receipt、structured-output/malformed input、hosted/local sweep | 每个 local/hosted/interrupt/decline/malformed/oversized-output kill point 只有一个 durable terminal tool result，receipt 可继续投影 |
| S3 | 待实施 | S2 | DeepAgent-compatible `SessionModelRequest.prepare`、request fingerprint、tool snapshot、renamed-tool provenance、typed pre-evidence retry 和 retry events | 一个 explicit `llm.stream`/physical attempt；hook 不能越权或产生不可执行 tool；有 evidence 后不 retry；logical step/physical attempt identity 测试通过 |
| S4 | 待实施 | S2 | 扩展现有 `session_input` typed algebra，加入 synthetic/compaction barrier 和 explicit fork-boundary adapter；保留 `goal_steer` 与历史 row | exact retry、barrier ordering、promotion rollback、fork cutoff 和 migration fixture 通过 |
| S5 | 待实施 | S1、control-plane W6A/G1 binding | managed host restart arbitration 和 shutdown ordering；禁止 raw resume bound child | 普通 Session 续跑；task/Goal child 只经 coordinator；双 claimant 只有一个 winner |
| S6 | 待设计/实施 | S2、S3、W6A | Session activity claim/fence、provider dispatch evidence、tool idempotency/status proof、crash matrix | 每个 kill point明确 safe continuation 或 quiescence；无 blind replay |

S2 和 S3 是 W4/G1 使用 V2 runner 前的 substrate 门禁。S4 在 S2 完成后可以与 control-plane schema 工作并行，但 manual compaction、synthetic pending 或 V2 fork adapter 上线前必须完成。S5 不是 S1 的自动后续；只有 control-plane binding 能参与 arbitration 后才允许宿主激活。W6B/G2 必须依赖 S6，不能把 S1 graceful restart 当作替代。

## 安全不变量

1. Durable admission 与 execution scheduling 分离。
2. 现有 admission-sequence interrupt fencing 保持权威。
3. 一个 provider physical attempt 恰好对应一次显式 `llm.stream(request)`。
4. Continuation 前重新加载 projected history。
5. Tool side effect 前必须已有 durable call identity；unknown prior effect 永不 blind replay。
6. Lifecycle event 是 observation，不是 task lease、Session activity claim 或 cluster ownership。
7. Graceful suspension 是一次 resume intent，不是 live status，也不是 crash-replay proof。
8. Control-plane child 的 Session suspension 不能绕过 logical run/attempt coordinator。
9. Event replay ownership 与 Session execution ownership 分离。
10. DeepAgent System Context/Context Epoch 保持 Session-owned。

## 验收与证据

- 每个 S 工作包都包含 capability mapping、代码、聚焦测试和 migration note；
- 所有既有 Session coordinator interruption/sequence tests 保持通过；
- pending/barrier 测试检查 durable row 和 aggregate event，不只检查最终文本；
- runner tests 断言 logical step、physical attempt、assistant message、tool call 和 terminal identity；
- hook tests 断言 tool rename 保留 registry provenance，删除/新增 definition 不能越过 frozen capability；
- provider-state continuation regression 证明目标现有 `AssistantText.providerMetadata` 等价能力未退化；
- retry tests 分别覆盖 pre-evidence transient、post-evidence failure、overflow rebuild 和 process crash；
- restart tests分别覆盖普通 Session、绑定 task child、绑定 Goal child、terminal binding 和双 claimant；
- S6 使用 provider/tool kill-point matrix 证明 safe continuation 或 quiescence；
- `bun typecheck` 从 `packages/core` 和 `packages/deepagent-code` 运行；
- 最终 diff 不包含 UI 或无关产品特性。

## 与控制面计划的依赖

- W0/G0 可以与 S2 实施及 S3/S4 的独立设计、fixture 准备并行；S3/S4 runtime 仍遵守表中的 S2 依赖。
- W4 和 G1 在执行真实 V2 provider/tool loop 前依赖 S2、S3。
- W6A 消费 S1 lifecycle observation，但不能从它推导 crash safety。
- S5 依赖 W6A/G1 能识别并接管 bound child。
- W6B 依赖 S6；G2 继续依赖 W6B。
- 未完成 S6 时，ambiguous Goal activity 必须保持 `quiescent/recovery_required`。
