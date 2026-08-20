// BUG-407-012 gap C (conservative §8.3-3/4): provider pre-dispatch deadline watchdog.
// A turn stuck between "legacy activity claimed" and "provider receipt created" has no
// durable receipt for the existing outcome-unknown recovery to act on. When the opt-in
// flag is enabled, this sweep fails such stale activities through the EXISTING
// terminalization path (SessionPromptIntent.finalizeActivityWithoutRevision) with a typed
// terminal reason, so an exact retry remains possible. No new recovery states are
// introduced. Activities that already have durable receipt/dispatch evidence are never
// touched — the existing outcome-unknown recovery stays authoritative for those.
import { and, eq, gte, lte } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionLegacyActivityRunTable, SessionLegacyActivityTable } from "./activity-sql"
import { SessionToolRequestReceiptTable } from "./tool-request-receipt.sql"
import { SessionPromptIntent } from "./prompt-intent"
import { TurnStageEvidence } from "./turn-stage-evidence"

export namespace TurnDeadlineWatchdog {
  export const ReasonCode = "provider_pre_dispatch_deadline_exceeded"

  export type Outcome =
    | { readonly kind: "failed"; readonly activityID: string; readonly runID: string }
    | { readonly kind: "skipped"; readonly activityID: string; readonly reason: string }

  export interface SweepInput {
    readonly database: Database.Interface
    readonly deadlineMs: number
    readonly now?: number
  }

  // Stages that prove the turn already reached request preparation or beyond — their
  // presence means durable dispatch-side evidence exists (or existed), so the watchdog
  // must leave the activity to the outcome-unknown recovery path.
  const dispatchEvidenceStages = new Set<string>([
    "request_prepared",
    "provider_dispatch_started",
    "terminal_settled",
  ])

  const settleOne = (
    input: SweepInput,
    activity: typeof SessionLegacyActivityTable.$inferSelect,
  ) =>
    Effect.gen(function* () {
      const db = input.database.db
      const run = yield* db
        .select()
        .from(SessionLegacyActivityRunTable)
        .where(
          and(
            eq(SessionLegacyActivityRunTable.activity_id, activity.activity_id),
            lte(SessionLegacyActivityRunTable.started_at, input.now ?? Date.now()),
          ),
        )
        .all()
      const liveRun = run.find((candidate) => candidate.state === "running" || candidate.state === "finalizing")
      if (!liveRun) return { kind: "skipped", activityID: activity.activity_id, reason: "no_live_run" }
      const receipt = yield* db
        .select({ receipt_id: SessionToolRequestReceiptTable.receipt_id })
        .from(SessionToolRequestReceiptTable)
        .where(
          and(
            eq(SessionToolRequestReceiptTable.session_id, activity.session_id),
            gte(SessionToolRequestReceiptTable.created_at, activity.created_at),
          ),
        )
        .get()
      if (receipt) return { kind: "skipped", activityID: activity.activity_id, reason: "receipt_present" }
      const stageEvidence = yield* TurnStageEvidence.latest(db, {
        sessionID: activity.session_id,
        activityID: activity.activity_id,
      })
      if (stageEvidence && dispatchEvidenceStages.has(stageEvidence.stage))
        return { kind: "skipped", activityID: activity.activity_id, reason: "stage_evidence_present" }
      const runIdentity: SessionPromptIntent.RunIdentity = {
        runID: liveRun.run_id,
        activityID: activity.activity_id,
        sessionID: liveRun.session_id as SessionPromptIntent.RunIdentity["sessionID"],
        mutationEpoch: liveRun.mutation_epoch,
        generation: liveRun.generation,
        ownerToken: liveRun.owner_token,
      }
      // Reuse the existing boundary freeze: it refuses to settle while a steer is still
      // pending for this activity (kind: "pending_steer" -> leave it to the live loop).
      const boundary = yield* SessionPromptIntent.freezeProviderInputBoundary(runIdentity).pipe(
        Effect.provideService(Database.Service, input.database),
        Effect.catchTag("SessionPromptIntent.Conflict", () =>
          Effect.succeed({ kind: "pending_steer" } as const),
        ),
      )
      if (boundary.kind !== "ready")
        return { kind: "skipped", activityID: activity.activity_id, reason: boundary.kind }
      const result = yield* SessionPromptIntent.finalizeActivityWithoutRevision({
        run: runIdentity,
        membershipOrdinal: boundary.boundary.membershipOrdinal,
        decision: {
          state: "failed",
          reasonCode: ReasonCode,
          source: "same_process_recovery",
          operationID: `${liveRun.run_id}:${ReasonCode}`,
          ownerToken: liveRun.owner_token,
        },
      }).pipe(
        Effect.provideService(Database.Service, input.database),
        Effect.catchTag("SessionPromptIntent.Conflict", () => Effect.succeed(undefined)),
      )
      if (!result) return { kind: "skipped", activityID: activity.activity_id, reason: "terminal_conflict" }
      if (result.kind === "follow_up_required")
        return { kind: "skipped", activityID: activity.activity_id, reason: "follow_up_required" }
      // Record-only evidence so diagnostics show the watchdog settled the turn.
      yield* TurnStageEvidence.record(db, {
        sessionID: activity.session_id,
        activityID: activity.activity_id,
        stage: "terminal_settled",
        details: { reasonCode: ReasonCode, via: "pre_dispatch_deadline_watchdog" },
      })
      return { kind: "failed", activityID: activity.activity_id, runID: liveRun.run_id }
    })

  // One sweep pass. Never throws: per-activity failures degrade to a skipped outcome.
  export const sweep = (input: SweepInput) =>
    Effect.gen(function* () {
      const db = input.database.db
      const now = input.now ?? Date.now()
      const stale = yield* db
        .select()
        .from(SessionLegacyActivityTable)
        .where(and(eq(SessionLegacyActivityTable.state, "active"), lte(SessionLegacyActivityTable.created_at, now - input.deadlineMs)))
        .all()
      return yield* Effect.forEach(
        stale,
        (activity) =>
          settleOne(input, activity).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                kind: "skipped",
                activityID: activity.activity_id,
                reason: `sweep_error: ${String(cause)}`,
              } satisfies Outcome),
            ),
          ),
        { concurrency: 1 },
      )
    })
}
