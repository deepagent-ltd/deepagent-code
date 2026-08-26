import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { and, eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { MessageID } from "@/session/schema"
import { TaskRecoveryTool } from "@/tool/task_recovery"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    RuntimeFlags.layer(),
    Session.defaultLayer,
    // QUAL-007: the core SessionProjector materializes event-created sessions; without it the
    // TaskRunTable FK to the session row fails.
    SessionProjector.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    ToolRegistry.defaultLayer,
    Truncate.defaultLayer,
  ),
)

describe("tool.task_recovery", () => {
  it.instance("requires user approval and resolves the latest ambiguous run without replay", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "child", agent: "general" })
      const now = Date.now()
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "run_recovery_tool",
          root_run_id: "run_recovery_tool",
          request_hash: "request",
          parent_session_id: parent.id,
          parent_message_id: MessageID.ascending("msg_recovery_tool"),
          tool_call_id: "call_recovery_tool",
          child_session_id: child.id,
          generation: 1,
          delivery_mode: "foreground",
          phase: "research",
          state: "recovery_required",
          reason: "execution_owner_lost",
          version: 3,
          control_state: "open",
          input_state: "ready",
          time_created: now - 1_000,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const approvals: unknown[] = []
      const tool = yield* TaskRecoveryTool
      const result = yield* (yield* tool.init()).execute(
        { task_id: child.id, resolution: "failed", reason: "user accepted ambiguous outcome" },
        {
          sessionID: parent.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: (request) => Effect.sync(() => approvals.push(request)),
        },
      )

      const run = yield* db
        .select({ state: TaskRunTable.state, version: TaskRunTable.version })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.run_id, "run_recovery_tool"))
        .get()
        .pipe(Effect.orDie)
      const event = yield* db
        .select({ type: TaskRunEventTable.type, version: TaskRunEventTable.version })
        .from(TaskRunEventTable)
        .where(and(eq(TaskRunEventTable.run_id, "run_recovery_tool"), eq(TaskRunEventTable.type, "recovery_resolved")))
        .get()
        .pipe(Effect.orDie)

      expect(approvals).toHaveLength(1)
      expect(run).toEqual({ state: "failed", version: 4 })
      expect(event).toEqual({ type: "recovery_resolved", version: 4 })
      expect(result.output).toContain("was not replayed")
      expect(result.output).toContain("same task_id")
    }),
  )
})
