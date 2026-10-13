import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import { Effect, Layer } from "effect"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { InstanceRegistry } from "@/effect/instance-registry"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { testEffect } from "../lib/effect"

// Automatic mention admission is retired. Command deduplication, conflict and
// Session reuse are tested through the real IMDacSession bridge instead.

const root = mkdtempSync(`${os.tmpdir()}/im-agent-execution-`)
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(InstanceRegistry.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
// Noop execution: admission is durable; the advisory wake does not need a drain for these tests.
const v2Session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.provide(InstanceRegistry.layer),
  Layer.orDie,
)
const it = testEffect(Layer.mergeAll(database, events, projector, store, projects, v2Session, IMRepositoryLive.pipe(Layer.provide(database))))

const prepare = Effect.gen(function* () {
  const repo = yield* IMRepository
  const group = yield* repo.createGroup({ workspaceID: root, type: "project", name: "test", createdBy: "user-1" })
  const create = (clientRequestID: string) => repo.createMessage({ groupID: group.id, senderID: "user-1", senderType: "user", type: "text", content: "@auto @general please answer", clientRequestID, mentionIntent: { names: ["auto", "general"], directory: root, workspaceID: root, userID: "user-1", origin: "local" } })
  const first = yield* create(crypto.randomUUID())
  const next = yield* create(crypto.randomUUID())
  return { mention: { groupID: group.id, messageID: first.id, agent: "auto", senderID: "user-1", content: first.content, directory: root }, nextID: next.id }
})

const executionRows = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* db.all<{ sessions: number; inputs: number; receipts: number; outbox: number }>(
    "SELECT (SELECT count(*) FROM session) sessions,(SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) receipts,(SELECT count(*) FROM im_reply_outbox) outbox",
  ).pipe(Effect.orDie)
})

describe("IMAgentExecution retired mention admission", () => {
  it.effect("duplicate direct calls remain typed refusals without an input or wake", () => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const prepared = yield* prepare
    const before = yield* executionRows
    for (const input of [prepared.mention, prepared.mention]) {
      const refusal = yield* IMAgentExecution.admitMention(session, input).pipe(Effect.flip)
      expect(refusal).toBeInstanceOf(LocalOperatorSchema.Error)
      if (refusal instanceof LocalOperatorSchema.Error) expect(refusal.code).toBe("LOCAL_TASK_EXECUTION_UNAVAILABLE")
    }
    expect(yield* executionRows).toEqual(before)
    expect(before).toEqual([{ sessions: 0, inputs: 0, receipts: 0, outbox: 0 }])
  }))

  it.effect("changed mention content cannot create a first admission or revive exact retry", () => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const prepared = yield* prepare
    const before = yield* executionRows
    for (const input of [prepared.mention, { ...prepared.mention, content: "@auto different content" }]) {
      const refusal = yield* IMAgentExecution.admitMention(session, input).pipe(Effect.flip)
      expect(refusal).toBeInstanceOf(LocalOperatorSchema.Error)
      if (refusal instanceof LocalOperatorSchema.Error) expect(refusal.code).toBe("LOCAL_TASK_EXECUTION_UNAVAILABLE")
    }
    expect(yield* executionRows).toEqual(before)
  }))

  it.effect("follow-up and other-agent mentions cannot select or create an execution Session", () => Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const prepared = yield* prepare
    const before = yield* executionRows
    for (const input of [prepared.mention, { ...prepared.mention, messageID: prepared.nextID },
      { ...prepared.mention, messageID: prepared.nextID, agent: "general" }]) {
      const refusal = yield* IMAgentExecution.admitMention(session, input).pipe(Effect.flip)
      expect(refusal).toBeInstanceOf(LocalOperatorSchema.Error)
      if (refusal instanceof LocalOperatorSchema.Error) expect(refusal.code).toBe("LOCAL_TASK_EXECUTION_UNAVAILABLE")
    }
    expect(yield* executionRows).toEqual(before)
  }))
})
