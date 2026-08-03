# Goal + Plan：等待上游 Durable Session V2 成熟后再迁移

状态：**暂停，等待上游。** 当前没有实施中的 V2 迁移工作包。

## 当前决策

DeepAgentCode 的生产对话、task subagent 和 Goal role 继续使用 legacy `SessionPrompt` 引擎。当前 subagent 控制平面设计不依赖 Session V2，也不把 V2 迁移列为任何工作包的前置条件。

本仓库不在 `origin/dev` 与 `origin/v2` 尚未收敛时替上游补完 runner、pending/compaction、tool settlement、activity recovery 或 host wiring。后续只迁移已经由上游完成、合入默认开发线并有稳定测试契约的基础设施。

## 审计基线

- 上游仓库：`/Users/xiuranli/code/deepagent-ai/opencode`
- 上游 `dev`：`1882c33827cf0ce5c948b69ab5a87ed8f6790cf8`
- 上游 `v2`：`3f30203b72412ba7b324e86cb2ebbf6208d152ac`
- 两个上游 ref 的 merge base：`0e2dd4ad150d0182fc9e43d81424d8db11465977`
- 目标基线：`dev@ee1d325cfb04ded09ee0b7cb3307ea9bc25eeea2`
- 隔离分支：`codex/merge-upstream-durable`
- 已导入提交：`2fba253b56cba9dc7a78a43de83d80fcfb090645`

该审计结论只固定本次检查证据，不表示这些 ref 仍是未来迁移基线。恢复本 Goal 时必须重新同步并审计上游默认开发线。

## 为什么暂停

1. `origin/dev` 虽有 Session V2 service、durable input、EventV2 和 runner wiring，但没有 `origin/v2` 后续的 pending、compaction、retry、tool settlement 和完整 lifecycle 演进。
2. `origin/v2` 与 `origin/dev` 长期分叉，不能视为即将合入的稳定产品基线。
3. 上游没有给出 hard-crash 后 provider dispatch、tool external side effect 和 activity ownership 的完整恢复契约。
4. 最近分支提供的是局部修复，不构成一套可独立落地的 production V2 engine。
5. DeepAgent 当前 production task/Goal、plugin、permission、System Context、worktree 和 prompt pipeline 全部建立在 legacy 引擎上；提前切换会同时扩大控制平面和执行引擎两类风险。

## 已导入内容的处理

提交 `2fba253b` 已在隔离分支导入以下基础设施：

- Session execution lifecycle observation；
- process-local `active/awaitIdle`；
- `time_suspended` 和 atomic consume；
- inert `SessionRestart` service；
- 相应 migration、schema note 和聚焦测试。

处理规则：

- 保留在 `codex/merge-upstream-durable` 供未来对照，不继续扩展；
- 不在 production host 激活 `SessionRestart`；
- 不接入 task、Goal role 或 legacy child recovery；
- 不把 lifecycle observation解释成 execution claim、activity fence 或 crash replay proof；
- 在上游成熟前，不以该提交为理由合并整个隔离分支。

## 能力逐项决策

| 能力 | 当前判断 | 当前动作 |
| --- | --- | --- |
| Durable prompt admission | DeepAgent 已有 dormant V2 `session_input`，production仍用 V1 message/steer | 不迁移、不切流 |
| Generalized pending algebra | 只在分叉的 `origin/v2` 完整演进 | 等上游合入默认开发线 |
| Manual compaction barrier | 与 pending promotion 和 runner ordering强耦合 | 不单独复制 |
| Execution lifecycle | 已在隔离分支导入 observation slice | 保持 inert |
| Graceful restart | 只证明 orderly suspension，不证明 hard-crash safety | 不激活 host wiring |
| Provider retry | 依赖 V2 logical step、durable evidence 和 request boundary | 不适配到 legacy，不迁移 |
| Model request preparation | DeepAgent prompt/plugin/tool pipeline差异较大 | 等稳定 API 后重新做 parity audit |
| Tool fiber/settlement | 局部能力分散在 `origin/v2` 和 side branches | 不拼装、不替上游集成 |
| Instruction state | DeepAgent 已有 System Context/Context Epoch authority | 不迁移，不覆盖现有设计 |
| Bus replay watermark | DeepAgent 已有 EventV2/outbox/consumer ownership | 不替换 |
| Explicit V2 fork boundary | 依赖 V2 history/pending语义 | 当前 subagent 使用 legacy `Session.forkForTask` 设计 |
| Renamed-tool provenance | 是可独立评估的 tool bug，不是 V2 substrate | 仅在 legacy production 可复现时另开 bug fix |
| Bounded tool receipt | 是可独立评估的 settlement约束 | 仅在当前实现存在缺陷时另开 bug fix |
| Hard-crash activity recovery | 上游尚无成熟实现 | 不自行实现；legacy 控制平面统一 fail closed |
| UI、TUI、desktop、SDK、product routes | 与基础设施迁移无关 | 永久排除本 Goal |

## 最近分支审计保留结论

审计窗口为 2026-07-20 至 2026-08-03。以下结论只保留判断证据，不形成待实施任务：

| 分支/提交 | 判断 | 当前动作 |
| --- | --- | --- |
| `origin/renamed-tool-execution@4086aa8079` | 修复renamed tool registry provenance，是独立tool correctness问题 | 仅在legacy可复现时另开bug，不作为V2迁移 |
| `origin/undo-pending-input@d7ffc7fec1` | 依赖promotion后删除`session_pending` row的上游algebra | defer，不能套到保留历史row的`session_input` |
| `origin/text-phase-state@ce1203ce83` | DeepAgent已有`AssistantText.providerMetadata`和continuation projection等价能力 | 不复制schema，未来只做regression parity |
| `origin/bound-tool-output@aa1f91e0d0/f7a72fdf32/98be51b74c` | first-terminal/bounded receipt约束有价值，但分支不是完整V2 substrate | 当前实现若有独立缺陷则另修，不拼装branch architecture |
| `origin/tui-inbox-tabs@094dac1541` | ancestor activity projection服务UI/inbox | 排除 |
| `origin/prompt-cache-key@a214ac39de`、`origin/codex-input-limit@b1a61aaf55`、`origin/cache-diagnostics@34ed5bb399` | request sizing/cache diagnostics | 排除本Goal，可独立产品化 |
| `origin/gpt56-stream-fix@917d18203a`、`origin/session-http-middleware@1eec3e640a` | auth refresh/plugin HTTP hook | 排除，不改变durable ownership/recovery |

这些分支均未提供Session activity claim/fence、provider dispatch exactly-once proof或external tool status reconciliation，不能据此解除暂停。

## 暂停期间禁止事项

- 不再执行旧计划中的 S2-S6；这些编号已经废弃。
- 不从 `origin/v2` 或最近 side branch 继续复制 runner/tool/pending 文件。
- 不为兼容两套引擎增加 production dual-write 或 dual-execution。
- 不把 Session V2 代码接入 task、Goal、worktree 或 parent notification。
- 不自行设计上游缺失的 clustered ownership、provider exactly-once 或 tool replay。
- 不把 subagent 控制平面 L0-L10 绑定到本 Goal。

## 恢复门禁

只有同时满足以下条件，才把本 Goal 从暂停改为实施：

1. 上游 V2 runner 和相关 schema 已合入上游默认开发线，而不是只存在于长期分叉或 side branch。
2. 上游把 V2 标记为 production-supported，公开 prompt、resume、interrupt、fork、compaction 和 shutdown 契约。
3. 上游测试覆盖 pending promotion、compaction barrier、tool settlement、provider retry、graceful restart 和关键 kill points。
4. 对 hard-crash activity 给出明确策略：可证明恢复，或明确进入 quiescent/manual recovery；不能依赖 lease expiry盲重放。
5. DeepAgent parity audit 证明 plugin hooks、permission、tool registry、System Context、history、cache、structured output 和 Location semantics无功能倒退。
6. migration 可以只替换 execution/input adapter，不要求重写已落地的 task/Goal control plane。
7. 用户重新明确授权启动 V2 迁移。

## 恢复后的执行方式

恢复时创建新的 source snapshot 和 capability matrix，不沿用本文件中的旧提交号直接复制。实施顺序固定为：

1. 同步上游默认开发线并重新审计最近相关分支。
2. 对每项能力给出 reuse/adapt/reject 结论和 DeepAgent parity证据。
3. 先移植纯基础设施及上游测试，不接 UI/产品特性。
4. 在隔离 feature flag 下验证 ordinary Session。
5. 最后仅通过 `LegacyTaskInput/LegacySubagentExecutor` 的 adapter边界评估 task/Goal 切换。
6. 任一 crash/settlement语义不闭合时停止迁移，不在本仓库补造上游 runner。

## 当前完成条件

本 Goal 当前阶段的完成不是“V2 已迁移”，而是：

- 审计结论和暂停原因已记录；
- 已导入 slice 被隔离且保持 inert；
- 没有 active migration work package；
- 当前 subagent/Goal 设计可以完全基于 legacy 基建推进；
- 未来恢复门禁明确，可重新审计而不会误用旧计划。
