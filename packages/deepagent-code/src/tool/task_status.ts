import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { Effect, Schema } from "effect"

const id = "task_status"

const DESCRIPTION = [
  "List the subagent tasks this session has dispatched (via the task tool), oldest first.",
  "For each: status (running/completed/error/cancelled), agent type, title, elapsed time, and session/job id.",
  "Use it to check on a subagent that has not reported back before deciding to wait, retry, or take over.",
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

/**
 * v4.0.4 块1 (1c): model-callable, READ-ONLY view over the BackgroundJob registry so the parent
 * agent can check on subagents it dispatched (a hung subagent that never reports back is otherwise
 * invisible). Jobs are filtered to the CURRENT session via metadata.parentSessionId — other
 * sessions' tasks are never exposed. No timeout/takeover behavior is gated here; listing works
 * regardless of flags.
 */
export const TaskStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    const run = Effect.fn("TaskStatusTool.execute")(function* (
      _params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const jobs = (yield* background.list()).filter((job) => job.metadata?.parentSessionId === ctx.sessionID)
      const now = Date.now()
      const lines = jobs.map((job) => {
        const duration = formatDuration((job.completed_at ?? now) - job.started_at)
        const title = job.title ? ` "${job.title}"` : ""
        // Prefer the real subagent type (researcher/reviewer/…) recorded in metadata; fall back to the
        // BackgroundJob type only if a job predates the metadata (always "task" there, so uninformative).
        const rawType = job.metadata?.subagentType
        const agentType = typeof rawType === "string" && rawType.length > 0 ? rawType : job.type
        return `- [${job.status}] ${agentType}${title} (${duration}) id=${job.id}`
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
