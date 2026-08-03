/**
 * LegacySubagentExecutor — drives one subagent run through SessionPrompt.loop.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.5, §6.4, §6.6, §6.7
 *
 * Invariants:
 *   - CAS provisioning → running before calling SessionPrompt.loop (§6.4)
 *   - If commit succeeds but loop call fails before starting: recovery_required
 *   - One research activity, one optional finalizer activity per run
 *   - Late owner cannot settle (lease/claim_generation guard)
 *   - close/interrupt intent respected during settlement (§6.7 concurrent priority)
 */

import { Cause, Data, Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { SessionID, MessageID } from "@/session/schema"
import { SessionPrompt } from "./prompt"
import type { Run } from "@/tool/task-run"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExecutorClaimLostError extends Data.TaggedError("LegacySubagentExecutor.ClaimLost")<{
  readonly runID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// startExecution — CAS provisioning → running
// Design §6.4: commit BEFORE calling SessionPrompt.loop
// ---------------------------------------------------------------------------

export function startExecution(input: {
  readonly run: Run
  readonly ownerToken: string
  readonly leaseMs?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    const updated = yield* db
      .update(TaskRunTable)
      .set({
        state: "running",
        phase: "research",
        execution_started_at: now,
        lease_expires_at: now + (input.leaseMs ?? 30_000),
        version: input.run.version + 1,
        time_updated: now,
      })
      .where(
        and(
          eq(TaskRunTable.run_id, input.run.runID),
          eq(TaskRunTable.version, input.run.version),
          eq(TaskRunTable.state, "provisioning"),
          eq(TaskRunTable.execution_owner, input.ownerToken),
          eq(TaskRunTable.input_state, "ready"),
          eq(TaskRunTable.control_state, "open"),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)

    if (!updated) {
      return yield* Effect.fail(
        new ExecutorClaimLostError({
          runID: input.run.runID,
          reason: "CAS provisioning→running failed: claim expired, control changed, or input not ready",
        }),
      )
    }

    yield* db
      .insert(TaskRunEventTable)
      .values({
        event_id: Identifier.ascending("event"),
        run_id: input.run.runID,
        version: updated.version,
        type: "execution_started",
        from_state: "provisioning",
        to_state: "running",
        time_created: now,
      })
      .run()
      .pipe(Effect.orDie)

    return updated
  })
}

// ---------------------------------------------------------------------------
// settleRun — terminal settlement (completed/failed/interrupted/closed)
// Design §6.7 concurrent priority
// ---------------------------------------------------------------------------

export function settleRun(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly runVersion: number
  readonly state: "completed" | "failed" | "interrupted" | "cancelled" | "closed"
  readonly reason: string
  readonly output?: string
  readonly rawResultMessageID?: string
  readonly structuredResultMessageID?: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Read current state to apply concurrent-priority rules (§6.7)
            const current = yield* tx
              .select({
                state: TaskRunTable.state,
                control_state: TaskRunTable.control_state,
                interrupt_requested_at: TaskRunTable.interrupt_requested_at,
                close_requested_at: TaskRunTable.close_requested_at,
                version: TaskRunTable.version,
              })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                ),
              )
              .get()
              .pipe(Effect.orDie)

            if (!current) {
              return { won: false as const, reason: "claim_lost" }
            }

            // Apply concurrent-priority: close/interrupt intent overrides normal settle
            let finalState = input.state
            if (current.control_state === "close_requested" || current.control_state === "closed") {
              finalState = "closed"
            } else if (current.interrupt_requested_at && input.state !== "completed") {
              finalState = "interrupted"
            }

            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                state: finalState,
                phase: "settled",
                control_state: "closed",
                output: input.output,
                raw_result_message_id: input.rawResultMessageID ? MessageID.make(input.rawResultMessageID) : null,
                structured_result_message_id: input.structuredResultMessageID ? MessageID.make(input.structuredResultMessageID) : null,
                execution_owner: null,
                lease_expires_at: null,
                version: current.version + 1,
                time_updated: now,
                time_settled: now,
              })
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.version, current.version),
                ),
              )
              .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
              .get()
              .pipe(Effect.orDie)

            if (!updated) return { won: false as const, reason: "version_race" }

            yield* tx
              .insert(TaskRunEventTable)
              .values({
                event_id: Identifier.ascending("event"),
                run_id: input.runID,
                version: updated.version,
                type: "run_settled",
                from_state: current.state,
                to_state: finalState,
                reason: input.reason,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)

            return { won: true as const, finalState }
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

// ---------------------------------------------------------------------------
// run — full executor lifecycle
// Design §3.5
// ---------------------------------------------------------------------------

/**
 * Execute one provisioned run end-to-end.
 * Call after CAS to provisioning and input_state=ready.
 */
export function run(input: {
  readonly run: Run
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly childSessionID: SessionID
  readonly leaseMs?: number
}): Effect.Effect<void, never, Database.Service | SessionPrompt.Service> {
  return Effect.gen(function* () {
    const sessionPrompt = yield* SessionPrompt.Service
    const now = Date.now()

    // 1. CAS provisioning → running (commit before calling loop)
    const startResult = yield* startExecution({
      run: input.run,
      ownerToken: input.ownerToken,
      leaseMs: input.leaseMs,
      now,
    }).pipe(
      Effect.catchTag("LegacySubagentExecutor.ClaimLost", (err) =>
        Effect.logWarning("executor: claim lost before start", { runID: input.run.runID, reason: err.reason }).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.map(() => true),
      Effect.orElseSucceed(() => false as boolean),
    )

    if (!startResult) return

    // 2. Call SessionPrompt.loop — this is the legacy activity boundary
    // If the process dies after commit but before this call: recovery_required on restart
    const loopResult = yield* sessionPrompt
      .loop({ sessionID: input.childSessionID })
      .pipe(
        Effect.map((msg) => ({ ok: true as const, message: msg })),
        Effect.catchCause((cause) =>
          Effect.succeed({ ok: false as const, error: Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : "loop_error" }),
        ),
      )

    const settleState = loopResult.ok ? ("completed" as const) : ("failed" as const)
    const settleReason = loopResult.ok ? "text_output_valid" : (loopResult.error ?? "loop_error")

    // 3. Settle the run
    yield* settleRun({
      runID: input.run.runID,
      ownerToken: input.ownerToken,
      claimGeneration: input.claimGeneration,
      runVersion: input.run.version + 1, // incremented by startExecution
      state: settleState,
      reason: settleReason,
      rawResultMessageID: loopResult.ok ? (loopResult.message?.info?.id as string | undefined) : undefined,
      now: Date.now(),
    }).pipe(Effect.ignore)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("executor: unexpected defect", { runID: input.run.runID, cause: Cause.pretty(cause) }),
    ),
  )
}

export * as LegacySubagentExecutor from "./task-executor"
