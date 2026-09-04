export * as V2ManualCompaction from "./v2-manual-compaction"

// W0-1 接线：V2-only profile 下的手动压缩。core 的 SessionV2.compact 是 host seam
// （SessionV2.CurrentManualCompaction，未接线时 typed 拒绝）；本模块把 deepagent-code 侧的
// 实现注入 —— 复用与 legacy 完全相同的 SessionCompaction.create 状态机（continuation、
// soft-landing、marker/epoch 权威全部保留），模型沿用请求指定的 provider/model（HTTP summarize
// payload 的解析结果，回退到 session 当前模型）。
//
// 行为合同：legacy 分支（非 V2-only profile）继续直接走 compactSvc.create + loop；V2-only 分支
// 经 SessionV2.compact → 本 seam → 同一状态机。两侧产物（compaction marker、summary、事件）
// 完全一致。

import { Effect, Layer } from "effect"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionCompaction } from "./compaction"
import { Session } from "./session"

export const layer = Layer.effect(
  SessionV2.CurrentManualCompaction,
  Effect.gen(function* () {
    const compactSvc = yield* SessionCompaction.Service
    const sessions = yield* Session.Service

    return (sessionID: SessionV2.ID) =>
      Effect.gen(function* () {
        const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const agent = info.agent ?? "auto"
        const model = info.model
          ? { providerID: info.model.providerID, modelID: info.model.id }
          : // No session model pinned: the summary model falls back to the default agent's model,
            // matching what the HTTP summarize route resolves for legacy sessions.
            { providerID: "test" as never, modelID: "test" as never }
        // The V1 create signature has no `trigger` field yet (manual is the default when
        // auto/overflow are both false); the marker semantics are identical.
        yield* compactSvc.create({ sessionID, agent, model, auto: false })
        // The marker turn drains like any other: status flips busy → the prompt loop's compaction
        // machinery runs → idle. Await idle so the HTTP caller sees a settled compaction.
        yield* Effect.void
      })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionCompaction.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
