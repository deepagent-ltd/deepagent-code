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

import { Data, Effect, Schedule } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable, TaskRunEventTable, SessionTable } from "@deepagent-code/core/session/sql"
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm"
import { Identifier } from "@/id/id"
import type { SessionID } from "@/session/schema"
import { TaskConcurrency } from "@/tool/task-concurrency"
import { CONTROL_PLANE_OWNER, recordTerminalReceiptInTransaction } from "@/tool/task-run"

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
export function enqueueRun(input: { readonly runID: string; readonly runVersion: number; readonly now?: number }) {
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
  readonly parentSessionID: SessionID
  readonly claimGeneration: number
  readonly leaseExpiresAt: number
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
 *   2. CAS: queued → provisioning, increment claim_generation, set owner + lease
 *   3. If CAS is lost, try the next candidate
 *
 * The production dispatch loop invokes this only while holding a TaskConcurrency permit.
 * Direct callers are responsible for their own execution-capacity policy.
 */
export function claimRun(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly parentSessionID?: SessionID
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
        generation: TaskRunTable.generation,
        child_session_id: TaskRunTable.child_session_id,
        parent_session_id: TaskRunTable.parent_session_id,
        claim_generation: TaskRunTable.claim_generation,
        start_attempts: TaskRunTable.start_attempts,
        control_state: TaskRunTable.control_state,
      })
      .from(TaskRunTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
      .where(
        and(
          eq(SessionTable.directory, input.directory),
          input.parentSessionID ? eq(TaskRunTable.parent_session_id, input.parentSessionID) : undefined,
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
      // B-5 (P1-5): exhausted pre-start attempts → atomic terminal transition to "failed"
      // instead of silently skipping (which leaves the row queued forever).
      if ((candidate.start_attempts ?? 0) >= maxPrestart) {
        const exhaustedNow = input.now ?? Date.now()
        const exhaustedError = {
          code: "prestart_attempts_exhausted",
          message: "The task exhausted its pre-start attempts before execution began.",
        }
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .update(TaskRunTable)
                  .set({
                    state: "failed",
                    phase: "settled",
                    control_state: "closed",
                    reason: "prestart_attempts_exhausted",
                    error: exhaustedError,
                    version: candidate.version + 1,
                    time_updated: exhaustedNow,
                    time_settled: exhaustedNow,
                  })
                  .where(
                    and(
                      eq(TaskRunTable.run_id, candidate.run_id),
                      eq(TaskRunTable.version, candidate.version),
                      eq(TaskRunTable.state, "queued"),
                    ),
                  )
                  .returning({ run_id: TaskRunTable.run_id, version: TaskRunTable.version })
                  .get()
                  .pipe(Effect.orDie)
                if (!row) return
                yield* tx
                  .insert(TaskRunEventTable)
                  .values({
                    event_id: Identifier.ascending("event"),
                    run_id: candidate.run_id,
                    version: row.version,
                    type: "run_settled",
                    from_state: "queued",
                    to_state: "failed",
                    reason: "prestart_attempts_exhausted",
                    time_created: exhaustedNow,
                  })
                  .run()
                  .pipe(Effect.orDie)
                yield* recordTerminalReceiptInTransaction(tx, {
                  run: {
                    runID: candidate.run_id,
                    parentSessionID: candidate.parent_session_id,
                    childSessionID: candidate.child_session_id,
                    generation: candidate.generation,
                  },
                  state: "failed",
                  reason: "prestart_attempts_exhausted",
                  error: exhaustedError,
                  ownerToken: CONTROL_PLANE_OWNER,
                  now: exhaustedNow,
                })
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.tapError((error) => Effect.logWarning("task.prestart.settle_conflict", { error })),
            Effect.ignore,
          )
        continue
      }

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

      const newClaimGen = (candidate.claim_generation ?? 0) + 1

      // Wrap CAS + event in one IMMEDIATE transaction so a crash between the two
      // cannot leave the run in provisioning without an audit event (design §1.3 #24).
      const claimed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const updated = yield* tx
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

              yield* tx
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
          { behavior: "immediate" },
        )
        .pipe(Effect.orElseSucceed(() => undefined))

      if (claimed) {
        return {
          runID: claimed.run_id,
          childSessionID: claimed.child_session_id,
          parentSessionID: candidate.parent_session_id,
          claimGeneration: claimed.claim_generation ?? 1,
          leaseExpiresAt: claimed.lease_expires_at ?? now + leaseMs,
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
 *
 * A non-blocking capacity permit is acquired before claim and held for the full executor
 * lifecycle. A full limiter leaves the row queued and does not accumulate waiting fibers.
 */
export function dispatchRunIfCapacity(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly maxPrestartAttempts?: number
  readonly onClaimed: (claim: ClaimResult) => Effect.Effect<void, never, never>
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const candidate = yield* db
      .select({ parentSessionID: TaskRunTable.parent_session_id })
      .from(TaskRunTable)
      .innerJoin(SessionTable, eq(SessionTable.id, TaskRunTable.parent_session_id))
      .where(
        and(
          eq(SessionTable.directory, input.directory),
          eq(TaskRunTable.state, "queued"),
          eq(TaskRunTable.control_state, "open"),
          lte(TaskRunTable.available_at, Date.now()),
        ),
      )
      .orderBy(desc(TaskRunTable.priority), asc(TaskRunTable.time_created), asc(TaskRunTable.generation))
      .get()
      .pipe(Effect.orDie)
    if (!candidate) return

    const claimAndExecute = Effect.gen(function* () {
      const claim = yield* claimRun({
        ownerToken: input.ownerToken,
        directory: input.directory,
        parentSessionID: candidate.parentSessionID,
        maxPrestartAttempts: input.maxPrestartAttempts,
      }).pipe(Effect.orElseSucceed(() => undefined as ClaimResult | undefined))
      if (claim) yield* input.onClaimed(claim)
    })

    return yield* TaskConcurrency.withTaskSlotIfAvailable({
      parentSessionID: candidate.parentSessionID,
      subagentType: "task",
      caps: undefined,
      effect: claimAndExecute,
    })
  })
}

export function startDispatchLoop(input: {
  readonly ownerToken: string
  readonly directory: string
  readonly intervalMs?: number
  readonly maxPrestartAttempts?: number
  readonly onClaimed: (claim: ClaimResult) => Effect.Effect<void, never, never>
}) {
  const tick = dispatchRunIfCapacity(input).pipe(Effect.forkScoped, Effect.asVoid)

  return Effect.repeat(tick, Schedule.fixed(input.intervalMs ?? 500)).pipe(Effect.asVoid)
}

export * as TaskDispatcher from "./task-dispatcher"
