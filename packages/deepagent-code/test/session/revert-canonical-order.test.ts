import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { MessageID, PartID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    SessionProjector.defaultLayer,
    SessionRevert.defaultLayer,
    Snapshot.defaultLayer,
    Storage.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    EventV2.defaultLayer,
  ),
)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

describe("canonical revert boundary", () => {
  it.live(
    "reverts and cleans stable IM IDs using promotion order across time pages",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const events = yield* EventV2.Service
          const session = yield* sessions.create({ title: "queued stable IDs" })
          const first = SessionMessage.ID.make("msg_ffffffffffffffffffffffffffffffffffffffff")
          const queued = SessionMessage.ID.make("msg_0000000000000000000000000000000000000000")
          const model = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test") }
          const admit = Effect.fn(function* (id: SessionMessage.ID, time: number) {
            yield* events.publish(SessionEvent.PromptLifecycle.Admitted, {
              sessionID: session.id,
              messageID: id,
              timestamp: DateTime.makeUnsafe(time),
              prompt: new Prompt({ text: String(id) }),
              delivery: "queue",
            })
          })
          yield* admit(first, 2000)
          yield* admit(queued, 1000)
          yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), "a0"))
          const turn = Effect.fn(function* (id: SessionMessage.ID, time: number, next: string) {
            yield* events.publish(SessionEvent.PromptLifecycle.Promoted, {
              sessionID: session.id,
              messageID: id,
              timestamp: DateTime.makeUnsafe(time),
              timeCreated: DateTime.makeUnsafe(time),
              prompt: new Prompt({ text: String(id) }),
            })
            // Seed compatibility egress without a provider-owner lease; read metadata must
            // still derive from the real promotion journal, never a stored wire sequence.
            yield* sessions.updateMessage({
              id: MessageID.make(String(id)),
              sessionID: session.id,
              role: "user",
              agent: "build",
              model: { providerID: model.providerID, modelID: model.id },
              time: { created: time },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: MessageID.make(String(id)),
              sessionID: session.id,
              type: "text",
              text: String(id),
            })
            const assistantID = SessionMessage.ID.create()
            const before = yield* snapshot.track()
            expect(before).toBeDefined()
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: session.id,
              assistantMessageID: assistantID,
              timestamp: DateTime.makeUnsafe(time + 1),
              agent: "build",
              model,
              snapshot: before,
            })
            yield* sessions.updateMessage({
              id: MessageID.make(String(assistantID)),
              sessionID: session.id,
              role: "assistant",
              parentID: MessageID.make(String(id)),
              agent: "build",
              mode: "build",
              providerID: model.providerID,
              modelID: model.id,
              path: { cwd: dir, root: dir },
              cost: 0,
              tokens,
              time: { created: time + 1 },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: MessageID.make(String(assistantID)),
              sessionID: session.id,
              type: "step-start",
              snapshot: before,
            })
            yield* Effect.promise(() => Bun.write(path.join(dir, "a.txt"), next))
            const after = yield* snapshot.track()
            const patch = yield* snapshot.patch(before!)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: MessageID.make(String(assistantID)),
              sessionID: session.id,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: session.id,
              assistantMessageID: assistantID,
              timestamp: DateTime.makeUnsafe(time + 2),
              finish: "stop",
              cost: 0,
              tokens,
              snapshot: after,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: MessageID.make(String(assistantID)),
              sessionID: session.id,
              type: "step-finish",
              snapshot: after,
              reason: "stop",
              cost: 0,
              tokens,
            })
            return MessageID.make(String(assistantID))
          })
          const firstAssistant = yield* turn(first, 2000, "a1")
          const queuedAssistant = yield* turn(queued, 1000, "a2")
          const original = yield* sessions.getClientMessage({
            sessionID: session.id,
            messageID: MessageID.make(String(first)),
          })
          const later = yield* sessions.getClientMessage({
            sessionID: session.id,
            messageID: MessageID.make(String(queued)),
          })
          expect(original.info.canonicalSeq).toBeLessThan(later.info.canonicalSeq!)
          expect(original.info.time.created).toBeGreaterThan(later.info.time.created)

          yield* revert.revert({ sessionID: session.id, messageID: queuedAssistant, notice: false })
          expect(String((yield* sessions.get(session.id)).revert?.messageID)).toBe(String(queued))
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("a1")
          yield* revert.revert({ sessionID: session.id, messageID: firstAssistant, notice: false })
          expect(String((yield* sessions.get(session.id)).revert?.messageID)).toBe(String(first))
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("a0")
          yield* revert.unrevert({ sessionID: session.id, notice: false })
          expect(yield* Effect.promise(() => Bun.file(path.join(dir, "a.txt")).text())).toBe("a2")
          yield* revert.revert({ sessionID: session.id, messageID: queuedAssistant, notice: false })
          yield* revert.cleanup(yield* sessions.get(session.id))
          const remaining = yield* sessions.messages({ sessionID: session.id })
          expect(remaining.map((message) => String(message.info.id))).toEqual([String(first), String(firstAssistant)])
          expect((yield* sessions.get(session.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
