import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import type { SessionID } from "@/session/schema"

const id = "task_status"

const DESCRIPTION = [
  "List the subagent tasks this session has dispatched (via the task tool), oldest first.",
  "For each: session ID, status (running/completed/error/interrupted/cancelled), agent type, title, elapsed time.",
  "Uses durable child-session records as the authoritative source so results survive process restarts.",
  "Live elapsed time is overlaid from the current process's BackgroundJob registry when available.",
  "Use it to check on a subagent before deciding to wait, retry, take over, or call task_read to recover partial work.",
  "Read-only: it never starts, cancels, or modifies tasks.",
].join(" ")

const Parameters = Schema.Struct({})

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

function formatAge(ts: number): string {
  return formatDuration(Date.now() - ts)
}

/**
 * §4.4: durable task_status — two-layer merge.
 *
 * Layer 1 (authoritative): Session.children(parentID) — durable DB records. Survives process
 * restarts and gives the canonical terminal state written by task.ts markFinished.
 *
 * Layer 2 (advisory): BackgroundJob.list() — current-process live jobs. Overlays elapsed time
 * and "running" status for jobs that haven't written their terminal marker yet.
 *
 * Backward compat: old child sessions with no subagent metadata are shown as "unknown" state,
 * not silently omitted or shown as "running" (which would be misleading).
 */
export const TaskStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskStatusTool.execute")(function* (
      _params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const now = Date.now()

      // Layer 1: durable child sessions from DB.
      const children = yield* sessions.children(ctx.sessionID as SessionID).pipe(
        Effect.catchCause(() => Effect.succeed([] as Session.Info[])),
      )

      // Layer 2: live BackgroundJob overlay (process-local, advisory).
      const liveJobs = yield* background.list().pipe(
        Effect.map((jobs) => {
          const m = new Map<string, (typeof jobs)[number]>()
          for (const job of jobs) {
            if (job.metadata?.parentSessionId === ctx.sessionID) {
              const sessionId = job.metadata?.sessionId ?? job.id
              if (typeof sessionId === "string") m.set(sessionId, job)
            }
          }
          return m
        }),
        Effect.catchCause(() => Effect.succeed(new Map<string, never>())),
      )

      const lines = children.map((child) => {
        const deepagent = child.metadata?.["deepagent"] as Record<string, unknown> | undefined
        const subagent = deepagent?.["subagent"] as Record<string, unknown> | undefined
        const liveJob = liveJobs.get(child.id)

        // Determine durable state from metadata (written by markFinished).
        const durableState = subagent
          ? (subagent["state"] as string | undefined) ??
            // compat: old rows used `finished: true` without state field
            (subagent["finished"] === true ? "completed" : "unknown")
          : "unknown"

        // If a live job is running in the current process, override to "running".
        const state =
          liveJob && liveJob.status === "running" ? "running" : durableState

        // Prefer live job elapsed time; fall back to metadata timestamp.
        const elapsedMs =
          liveJob && state === "running"
            ? now - liveJob.started_at
            : subagent?.["at"]
              ? now - (subagent["at"] as number)
              : undefined
        const duration = elapsedMs !== undefined ? ` (${formatDuration(elapsedMs)})` : ""

        // Agent type and title from session metadata or BackgroundJob.
        const rawType = subagent?.["subagentType"] ?? liveJob?.metadata?.subagentType ?? child.agent ?? "task"
        const agentType = typeof rawType === "string" && rawType.length > 0 ? rawType : "task"
        const title = child.title && !child.title.startsWith("New Conversation") ? ` "${child.title}"` : ""

        // §4.6 recovery hint for interrupted tasks.
        const recoverHint =
          state === "interrupted"
            ? ` [partial work preserved — call task_read({ task_id: "${child.id}" }) to recover]`
            : state === "error"
              ? ` [call task_read({ task_id: "${child.id}" }) to inspect partial work]`
              : ""

        return `- [${state}] ${agentType}${title}${duration} id=${child.id}${recoverHint}`
      })

      const output =
        lines.length === 0
          ? "No subagent tasks dispatched by this session."
          : [`${lines.length} subagent task(s) dispatched by this session:`, ...lines].join("\n")

      return {
        title: "Subagent task status",
        metadata: { count: lines.length },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
