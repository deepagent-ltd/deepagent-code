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
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskStatusTool } from "../../src/tool/task_status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Task-status reads durable child sessions; BackgroundJob only overlays live work.
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

describe("tool.task_status (v4.0.4 block1 1c)", () => {
  it.instance("lists this session's dispatched subagents with status, and hides other sessions'", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const running = yield* sessions.create({ parentID: parent.id, agent: "general", title: "first task" })
      const terminal = yield* sessions.create({ parentID: parent.id, agent: "general", title: "second task" })
      yield* sessions.create({ parentID: parent.id, title: "ordinary child" })
      const unrelatedParent = yield* sessions.create({ title: "Other parent" })
      yield* sessions.create({ parentID: unrelatedParent.id, agent: "general", title: "someone else's task" })
      yield* sessions.setMetadata({
        sessionID: terminal.id,
        metadata: { deepagent: { subagent: { finished: true, state: "error" } } },
      })
      yield* jobs.start({
        id: running.id,
        type: "task",
        title: "first task",
        metadata: { parentSessionId: parent.id, sessionId: running.id, subagentType: "general" },
        run: Effect.never,
      })

      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, execCtx(parent.id))

      expect(result.metadata.count).toBe(3)
      expect(result.output).toContain("[running]")
      expect(result.output).toContain("first task")
      expect(result.output).toContain(running.id)
      expect(result.output).toContain("[error]")
      expect(result.output).toContain("second task")
      expect(result.output).toContain("ordinary child")
      expect(result.output).not.toContain("someone else's task")
    }),
  )

  it.instance("reports when the session has dispatched nothing", () =>
    Effect.gen(function* () {
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, execCtx(SessionID.make("ses_task_status_empty")))

      expect(result.metadata.count).toBe(0)
      expect(result.output).toContain("No subagent tasks")
    }),
  )

  it.instance("names durable subagents by their session agent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      yield* sessions.create({ parentID: parent.id, agent: "reviewer", title: "review the diff" })

      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, execCtx(parent.id))

      expect(result.output).toContain('reviewer "review the diff"')
    }),
  )
})
