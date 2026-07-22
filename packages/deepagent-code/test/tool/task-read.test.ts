import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Database } from "@deepagent-code/core/database/database"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { TaskReadTool } from "../../src/tool/task_read"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(),
  ),
)

const execCtx = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const addTextMessage = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "text",
      text,
    })
  })

const readTexts = (output: string) => [...output.matchAll(/<text>([^<]+)<\/text>/g)].map((match) => match[1])

describe("tool.task_read", () => {
  it.instance("pages 203 child messages through storage cursors without duplicates", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, agent: "general", title: "Long task" })
      const expected = Array.from({ length: 203 }, (_, index) => `message-${String(index + 1).padStart(3, "0")}`)

      for (const text of expected) yield* addTextMessage(child.id, text)

      const tool = yield* TaskReadTool
      const def = yield* tool.init()
      const first = yield* def.execute({ task_id: child.id, limit: 100 }, execCtx(parent.id))
      const second = yield* def.execute(
        { task_id: child.id, limit: 100, before: first.metadata.before },
        execCtx(parent.id),
      )
      const third = yield* def.execute(
        { task_id: child.id, limit: 100, before: second.metadata.before },
        execCtx(parent.id),
      )

      expect(first.metadata.hasMore).toBe(true)
      expect(second.metadata.hasMore).toBe(true)
      expect(third.metadata.hasMore).toBe(false)
      expect(readTexts(first.output)).toEqual(expected.slice(103))
      expect(readTexts(second.output)).toEqual(expected.slice(3, 103))
      expect(readTexts(third.output)).toEqual(expected.slice(0, 3))
      expect([...readTexts(third.output), ...readTexts(second.output), ...readTexts(first.output)]).toEqual(expected)
    }),
  )
})
