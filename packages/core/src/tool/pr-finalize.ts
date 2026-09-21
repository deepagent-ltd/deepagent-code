export * as PRFinalizeTool from "./pr-finalize"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { TaskPRReview } from "../session/task-pr-review"
import { Delegation } from "./delegation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "pr_finalize"

const DESCRIPTION =
  "Review and integrate completed write-isolated (worktree) subagent tasks from this session. Each retained branch is " +
  "reviewed by a durable reviewer run whose structured verdict is sealed as evidence; approved work merges into the " +
  "parent branch (fast-forward or merge commit) and the branch is cleaned up, changes-requested work retains its " +
  "branch. Call once after isolated write tasks have finished. Idempotent: re-calling converges on in-flight cycles."

const Input = Schema.Struct({
  run_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional isolated task run ids to finalize. Omit to process every review-eligible completed isolated run of this session.",
  }),
})

const PR = Schema.Struct({
  runID: Schema.String,
  prID: Schema.String,
  status: Schema.Literals(["merged", "changes_requested", "rejected", "converged"]),
  mode: Schema.optional(Schema.Literals(["fast_forward", "merge_commit", "already_merged"])),
  rationale: Schema.optional(Schema.String),
})

const Output = Schema.Struct({
  prs: Schema.Array(PR),
  output: Schema.String,
})

const REVIEW_TIMEOUT_MS = 30 * 60_000

/**
 * WS4b-S2 port of the legacy pr_finalize: a thin submit/await over the Core TaskPRReview
 * authority. The tool collects this session's terminal isolated runs with retained branches and
 * runs each through the durable CAS flow — reviewer run admitted on the V2 authority, verdict
 * bound by the structured-output evidence authority, merge on the retained branch, branch
 * cleanup — and reports the receipts. It holds no orchestration of its own: a crash retry
 * re-enters the same deterministic PR cycle and converges.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (input, context) =>
            Effect.gen(function* () {
              const slot = Option.getOrUndefined(yield* Effect.serviceOption(Delegation.DelegationSlot))
              const sessions = slot?.service
              if (!sessions)
                return yield* new ToolFailure({
                  message:
                    "pr_finalize is unavailable: the root composition did not capture the V2 session service for delegation",
                })
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
              if (!database || !events)
                return yield* new ToolFailure({
                  message:
                    "pr_finalize is unavailable: durable authority services missing from the runner context " +
                    `(database: ${database ? "ok" : "missing"}, events: ${events ? "ok" : "missing"})`,
                })
              const db = database.db

              const parent = yield* sessions.get(context.sessionID).pipe(
                Effect.mapError(
                  () =>
                    new ToolFailure({
                      message: `Parent session ${context.sessionID} is not visible to the V2 session store`,
                    }),
                ),
              )
              if (parent.parentID !== undefined)
                return yield* new ToolFailure({ message: "Only a primary session may finalize PRs" })

              // Explicit ids re-drive their cycles (an in-flight or decided cycle converges
              // through review()); omitted ids process every review-eligible run of this session.
              const eligible = yield* TaskPRReview.eligible(db, { parentSessionID: parent.id })
              const targets = input.run_ids === undefined ? eligible.map((row) => row.run_id) : input.run_ids
              if (targets.length === 0)
                return {
                  prs: [],
                  output: "No review-eligible isolated task runs are queued for this session.",
                }

              yield* permission
                .assert({
                  action: name,
                  resources: targets,
                  save: targets,
                  metadata: { run_ids: targets },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.mapError((error) => {
                    const refusal = PermissionV2.permissionToolFailure(error)
                    if (refusal !== null) return refusal
                    return new ToolFailure({ message: `pr_finalize: permission check failed (${String(error)})` })
                  }),
                )

              const prs: Array<typeof PR.Type> = []
              for (const runID of targets) {
                const outcome = yield* TaskPRReview.review(db, events, sessions, {
                  runID,
                  parentMessageID: context.assistantMessageID,
                  parentDirectory: parent.location.directory,
                  timeoutMs: REVIEW_TIMEOUT_MS,
                }).pipe(
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({
                        message:
                          `[${error.code}] ${error.message} ` +
                          `Task run: ${runID}. Partial PR state is preserved; re-call pr_finalize to retry.`,
                      }),
                  ),
                )
                prs.push({
                  runID,
                  prID: outcome.prID,
                  status: outcome.status,
                  ...(outcome.status === "merged" ? { mode: outcome.mode } : {}),
                  ...(outcome.status === "changes_requested" || outcome.status === "rejected"
                    ? { rationale: outcome.rationale }
                    : {}),
                })
              }
              return { prs, output: JSON.stringify(prs) }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
