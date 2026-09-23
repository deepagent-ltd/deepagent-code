export * as TaskStatusTool from "./task-status"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { asc, desc, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { SessionTable, TaskRunTable } from "../session/sql"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task_status"

const DESCRIPTION = [
  "List the subagent tasks this session has dispatched (via the task tool), oldest first.",
  "For each: session ID, status (running/completed/failed/interrupted/closed/recovery_required), agent type, title, elapsed time.",
  "Uses the durable task_run ledger rows as the authoritative source so results survive process restarts; the running state comes from the ledger's claim/lease columns, not this process's memory.",
  "Use it to check on a subagent before deciding to wait, resume, close (task_close), or call task_read to recover partial work.",
  "Read-only: it never starts, cancels, or modifies tasks.",
].join(" ")

const Input = Schema.Struct({})

const Output = Schema.Struct({
  count: Schema.Number,
  output: Schema.String,
})

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

/**
 * WS4b-S1 port of the legacy durable task_status: a two-layer merge keyed by child session.
 *
 * Layer 1: durable child sessions of the caller (SessionTable.parent_id).
 * Layer 2 (authoritative state): the latest-generation durable task_run row per child — the same
 * rows the Core V2 TaskRunAuthority writes. The legacy third layer (the app-side in-process
 * BackgroundJob overlay) is deliberately NOT ported: the ledger row is the authority, and a live
 * run is identifiable by its non-terminal state plus owner/lease columns.
 *
 * Backward compat: child sessions with no task_run row are shown as "unknown", not silently
 * omitted or shown as "running" (which would be misleading).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (_input, context) =>
            Effect.gen(function* () {
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              if (!database)
                return yield* new ToolFailure({
                  message: "task_status is unavailable: the database service is missing from the runner context",
                })
              const db = database.db
              const now = Date.now()

              // Layer 1: durable child sessions, oldest first.
              const children = yield* db
                .select({
                  id: SessionTable.id,
                  title: SessionTable.title,
                  agent: SessionTable.agent,
                  time_created: SessionTable.time_created,
                })
                .from(SessionTable)
                .where(eq(SessionTable.parent_id, context.sessionID))
                .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
                .all()
                .pipe(Effect.orDie)

              // Layer 2: durable task_run rows keyed by child_session_id (latest generation wins).
              const runs = yield* db
                .select({
                  run_id: TaskRunTable.run_id,
                  child_session_id: TaskRunTable.child_session_id,
                  state: TaskRunTable.state,
                  execution_spec: TaskRunTable.execution_spec,
                  time_created: TaskRunTable.time_created,
                  time_settled: TaskRunTable.time_settled,
                })
                .from(TaskRunTable)
                .where(eq(TaskRunTable.parent_session_id, context.sessionID))
                .orderBy(desc(TaskRunTable.generation))
                .all()
                .pipe(Effect.orDie)
              const runByChild = new Map<string, (typeof runs)[number]>()
              for (const run of runs) {
                if (!runByChild.has(run.child_session_id)) runByChild.set(run.child_session_id, run)
              }

              const lines = children.map((child) => {
                const run = runByChild.get(child.id)
                const state = run?.state ?? "unknown"

                const specAgent = run?.execution_spec?.["agent"]
                const rawType = typeof specAgent === "string" && specAgent.length > 0 ? specAgent : child.agent
                const agentType = rawType !== null && rawType !== undefined && rawType.length > 0 ? rawType : "task"
                const title = child.title && !child.title.startsWith("New Conversation") ? ` "${child.title}"` : ""

                // Elapsed: age for in-flight runs, total duration for settled ones; run-less
                // children carry no timing.
                const elapsedMs = run
                  ? (run.time_settled ?? now) - run.time_created
                  : undefined
                const duration = elapsedMs !== undefined ? ` (${formatDuration(elapsedMs)})` : ""

                const recoverHint =
                  state === "interrupted" || state === "recovery_required"
                    ? state === "recovery_required"
                      ? ` [resolution required — inspect with task_read, then call task_recovery({ task_id: "${child.id}", resolution: "failed" | "closed", reason: "..." }); continuing requires a new task call with the same task_id]`
                      : ` [partial work preserved — call task_read({ task_id: "${child.id}" }) to recover]`
                    : state === "failed" || state === "error"
                      ? ` [call task_read({ task_id: "${child.id}" }) to inspect partial work]`
                      : ""

                return `- [${state}] ${agentType}${title}${duration} id=${child.id}${recoverHint}`
              })

              return {
                count: lines.length,
                output:
                  lines.length === 0
                    ? "No subagent tasks dispatched by this session."
                    : [`${lines.length} subagent task(s) dispatched by this session:`, ...lines].join("\n"),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
