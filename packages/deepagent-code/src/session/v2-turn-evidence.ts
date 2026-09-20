import { Effect, DateTime, Option } from "effect"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionID, MessageID, PartID } from "./schema"
import type { Session } from "./session"
import type { Snapshot } from "../snapshot"

// V2→V1 消息镜像（§16.3 顺序 4 包 C）：V2 驱动回合后把 V2 user/assistant 消息经规范转换器
// SessionV2.legacyAssistant 镜像为 V1 message/part 行（V1 客户端/V1 投影消费面），并挂回合聚合补丁
// part。幂等（确定性 id + upsert）；证据失败全因吞掉。LEGACY-EXECUTION-ZERO 分类：projection
// adapter——把 V2 durable authority 投影到有限 history reader 面，不属于 legacy 执行/写入。
type V2UserMessage = Extract<SessionMessage.Message, { readonly type: "user" }>
type V2AssistantMessage = Extract<SessionMessage.Message, { readonly type: "assistant" }>

// R2 — this projector runs on EVERY driven turn and used to re-publish the ENTIRE transcript
// (every message + part) each time: O(N²) event traffic and event-storage growth over a session,
// and duplicate SSE for every already-mirrored part. Publish only DELTAS: read the existing V1
// mirror row first and skip writes (and their event publications) whose content is unchanged.
// Fingerprints are whole-value JSON — a real state transition (pending→completed, cost updates)
// changes the fingerprint and still publishes.
const mirrorFingerprint = (value: unknown) => JSON.stringify(value)

export const recordTurnEvidence = Effect.fn("recordTurnEvidence")(function* (input: {
  readonly sessions: Session.Interface
  readonly session: SessionV2.Interface
  readonly sessionID: SessionID
  readonly parentSessionID: SessionID
  readonly agentName: string
  readonly agentMode: string
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly snapshot?: Snapshot.Interface
  readonly baseline?: string
}) {
  const perfDebug = process.env["DEEPAGENT_CODE_PERF_DEBUG"] === "1"
  const evidenceT0 = Date.now()
  const messages = yield* input.session
    .messages({ sessionID: input.sessionID, order: "asc" })
    .pipe(Effect.catchCause(() => Effect.succeed([] as readonly SessionMessage.Message[])))
  if (perfDebug)
    console.error(`[perf] recordTurnEvidence read ${Date.now() - evidenceT0}ms for ${messages.length} messages`)
  const parent = yield* input.sessions.get(input.parentSessionID).pipe(Effect.orDie)
  // Single ascending pass: each assistant pairs with the most recent user before it (the same anchor
  // SessionRevert resolves); without a preceding user (degenerate shape) it falls back to the
  // previous assistant instead of pointing at itself.
  let lastUser: V2UserMessage | undefined
  let lastAssistant: V2AssistantMessage | undefined
  let lastAssistantMirrorParts: Map<string, string> | undefined
  for (const message of messages) {
    // R2 follow-up — the fingerprint gate is an optimization, never an authority: when the
    // existing mirror row cannot be read (Session.Interface stubs without getMessage, transient
    // read failures), fall back to publishing unconditionally rather than dropping evidence.
    const mirrored =
      typeof input.sessions.getMessage === "function"
        ? yield* input.sessions
            .getMessage({ sessionID: input.sessionID, messageID: MessageID.make(message.id) })
            .pipe(Effect.option, Effect.catchCause(() => Effect.succeed(Option.none())))
        : Option.none()
    const mirroredInfo = Option.isSome(mirrored) ? mirrorFingerprint(mirrored.value.info) : undefined
    const mirroredParts = Option.isSome(mirrored)
      ? new Map(mirrored.value.parts.map((part) => [part.id, mirrorFingerprint(part)]))
      : undefined
    if (message.type === "user") {
      lastUser = message
      const info = {
        id: MessageID.make(message.id),
        sessionID: input.sessionID,
        role: "user" as const,
        time: { created: DateTime.toEpochMillis(message.time.created) },
        agent: input.agentName,
        model: {
          providerID: ProviderV2.ID.make(input.model.providerID),
          modelID: ModelV2.ID.make(input.model.modelID),
        },
      }
      if (mirroredInfo !== mirrorFingerprint(info)) yield* input.sessions.updateMessage(info)
      continue
    }
    if (message.type !== "assistant") continue
    // §16.3 order 4 package C: mirror through the CANONICAL V2→V1 converter — the same single
    // source of truth the V2 recovery path uses — so V1 readers get full fidelity (text,
    // reasoning, and tool parts with serialized state; the error payload as UnknownError; variant
    // and finish) instead of a hand-rolled subset. Part IDs stay deterministic across re-attempts.
    const legacy = SessionV2.legacyAssistant({
      sessionID: input.sessionID,
      parentMessageID: MessageID.make(lastUser?.id ?? lastAssistant?.id ?? message.id),
      directory: parent.directory,
      root: parent.directory,
      message,
    })
    if (mirroredInfo !== mirrorFingerprint(legacy.info)) yield* input.sessions.updateMessage(legacy.info)
    for (const part of legacy.parts) {
      if (mirroredParts?.get(part.id) === mirrorFingerprint(part)) continue
      yield* input.sessions.updatePart(part)
    }
    lastAssistant = message
    lastAssistantMirrorParts = mirroredParts
  }
  // One aggregate patch part per driven turn, attached to its last assistant message. SessionRevert's
  // collector keeps the first patch per file, so a turn-granularity patch composes correctly across
  // consecutive turns on the same files.
  if (!input.snapshot || !input.baseline) return
  if (!lastAssistant) return
  const patch = yield* input.snapshot.patch(input.baseline)
  if (patch.files.length === 0) return
  const patchPart = {
    // ID namespace is disjoint from the converter's content parts by construction: content part
    // suffixes are always numeric (`prt_<id-without-msg-prefix>_<index>`), this suffix is always
    // `_patch` under the full `prt_msg_…` prefix — they can never collide.
    id: PartID.make(`prt_${lastAssistant.id}_patch`),
    messageID: MessageID.make(lastAssistant.id),
    sessionID: input.sessionID,
    type: "patch" as const,
    hash: patch.hash,
    files: patch.files,
  }
  if (lastAssistantMirrorParts?.get(patchPart.id) === mirrorFingerprint(patchPart)) return
  yield* input.sessions.updatePart(patchPart)
})
