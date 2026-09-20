import { Effect, Option, Schema } from "effect"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { TaskPRReview } from "@deepagent-code/core/session/task-pr-review"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Tool } from "./tool"

const id = "pr_finalize"

const Parameters = Schema.Struct({
  run_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional isolated task run ids to finalize. Omit to process every review-eligible completed isolated run of this session.",
  }),
})

type FinalizedPR = {
  readonly runID: string
  readonly prID: string
  readonly status: "merged" | "changes_requested" | "rejected" | "converged"
  readonly mode?: "fast_forward" | "merge_commit" | "already_merged"
  readonly rationale?: string
}

/**
 * The V2 face of PR finalization: a thin submit/await over the Core TaskPRReview authority
 * (mirroring how the app task tool became thin over TaskRunAuthority). The tool collects this
 * session's terminal isolated runs with retained branches and runs each through the durable
 * CAS flow — reviewer run admitted on the V2 authority, verdict bound by the structured-output
 * evidence authority, merge on the retained branch, branch cleanup — and reports the receipts.
 * It holds no orchestration of its own: a crash retry re-enters the same deterministic PR cycle
 * and converges.
 */
export const PRFinalizeTool = Tool.define(
  id,
  Effect.gen(function* () {
    const database = yield* Database.Service

    return {
      description:
        "Review and integrate completed write-isolated (worktree) subagent tasks from this session. Each retained branch is reviewed by a durable reviewer run whose structured verdict is sealed as evidence; approved work merges into the parent branch (fast-forward or merge commit) and the branch is cleaned up, changes-requested work retains its branch. Call once after isolated write tasks have finished. Idempotent: re-calling converges on in-flight cycles.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // The V2 services are resolved per call (the tool registry builds before sibling layers
          // are visible); the same read-at-execute-time pattern as the app task tool.
          const events =
            Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service)) ??
            Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
          const v2Sessions = Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service))
          if (!events || !v2Sessions)
            return yield* Effect.fail(
              new Error(
                "pr_finalize is unavailable: the V2 session runtime is missing from this composition; " +
                  "durable PR review requires the single V2 authority",
              ),
            )
          const parent = yield* v2Sessions.get(ctx.sessionID).pipe(
            Effect.mapError(() => new Error(`Parent session ${ctx.sessionID} is not visible to the V2 session store`)),
          )
          if (parent.parentID) return yield* Effect.fail(new Error("Only a primary session may finalize PRs"))

          // Explicit ids re-drive their cycles (an in-flight or decided cycle converges through
          // review()); omitted ids process every review-eligible run of this session.
          const eligible = yield* TaskPRReview.eligible(database.db, { parentSessionID: parent.id })
          const targets =
            params.run_ids === undefined ? eligible.map((row) => row.run_id) : params.run_ids
          if (targets.length === 0) {
            return {
              title: "PR review",
              metadata: { prs: [] } satisfies { prs: readonly FinalizedPR[] },
              output: "No review-eligible isolated task runs are queued for this session.",
            }
          }

          yield* ctx.ask({
            permission: id,
            patterns: targets,
            always: targets,
            metadata: { run_ids: targets },
          })

          const prs: FinalizedPR[] = []
          for (const runID of targets) {
            const outcome = yield* TaskPRReview.review(database.db, events, v2Sessions, {
              runID,
              parentMessageID: String(ctx.messageID),
              parentDirectory: String(parent.location.directory),
              timeoutMs: 30 * 60_000,
            }).pipe(
              Effect.mapError(
                (error) =>
                  new Error(
                    `[${error.code}] ${error.message} ` +
                      `Task run: ${runID}. Partial PR state is preserved; re-call pr_finalize to retry.`,
                  ),
              ),
            )
            prs.push({ runID, ...outcome })
          }
          return {
            title: "PR review complete",
            metadata: { prs } satisfies { prs: readonly FinalizedPR[] },
            output: JSON.stringify(prs),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
