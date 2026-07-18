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

const mine = SessionID.make("ses_task_status_mine")
const other = SessionID.make("ses_task_status_other")

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
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({
        id: "job-task-status-running",
        type: "task",
        title: "first task",
        metadata: { parentSessionId: mine, sessionId: "job-task-status-running" },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "job-task-status-settled",
        type: "task",
        title: "second task",
        metadata: { parentSessionId: mine, sessionId: "job-task-status-settled" },
        run: Effect.fail(new Error("boom")),
      })
      yield* jobs.start({
        id: "job-task-status-other",
        type: "task",
        title: "someone else's task",
        metadata: { parentSessionId: other, sessionId: "job-task-status-other" },
        run: Effect.never,
      })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const job = yield* jobs.get("job-task-status-settled")
          return job?.status === "error" ? (true as const) : undefined
        }),
        "settled job never reached terminal state",
      )

      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, execCtx(mine))

      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain("[running]")
      expect(result.output).toContain("first task")
      expect(result.output).toContain("job-task-status-running")
      expect(result.output).toContain("[error]")
      expect(result.output).toContain("second task")
      expect(result.output).not.toContain("someone else's task")
      expect(result.output).not.toContain("job-task-status-other")
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

  // 1c regression: BackgroundJob records type="task" for EVERY dispatch, so the list must surface the
  // real subagent type from metadata.subagentType — otherwise every row reads "task" and the parent
  // cannot tell WHICH subagent hung (the whole point of the tool). Falls back to job.type only when the
  // metadata is absent (older jobs).
  it.instance("names the real subagent type from metadata, falling back to job.type", () =>
    Effect.gen(function* () {
      const sess = SessionID.make("ses_task_status_types")
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({
        id: "job-typed-reviewer",
        type: "task",
        title: "review the diff",
        metadata: { parentSessionId: sess, sessionId: "job-typed-reviewer", subagentType: "reviewer" },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "job-untyped",
        type: "task",
        title: "legacy job",
        metadata: { parentSessionId: sess, sessionId: "job-untyped" },
        run: Effect.never,
      })

      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, execCtx(sess))

      // The reviewer row is named by its real type, not the generic "task".
      expect(result.output).toContain("reviewer")
      expect(result.output).toContain('reviewer "review the diff"')
      // The untyped legacy job still falls back to job.type ("task").
      expect(result.output).toContain('task "legacy job"')
    }),
  )
})
