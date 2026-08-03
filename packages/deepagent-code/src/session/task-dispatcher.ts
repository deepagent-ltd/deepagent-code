/**
 * TaskDispatcher — process-local durable queue daemon.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.4, §6.2, §6.3, §9.2
 *
 * The durable queue in task_run is the authority; this process-local daemon drains it.
 * It does NOT execute provider work — it claims provisioning and hands off to LegacySubagentExecutor.
 *
 * Invariants:
 *   - durable queue is truth; this daemon is replaceable
 *   - capacity permit is acquired BEFORE durable CAS claim
 *   - if claim CAS fails after permit acquired, permit is released immediately
 *   - same child_session_id never has two active (provisioning/running/finalizing) runs
 */

import { Data, Effect, Schedule, Scope, pipe } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable, TaskRunEventTable, SessionTable } from "@deepagent-code/core/session/sql"
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { TaskConcurrency } from "@/tool/task-concurrency"
import type { Run } from "@/tool/task-run"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DispatcherCapacityExceeded extends Data.TaggedError("TaskDispatcher.CapacityExceeded")<{
  readonly runID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// enqueueRun — admitted → queued
// Design §6.2
// ---------------------------------------------------------------------------

/**
 * Transition a run from "admitted" to "queued".
 * Safe to call multiple times — if CAS lost, returns undefined (no error).
 */
export function enqueueRun(input: {
  readonly runID: string
  readonly runVersion: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "queued",
              phase: "queue",
              available_at: now,
              version: input.runVersion + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, input.runVersion),
                eq(TaskRunTable.state, "admitted"),
                eq(TaskRunTable.control_state, "open"),
              ),
            )
            .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)

          if (!updated) return undefined

          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "run_queued",
              from_state: "admitted",
              to_state: "queued",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)

          return input.runID
        }),
      { behavior: "immediate" },
    )
  })
}

// ---------------------------------------------------------------------------
// Claim result
// ---------------------------------------------------------------------------

export type ClaimResult = {
  readonly runID: string
  readonly childSessionID: string
  readonly claimGeneration: number
  readonly leaseExpiresAt: number
  readonly releaseConcurrency: () => void
}

// ---------------------------------------------------------------------------
// claimRun — queued → provisioning with capacity permit
// Design §6.3
// ---------------------------------------------------------------------------

/**
 * Scan for a claimable queued run and atomically claim it.
 *
 * Steps:
 *   1. Read candidate rows from task_run (queued, past available_at, no active sibling)
 *   2. Acquire TaskConcurrency permit for the parent session
 *   3. CAS: queued → provisioning, increment claim_generation, set owner + lease
 *   4. If CAS lost (race): release permit, try next candidate
 *
 * Returns undefined if no claimable run is available.
 */
export function claimRun(input: {
  readonly ownerToken: string
  readonly leaseMs?: number
  readonly maxPrestartAttempts?: number
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    const leaseMs = input.leaseMs ?? 30_000
    const maxPrestart = input.maxPrestartAttempts ?? 3

    // Find candidate queued runs ordered by priority (desc), time_created (asc)
    const candidates = yield* db
      .select({
        run_id: TaskRunTable.run_id,
        version: TaskRunTable.version,
        child_session_id: TaskRunTable.child_session_id,
        parent_session_id: TaskRunTable.parent_session_id,
        claim_generation: TaskRunTable.claim_generation,
        start_attempts: TaskRunTable.start_attempts,
        control_state: TaskRunTable.control_state,
      })
      .from(TaskRunTable)
      .where(
        and(
          eq(TaskRunTable.state, "queued"),
          eq(TaskRunTable.control_state, "open"),
          lte(TaskRunTable.available_at, now),
        ),
      )
      .orderBy(desc(TaskRunTable.priority), asc(TaskRunTable.time_created), asc(TaskRunTable.generation))
      .limit(10)
      .all()
      .pipe(Effect.orDie)

    for (const candidate of candidates) {
      // Skip if pre-start attempts exhausted
      if ((candidate.start_attempts ?? 0) >= maxPrestart) continue

      // Skip if same child already has an active run
      const activeForChild = yield* db
        .select({ run_id: TaskRunTable.run_id })
        .from(TaskRunTable)
        .where(
          and(
            eq(TaskRunTable.child_session_id, candidate.child_session_id),
            inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (activeForChild) continue

      // Try to acquire concurrency permit and CAS claim in one scoped Effect
      let releaseRef: (() => void) | undefined

      const claimed = yield* TaskConcurrency.withTaskSlot({
        parentSessionID: candidate.parent_session_id,
        subagentType: "task",
        caps: undefined,
        effect: Effect.gen(function* () {
          releaseRef = () => {} // permit is held by the outer withTaskSlot scope

          const newClaimGen = (candidate.claim_generation ?? 0) + 1
          const updated = yield* db
            .update(TaskRunTable)
            .set({
              state: "provisioning",
              phase: "provision",
              claim_generation: newClaimGen,
              start_attempts: sql`${TaskRunTable.start_attempts} + 1`,
              execution_owner: input.ownerToken,
              lease_expires_at: now + leaseMs,
              version: candidate.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, candidate.run_id),
                eq(TaskRunTable.version, candidate.version),
                eq(TaskRunTable.state, "queued"),
                eq(TaskRunTable.control_state, "open"),
              ),
            )
            .returning({
              run_id: TaskRunTable.run_id,
              version: TaskRunTable.version,
              claim_generation: TaskRunTable.claim_generation,
              lease_expires_at: TaskRunTable.lease_expires_at,
              child_session_id: TaskRunTable.child_session_id,
            })
            .get()
            .pipe(Effect.orDie)

          if (!updated) return undefined

          yield* db
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: candidate.run_id,
              version: updated.version,
              type: "run_claimed",
              from_state: "queued",
              to_state: "provisioning",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)

          return updated
        }),
      }).pipe(Effect.orElseSucceed(() => undefined))

      if (claimed) {
        return {
          runID: claimed.run_id,
          childSessionID: claimed.child_session_id,
          claimGeneration: claimed.claim_generation ?? 1,
          leaseExpiresAt: claimed.lease_expires_at ?? now + leaseMs,
          releaseConcurrency: releaseRef ?? (() => {}),
        } satisfies ClaimResult
      }
    }

    return undefined
  })
}

// ---------------------------------------------------------------------------
// startDispatchLoop — long-running daemon
// Design §3.4
// ---------------------------------------------------------------------------

/**
 * Process-local dispatcher daemon.
 * Runs claimRun on a fixed interval until the Scope closes.
 * Does NOT start execution — callers provide the executor callback.
 */
export function startDispatchLoop(input: {
  readonly ownerToken: string
  readonly intervalMs?: number
  readonly maxPrestartAttempts?: number
  readonly onClaimed: (claim: ClaimResult) => Effect.Effect<void, never, never>
}) {
  const tick = Effect.gen(function* () {
    const claim = yield* claimRun({
      ownerToken: input.ownerToken,
      maxPrestartAttempts: input.maxPrestartAttempts,
    }).pipe(Effect.orElseSucceed(() => undefined as ClaimResult | undefined))
    if (claim) {
      yield* input.onClaimed(claim).pipe(Effect.forkScoped, Effect.asVoid)
    }
  })

  return Effect.repeat(
    tick,
    Schedule.fixed(input.intervalMs ?? 500),
  ).pipe(Effect.asVoid)
}

// ---------------------------------------------------------------------------
// recoverOnStartup — classify lost runs at process restart
// Design §11.2
// ---------------------------------------------------------------------------

/**
 * Called once at process startup before new admissions are accepted.
 * Classifies all provisioning/running/finalizing runs as recovery_required or re-queues them.
 */
export function recoverOnStartup(input: {
  readonly directory: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    const candidates = yield* db
      .select({ run: TaskRunTable })
      .from(TaskRunTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
      .where(
        and(
          eq(SessionTable.directory, input.directory),
          inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)

    let classified = 0
    let requeued = 0

    for (const { run } of candidates) {
      const canRequeue =
        run.state === "provisioning" &&
        (run.input_state === "ready" || run.input_state === "pending") &&
        !run.execution_started_at

      if (canRequeue) {
        // Safe to re-enqueue: loop was never called
        const updated = yield* db
          .update(TaskRunTable)
          .set({
            state: "queued",
            phase: "queue",
            execution_owner: null,
            lease_expires_at: null,
            available_at: now,
            version: (run.version ?? 0) + 1,
            time_updated: now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, run.run_id),
              eq(TaskRunTable.version, run.version ?? 0),
            ),
          )
          .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
          .get()
          .pipe(Effect.orDie)
        if (updated) {
          yield* db
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: run.run_id,
              version: updated.version,
              type: "run_requeued_on_startup",
              from_state: run.state,
              to_state: "queued",
              reason: "safe_requeue_on_startup",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          requeued++
        }
      } else {
        // Provider may have been called — must not auto-replay
        const reason =
          run.input_state === "admitting"
            ? "input_admission_outcome_unknown"
            : "execution_owner_lost"

        const updated = yield* db
          .update(TaskRunTable)
          .set({
            state: "recovery_required",
            execution_owner: null,
            lease_expires_at: null,
            version: (run.version ?? 0) + 1,
            time_updated: now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, run.run_id),
              eq(TaskRunTable.version, run.version ?? 0),
            ),
          )
          .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
          .get()
          .pipe(Effect.orDie)
        if (updated) {
          yield* db
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: run.run_id,
              version: updated.version,
              type: "recovery_required",
              from_state: run.state,
              to_state: "recovery_required",
              reason,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          classified++
        }
      }
    }

    return { classified, requeued }
  })
}

export * as TaskDispatcher from "./task-dispatcher"
