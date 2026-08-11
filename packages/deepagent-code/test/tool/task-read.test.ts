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
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
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

const addTextMessage = (sessionID: SessionID, text: string, created = Date.now()) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "text",
      text,
    })
  })

const readTexts = (output: string) =>
  [...output.matchAll(/<message[^>]*>\s*([^<]+?)\s*<\/message>/g)].map((match) => match[1])

describe("tool.task_read", () => {
  it.instance("preserves completed child tool output", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, agent: "researcher", title: "Research" })
      const marker = `child-${crypto.randomUUID()}`
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "researcher",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: child.id,
        mode: "subagent",
        agent: "researcher",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: assistant.id,
        type: "tool",
        callID: "call-read",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "fixtures/research.txt" },
          output: marker,
          title: "Read",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })

      const tool = yield* TaskReadTool
      const result = yield* (yield* tool.init()).execute({ task_id: child.id, limit: 100 }, execCtx(parent.id))

      expect(result.output).toContain(`<tool name="read" state="completed">${marker}</tool>`)
    }),
  )

  it.instance("pages 203 child messages through storage cursors without duplicates", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, agent: "general", title: "Long task" })
      const expected = Array.from({ length: 203 }, (_, index) => `message-${String(index + 1).padStart(3, "0")}`)

      for (const [index, text] of expected.entries()) yield* addTextMessage(child.id, text, 1_700_000_000_000 + index)

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

  it.instance("returns the complete durable raw result even when it is outside the transcript page", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, agent: "reviewer", title: "Review" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "reviewer",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: 1_700_000_000_000 },
      })
      const rawResultMessageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: rawResultMessageID,
        role: "assistant",
        parentID: user.id,
        sessionID: child.id,
        mode: "reviewer",
        agent: "reviewer",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1_700_000_000_001 },
        finish: "stop",
      })
      const result = `${"finding ".repeat(150)}TAIL-${crypto.randomUUID()}`
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: child.id,
        messageID: rawResultMessageID,
        type: "text",
        text: result,
      })
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: `run_task_read_${crypto.randomUUID()}`,
          request_hash: "request",
          parent_session_id: parent.id,
          parent_message_id: MessageID.ascending(),
          tool_call_id: "call-task-read-result",
          child_session_id: child.id,
          generation: 1,
          delivery_mode: "foreground",
          phase: "settled",
          state: "error",
          reason: "structured_output_missing",
          raw_result_message_id: rawResultMessageID,
          version: 1,
          control_state: "closed",
          input_state: "ready",
          time_created: 1_700_000_000_000,
          time_updated: 1_700_000_000_100,
          time_settled: 1_700_000_000_100,
        })
        .run()
        .pipe(Effect.orDie)
      for (let index = 0; index < 10; index++) {
        yield* addTextMessage(child.id, `newer-${index}`, 1_700_000_000_010 + index)
      }

      const tool = yield* TaskReadTool
      const output = yield* (yield* tool.init()).execute({ task_id: child.id, limit: 5 }, execCtx(parent.id))

      expect(output.output).toContain(`<task_result source="raw" message_id="${rawResultMessageID}">`)
      expect(output.output).toContain(result)
      expect(output.metadata).toMatchObject({
        resultSource: "raw",
        resultMessageID: rawResultMessageID,
        resultTruncated: false,
      })
      expect(readTexts(output.output)).toEqual(["newer-5", "newer-6", "newer-7", "newer-8", "newer-9"])
    }),
  )
})
