/**
 * LegacySubagentExecutor — drives one subagent run through SessionPrompt.loop.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.5, §6.4, §6.6, §6.7
 *
 * Production-level guarantees (补强于初版):
 *   1. loopFn 注入 — 消除对 SessionPrompt.Service 的循环依赖
 *   2. startExecution CAS — provisioning→running 在 loop 调用前提交（§6.4）
 *   3. Lease renewal — loop 执行期间后台续租，默认每 10s 续一次
 *   4. Interrupt check — 每轮读取 interrupt_requested_at，fiber 收到信号后
 *      优先结算为 interrupted（§6.7 concurrent priority）
 *   5. Background outbox — background delivery_mode 时 settlement 同事务写入通知行
 *   6. CAS version guard — settleRun 用 claim_generation fence，迟到 owner 无法覆盖
 *   7. recovery_required gap — startExecution commit 后进程崩溃，classifyOnStartup 在
 *      下次启动时识别 execution_started_at IS NOT NULL → recovery_required（§11.2 已实现）
 */

import { Cause, Data, Duration, Effect, Fiber, Schedule } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable, TaskRunEventTable, TaskNotificationOutboxTable, SessionTable } from "@deepagent-code/core/session/sql"
import { and, eq, gt, inArray } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { SessionID, MessageID } from "@/session/schema"
import type { ClaimResult } from "@/session/task-dispatcher"
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
// Design §6.4: commit MUST happen before calling loopFn so that a process crash
// after the commit but before the loop call is classified as recovery_required on restart.
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

    // CAS state transition and event insert must be co-transactional (design §1.3 #24).
    // If the process dies between UPDATE and INSERT we lose the audit event but the state
    // is still consistent. Wrapping in one IMMEDIATE transaction makes both atomic.
    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const updated = yield* tx
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
                  eq(TaskRunTable.claim_generation, input.run.claimGeneration),
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
                  reason: "CAS provisioning→running failed: claim expired, wrong generation, control changed, or input not ready",
                }),
              )
            }

            yield* tx
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
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

// ---------------------------------------------------------------------------
// renewLease — heartbeat while loop is running
// ---------------------------------------------------------------------------

function renewLease(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly leaseMs: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .update(TaskRunTable)
      .set({ lease_expires_at: now + input.leaseMs, time_updated: now })
      .where(
        and(
          eq(TaskRunTable.run_id, input.runID),
          eq(TaskRunTable.execution_owner, input.ownerToken),
          eq(TaskRunTable.claim_generation, input.claimGeneration),
          inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

// ---------------------------------------------------------------------------
// checkInterrupt — read interrupt intent from DB
// ---------------------------------------------------------------------------

function checkInterrupt(runID: string, ownerToken: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({
        interrupt_requested_at: TaskRunTable.interrupt_requested_at,
        interrupt_reason: TaskRunTable.interrupt_reason,
        control_state: TaskRunTable.control_state,
      })
      .from(TaskRunTable)
      .where(
        and(
          eq(TaskRunTable.run_id, runID),
          eq(TaskRunTable.execution_owner, ownerToken),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return {
      interrupted: !!(row?.interrupt_requested_at),
      closed: row?.control_state === "closed" || row?.control_state === "close_requested",
      reason: row?.interrupt_reason ?? "human_interrupted",
    }
  })
}

// ---------------------------------------------------------------------------
// settleRun — terminal settlement with concurrent-priority rules
// Design §6.7: close/interrupt intent overrides normal settle
// ---------------------------------------------------------------------------

export function settleRun(input: {
  readonly runID: string
  readonly parentSessionID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly deliveryMode: "foreground" | "background"
  readonly directory: string
  readonly agentType: string
  readonly state: "completed" | "failed" | "interrupted" | "cancelled" | "closed"
  readonly reason: string
  readonly output?: string
  readonly rawResultMessageID?: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()

    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Read current state for concurrent-priority resolution
            const current = yield* tx
              .select({
                state: TaskRunTable.state,
                control_state: TaskRunTable.control_state,
                interrupt_requested_at: TaskRunTable.interrupt_requested_at,
                version: TaskRunTable.version,
                effective_delivery_mode: TaskRunTable.effective_delivery_mode,
              })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
                  gt(TaskRunTable.lease_expires_at, now),
                ),
              )
              .get()
              .pipe(Effect.orDie)

            if (!current) return { won: false as const, reason: "claim_lost" as const }

            // Concurrent-priority: close > interrupt > normal
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
                raw_result_message_id: input.rawResultMessageID
                  ? MessageID.make(input.rawResultMessageID)
                  : null,
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

            if (!updated) return { won: false as const, reason: "version_race" as const }

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

            // Background delivery: create notification outbox row (§3.7)
            const isBackground =
              current.effective_delivery_mode === "background" ||
              input.deliveryMode === "background"
            if (isBackground) {
              const outboxID = `task-notify:${input.runID}`
              const payloadText =
                finalState === "completed"
                  ? `Background task completed. Call task_read({ task_id: "${input.runID}" }) to read the result.`
                  : `Background task ended with state: ${finalState}. Call task_read({ task_id: "${input.runID}" }) to inspect partial work.`
              const payloadObj = { agent: input.agentType, text: payloadText }
              const payloadJson = JSON.stringify(payloadObj)
              const { createHash } = require("node:crypto") as typeof import("node:crypto")
              const payloadHashVal = createHash("sha256").update(payloadJson).digest("hex")
              yield* tx
                .insert(TaskNotificationOutboxTable)
                .values({
                  id: outboxID,
                  run_id: input.runID,
                  event_kind: "terminal",
                  correlation_id: outboxID,
                  message_id: MessageID.ascending(),
                  parent_session_id: input.parentSessionID as any,
                  directory: input.directory,
                  payload: payloadObj,
                  payload_hash: payloadHashVal,
                  status: "pending",
                  attempts: 0,
                  available_at: now,
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
            }

            return { won: true as const, finalState }
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

// ---------------------------------------------------------------------------
// run — full executor lifecycle with injected loopFn
// Design §3.5
//
// loopFn replaces the SessionPrompt.Service dependency, eliminating the circular
// reference when called from within the SessionPrompt factory (prompt.ts).
// The caller is responsible for providing InstanceRef and any other context
// that loopFn needs before passing it here.
// ---------------------------------------------------------------------------

export type RunInput = {
  readonly run: Run
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly childSessionID: SessionID
  readonly parentSessionID: string
  readonly deliveryMode: "foreground" | "background"
  readonly directory: string
  readonly agentType: string
  readonly leaseMs?: number
  /** Injected execution function. Must be Effect<unknown, unknown, never> (all services pre-provided). */
  readonly loopFn: (sessionID: SessionID) => Effect.Effect<unknown, unknown, never>
}

/**
 * Execute one provisioned run end-to-end.
 *
 * Steps:
 *   1. CAS provisioning → running (commit before calling loopFn — §6.4)
 *   2. Start background lease-renewal fiber
 *   3. Call loopFn — this is the opaque legacy activity boundary
 *   4. Check interrupt intent
 *   5. Settle run with concurrent-priority rules
 *   6. Create background outbox row if delivery_mode=background
 */
export function run(input: RunInput): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const leaseMs = input.leaseMs ?? 30_000
    const now = Date.now()

    // ── 1. CAS provisioning → running ────────────────────────────────────────
    const startResult = yield* startExecution({
      run: input.run,
      ownerToken: input.ownerToken,
      leaseMs,
      now,
    }).pipe(
      Effect.map(() => true as const),
      Effect.catchTag("LegacySubagentExecutor.ClaimLost", (err) =>
        Effect.logWarning("executor: claim lost before start", {
          runID: input.run.runID,
          reason: err.reason,
        }).pipe(Effect.as(false as const)),
      ),
    )
    if (!startResult) return

    // ── 2. Lease renewal — background fiber ──────────────────────────────────
    // Renews lease every leaseMs/3 so it doesn't expire during long runs.
    const renewInterval = Math.max(5_000, Math.floor(leaseMs / 3))
    const renewalFiber = yield* renewLease({
      runID: input.run.runID,
      ownerToken: input.ownerToken,
      claimGeneration: input.claimGeneration,
      leaseMs,
    }).pipe(
      Effect.repeat(Schedule.fixed(Duration.millis(renewInterval))),
      Effect.provideService(Database.Service, yield* Database.Service),
      Effect.catchCause(() => Effect.void),
      Effect.forkDetach,
    )

    // ── 3. Call loopFn (opaque legacy activity) ───────────────────────────────
    // The process crashing here → classifyOnStartup sees execution_started_at IS NOT NULL
    // → recovery_required (§11.2). We never auto-replay after this point.
    let loopResultMessageID: string | undefined
    let loopOutput: string | undefined
    let loopOk = false
    let loopError = "loop_error"
    yield* input
      .loopFn(input.childSessionID)
      .pipe(
        Effect.map((msg) => {
          loopOk = true
          loopResultMessageID = (msg as any)?.info?.id as string | undefined
          loopOutput = typeof msg === "string" ? msg : undefined
        }),
        Effect.catchCause((cause) => {
          loopError =
            Cause.squash(cause) instanceof Error
              ? (Cause.squash(cause) as Error).message
              : "loop_error"
          return Effect.void
        }),
      )

    // ── 4. Stop lease renewal ─────────────────────────────────────────────────
    yield* Fiber.interrupt(renewalFiber).pipe(Effect.ignore)

    // ── 5. Check interrupt intent ─────────────────────────────────────────────
    const interruptStatus = yield* checkInterrupt(input.run.runID, input.ownerToken)

    const settleState =
      interruptStatus.closed
        ? ("closed" as const)
        : interruptStatus.interrupted && !loopOk
          ? ("interrupted" as const)
          : loopOk
            ? ("completed" as const)
            : ("failed" as const)

    const settleReason =
      settleState === "completed"
        ? "text_output_valid"
        : settleState === "interrupted"
          ? (interruptStatus.reason ?? "human_interrupted")
          : settleState === "closed"
            ? "close_requested"
            : loopError

    // ── 6. Settle run (concurrent-priority CAS + optional outbox) ────────────
    yield* settleRun({
      runID: input.run.runID,
      parentSessionID: input.parentSessionID,
      ownerToken: input.ownerToken,
      claimGeneration: input.claimGeneration,
      deliveryMode: input.deliveryMode,
      directory: input.directory,
      agentType: input.agentType,
      state: settleState,
      reason: settleReason,
      output: loopOk ? loopOutput : undefined,
      rawResultMessageID: loopResultMessageID,
      now: Date.now(),
    }).pipe(Effect.ignore)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("executor: unexpected defect", {
        runID: input.run.runID,
        cause: Cause.pretty(cause),
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// runFromClaim — convenience wrapper: read full Run from DB + call run()
// Called by the TaskDispatcher onClaimed callback.
// ---------------------------------------------------------------------------

export function runFromClaim(input: {
  readonly claim: ClaimResult
  readonly ownerToken: string
  readonly leaseMs?: number
  readonly loopFn: (sessionID: SessionID) => Effect.Effect<unknown, unknown, never>
}): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Read the full Run row to get all fields needed by run()
    const row = yield* db
      .select()
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.claim.runID))
      .get()
      .pipe(Effect.orDie)

    if (!row) {
      yield* Effect.logWarning("executor.runFromClaim: run not found", {
        runID: input.claim.runID,
      })
      return
    }

    const runData: Run = {
      runID: row.run_id,
      rootRunID: row.root_run_id ?? undefined,
      requestHash: row.request_hash,
      parentSessionID: row.parent_session_id as any,
      parentMessageID: row.parent_message_id as any,
      toolCallID: row.tool_call_id,
      childSessionID: row.child_session_id as any,
      generation: row.generation,
      deliveryMode: row.delivery_mode,
      phase: row.phase as any,
      state: row.state as any,
      reason: row.reason ?? undefined,
      attempts: row.attempts,
      executionOwner: row.execution_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      timeSettled: row.time_settled ?? undefined,
      version: row.version ?? 0,
      controlState: (row.control_state ?? "open") as any,
      originKind: (row.origin_kind ?? "task_tool") as any,
      originKey: row.origin_key ?? undefined,
      depth: row.depth ?? 1,
      mutationCapability: (row.mutation_capability ?? "write") as any,
      workspaceMode: (row.workspace_mode ?? "shared") as any,
      workspaceOwner: (row.workspace_owner ?? "parent") as any,
      inputState: (row.input_state ?? "legacy") as any,
      startAttempts: row.start_attempts ?? 0,
      claimGeneration: row.claim_generation ?? input.claim.claimGeneration,
      availableAt: row.available_at ?? row.time_created,
    }

    // Resolve parent session directory for outbox routing
    const parentRow = yield* db
      .select({ directory: SessionTable.directory })
      .from(SessionTable)
      .where(eq(SessionTable.id, row.parent_session_id))
      .get()
      .pipe(Effect.orDie)

    if (!parentRow) {
      yield* Effect.logWarning("executor.runFromClaim: parent session not found, settling failed", {
        runID: input.claim.runID,
        parentSessionID: row.parent_session_id,
      })
      yield* settleRun({
        runID: row.run_id,
        parentSessionID: row.parent_session_id,
        ownerToken: input.ownerToken,
        claimGeneration: input.claim.claimGeneration,
        deliveryMode: row.delivery_mode as any,
        directory: "",
        agentType: row.origin_kind === "goal_role" ? (row.goal_role ?? "worker") : "task",
        state: "failed",
        reason: "executor_startup_parent_session_missing",
      }).pipe(Effect.ignore)
      return
    }

    yield* run({
      run: runData,
      ownerToken: input.ownerToken,
      claimGeneration: input.claim.claimGeneration,
      childSessionID: runData.childSessionID,
      parentSessionID: row.parent_session_id,
      deliveryMode: row.delivery_mode,
      directory: parentRow.directory,
      agentType: row.origin_kind === "goal_role" ? (row.goal_role ?? "worker") : "task",
      leaseMs: input.leaseMs,
      loopFn: input.loopFn,
    })
  })
}

export * as LegacySubagentExecutor from "./task-executor"
