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
 *   8. PR receipt fence — automatic worktree 在 terminal settlement 前持久化 submission receipt；
 *      marker 后任何 adapter/CAS 不确定结果都进入 recovery_required，不重放 provider
 */

import { Cause, Data, Duration, Effect, Schedule } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import {
  TaskRunTable,
  TaskRunEventTable,
  TaskNotificationOutboxTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { MessageID, SessionID } from "@/session/schema"
import type { ClaimResult } from "@/session/task-dispatcher"
import type { Run } from "@/tool/task-run"
import type { StructuredOutputReceipt } from "@/tool/task-run"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Hash } from "@deepagent-code/core/util/hash"
import type { SubmittedPR } from "@/session/task-pr-submission"
import type { Worktree } from "@/worktree"
import { decodeFinalizerFailure } from "@/tool/task-finalizer-failure"
import {
  isStructuredOutputContract,
  persistDegradedStructuredOutput,
  persistStructuredFinalizerResponse,
  persistStructuredOutputEvidenceInTransaction,
} from "@/tool/task-structured-output-evidence"

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
                  // A-3 (P0-5): lease must be valid and execution must not have started
                  gt(TaskRunTable.lease_expires_at, now),
                  isNull(TaskRunTable.execution_started_at),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie)

            if (!updated) {
              return yield* Effect.fail(
                new ExecutorClaimLostError({
                  runID: input.run.runID,
                  reason:
                    "CAS provisioning→running failed: claim expired, wrong generation, control changed, or input not ready",
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

export function markStructuredFinalizerAttempt(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly attempt: 1 | 2
  readonly sourceMessageID: MessageID
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* Effect.uninterruptible(
      db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select({
                version: TaskRunTable.version,
                state: TaskRunTable.state,
                attempts: TaskRunTable.attempts,
                rawResultMessageID: TaskRunTable.raw_result_message_id,
                finalizerInputMessageID: TaskRunTable.finalizer_input_message_id,
                finalizerStartedAt: TaskRunTable.finalizer_started_at,
              })
              .from(TaskRunTable)
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  inArray(TaskRunTable.state, ["running", "researching", "finalizing"]),
                  eq(TaskRunTable.control_state, "open"),
                  isNull(TaskRunTable.interrupt_requested_at),
                  gt(TaskRunTable.lease_expires_at, now),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!current) {
              return yield* Effect.fail(
                new ExecutorClaimLostError({
                  runID: input.runID,
                  reason: "structured_finalizer_attempt_claim_lost",
                }),
              )
            }
            const expectedAttempt = current.state === "finalizing" ? current.attempts + 1 : 1
            if (
              input.attempt !== expectedAttempt ||
              (current.rawResultMessageID !== null && current.rawResultMessageID !== input.sourceMessageID) ||
              (current.finalizerInputMessageID !== null && current.finalizerInputMessageID !== input.sourceMessageID)
            ) {
              return yield* Effect.fail(
                new ExecutorClaimLostError({
                  runID: input.runID,
                  reason: "structured_finalizer_attempt_conflict",
                }),
              )
            }
            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                state: "finalizing",
                phase: "finalize",
                attempts: input.attempt,
                raw_result_message_id: input.sourceMessageID,
                finalizer_input_message_id: input.sourceMessageID,
                finalizer_started_at: current.finalizerStartedAt ?? now,
                version: current.version + 1,
                time_updated: now,
              })
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.version, current.version),
                  eq(TaskRunTable.state, current.state),
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  eq(TaskRunTable.control_state, "open"),
                  isNull(TaskRunTable.interrupt_requested_at),
                  gt(TaskRunTable.lease_expires_at, now),
                ),
              )
              .returning({ version: TaskRunTable.version })
              .get()
              .pipe(Effect.orDie)
            if (!updated) {
              return yield* Effect.fail(
                new ExecutorClaimLostError({
                  runID: input.runID,
                  reason: "structured_finalizer_attempt_version_race",
                }),
              )
            }
            yield* tx
              .insert(TaskRunEventTable)
              .values({
                event_id: Identifier.ascending("event"),
                run_id: input.runID,
                version: updated.version,
                type: "structured_finalizer_attempt_started",
                from_state: current.state,
                to_state: "finalizing",
                reason: `attempt:${input.attempt}`,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)
          }),
        { behavior: "immediate" },
      ),
    )
  })
}

// ---------------------------------------------------------------------------
// renewLease — heartbeat while loop is running
// ---------------------------------------------------------------------------

export function renewLease(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly leaseMs: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const updated = yield* db
      .update(TaskRunTable)
      .set({ lease_expires_at: now + input.leaseMs, time_updated: now })
      .where(
        and(
          eq(TaskRunTable.run_id, input.runID),
          eq(TaskRunTable.execution_owner, input.ownerToken),
          eq(TaskRunTable.claim_generation, input.claimGeneration),
          inArray(TaskRunTable.state, ["provisioning", "running", "researching", "finalizing"]),
          // A-3 (P0-5): only renew a non-expired lease — expired lease means we lost fencing
          gt(TaskRunTable.lease_expires_at, now),
        ),
      )
      .returning({ runID: TaskRunTable.run_id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) {
      return yield* Effect.fail(
        new ExecutorClaimLostError({
          runID: input.runID,
          reason: "lease renewal fence lost",
        }),
      )
    }
    return updated
  })
}

export function markLeaseLostRecovery(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly reason: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ state: TaskRunTable.state, version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                inArray(TaskRunTable.state, ["running", "researching", "finalizing"]),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!current) return false

          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "recovery_required",
              reason: "execution_lease_lost",
              error: { code: "execution_lease_lost", message: input.reason },
              execution_owner: null,
              lease_expires_at: null,
              version: current.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.state, current.state),
                eq(TaskRunTable.version, current.version),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false

          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "execution_recovery_required",
              from_state: current.state,
              to_state: "recovery_required",
              reason: "execution_lease_lost",
              data: { message: input.reason },
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
  })
}

export function startPRSubmission(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly operationKey: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.state, "running"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.workspace_owner, "run"),
                eq(TaskRunTable.worktree_state, "ready"),
                gt(TaskRunTable.lease_expires_at, now),
                isNull(TaskRunTable.pr_started_at),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!current) return false
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "finalizing",
              phase: "finalize",
              pr_operation_key: input.operationKey,
              pr_started_at: now,
              version: current.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "running"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                gt(TaskRunTable.lease_expires_at, now),
                isNull(TaskRunTable.pr_started_at),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "pr_submission_started",
              from_state: "running",
              to_state: "finalizing",
              reason: input.operationKey,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
  })
}

export function recordPRSubmission(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly operationKey: string
  readonly submission: SubmittedPR | undefined
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.state, "finalizing"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.pr_operation_key, input.operationKey),
                gt(TaskRunTable.lease_expires_at, now),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!current) return false
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              pr_id: input.submission?.id ?? null,
              worktree_state: input.submission ? "submitted" : "retained",
              version: current.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "finalizing"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.pr_operation_key, input.operationKey),
                gt(TaskRunTable.lease_expires_at, now),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: input.submission ? "pr_submitted" : "worktree_retained",
              from_state: "finalizing",
              to_state: "finalizing",
              reason: input.submission ? `${input.submission.id}:${input.submission.workerCommit}` : "no_changes",
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
  })
}

export function markPRSubmissionRecovery(input: {
  readonly runID: string
  readonly ownerToken: string
  readonly claimGeneration: number
  readonly operationKey: string
  readonly message: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = input.now ?? Date.now()
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.state, "finalizing"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.pr_operation_key, input.operationKey),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!current) return false
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "recovery_required",
              reason: "worktree_submission_outcome_unknown",
              error: { code: "worktree_submission_outcome_unknown", message: input.message },
              execution_owner: null,
              lease_expires_at: null,
              version: current.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "finalizing"),
                eq(TaskRunTable.execution_owner, input.ownerToken),
                eq(TaskRunTable.claim_generation, input.claimGeneration),
                eq(TaskRunTable.pr_operation_key, input.operationKey),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "pr_submission_recovery_required",
              from_state: "finalizing",
              to_state: "recovery_required",
              reason: "worktree_submission_outcome_unknown",
              data: { message: input.message },
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
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
      .where(and(eq(TaskRunTable.run_id, runID), eq(TaskRunTable.execution_owner, ownerToken)))
      .get()
      .pipe(Effect.orDie)
    return {
      interrupted: !!row?.interrupt_requested_at,
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
  readonly structuredResultMessageID?: string
  readonly structuredOutputReceipt?: StructuredOutputReceipt
  readonly attempts?: number
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly data?: Record<string, unknown>
  }
  // P1-8: the stable public identity for user-facing task_read calls is child_session_id,
  // not the internal run_id. Pass this from RunInput so the outbox payload is correct.
  readonly childSessionID?: string
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
                attempts: TaskRunTable.attempts,
                effective_delivery_mode: TaskRunTable.effective_delivery_mode,
                child_session_id: TaskRunTable.child_session_id,
                execution_spec: TaskRunTable.execution_spec,
                close_reason: TaskRunTable.close_reason,
                interrupt_reason: TaskRunTable.interrupt_reason,
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
            const closeWon = current.control_state === "close_requested" || current.control_state === "closed"
            const interruptWon = !closeWon && current.interrupt_requested_at !== null && input.state !== "completed"
            const finalState = closeWon ? "closed" : interruptWon ? "interrupted" : input.state
            const finalReason = closeWon
              ? (current.close_reason ?? "close_requested")
              : interruptWon
                ? (current.interrupt_reason ?? "human_interrupted")
                : input.reason

            const structuredOutput = current.execution_spec?.structuredOutput
            const structuredFailure = finalState === "failed" && input.error?.code.startsWith("structured_finalizer_")
            const evidenceState = finalState === "completed" ? "completed" : structuredFailure ? "failed" : undefined
            const structuredOutputReceipt = finalState === "completed" ? input.structuredOutputReceipt : undefined
            const structuredResultMessageID = finalState === "completed" ? input.structuredResultMessageID : undefined
            const attempts = evidenceState
              ? (structuredOutputReceipt?.attempt ?? input.attempts ?? 0)
              : current.attempts
            if (isStructuredOutputContract(structuredOutput) && evidenceState) {
              yield* persistStructuredOutputEvidenceInTransaction(tx, {
                runID: input.runID,
                childSessionID: current.child_session_id,
                ownerToken: input.ownerToken,
                claimGeneration: input.claimGeneration,
                expectedVersion: current.version,
                terminalState: evidenceState,
                attempts,
                contract: structuredOutput,
                rawResultMessageID: input.rawResultMessageID,
                structuredResultMessageID,
                output: input.output,
                structuredOutputReceipt,
                failureCode: input.error?.code,
                now,
              })
            }

            const updated = yield* tx
              .update(TaskRunTable)
              .set({
                state: finalState,
                phase: "settled",
                control_state: "closed",
                output: closeWon || interruptWon ? null : input.output,
                raw_result_message_id: input.rawResultMessageID ? MessageID.make(input.rawResultMessageID) : null,
                structured_result_message_id: structuredResultMessageID
                  ? MessageID.make(structuredResultMessageID)
                  : null,
                structured_output_receipt: structuredOutputReceipt,
                attempts,
                reason: finalReason,
                error:
                  finalState === "completed"
                    ? null
                    : closeWon || interruptWon
                      ? { code: finalState, message: finalReason }
                      : (input.error ?? { code: finalState, message: finalReason }),
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
                  eq(TaskRunTable.execution_owner, input.ownerToken),
                  eq(TaskRunTable.claim_generation, input.claimGeneration),
                  eq(TaskRunTable.state, current.state),
                  gt(TaskRunTable.lease_expires_at, now),
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
                reason: finalReason,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)

            // Background delivery: create notification outbox row (§3.7)
            const isBackground = current.effective_delivery_mode === "background" || input.deliveryMode === "background"
            if (isBackground) {
              const outboxID = `task-notify:${input.runID}`
              // C-6 (P1-8): user-visible text must use public child_session_id, NOT internal run_id.
              // Internal run_id is an implementation detail; task_read accepts child_session_id.
              const publicTaskID = input.childSessionID ?? input.runID
              const payloadText =
                finalState === "completed"
                  ? `Background task completed. Call task_read({ task_id: "${publicTaskID}" }) to read the result.`
                  : `Background task ended with state: ${finalState}. Call task_read({ task_id: "${publicTaskID}" }) to inspect partial work.`
              const payloadObj = { agent: input.agentType, text: payloadText }
              const payloadHashVal = Hash.sha256(JSON.stringify(payloadObj))
              yield* tx
                .insert(TaskNotificationOutboxTable)
                .values({
                  id: outboxID,
                  run_id: input.runID,
                  event_kind: "terminal",
                  correlation_id: outboxID,
                  message_id: MessageID.ascending(`msg_task_notify_${Hash.sha256(outboxID).slice(0, 24)}`),
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
  readonly automaticWorktree?: Worktree.Info
  readonly submitWorktree?: (info: Worktree.Info) => Effect.Effect<SubmittedPR | undefined, unknown, never>
  readonly leaseMs?: number
  /** Injected execution function. All services must be pre-provided by the caller. */
  readonly loopFn: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts, unknown, never>
  readonly finalizeFn?: (input: {
    readonly run: Run
    readonly research: SessionV1.WithParts
    readonly contract: NonNullable<NonNullable<Run["executionSpec"]>["structuredOutput"]>
    readonly onFinalizing: (input: {
      readonly attempt: 1 | 2
      readonly sourceMessageID: MessageID
    }) => Effect.Effect<void, unknown, never>
    readonly onPrepared: (
      input: {
        readonly attempt: 1 | 2
        readonly sourceMessageID: MessageID
        readonly output: string
      } & (
        | {
            readonly receipt: Extract<StructuredOutputReceipt, { readonly transport: "degraded_text" }>
          }
        | {
            readonly responseMessageID: MessageID
            readonly receipt: Exclude<StructuredOutputReceipt, { readonly transport: "degraded_text" }>
          }
      ),
    ) => Effect.Effect<void, unknown, never>
  }) => Effect.Effect<
    {
      readonly output: string
      readonly structuredResultMessageID?: MessageID
      readonly receipt: StructuredOutputReceipt
    },
    unknown,
    never
  >
}

type ExecutionOutcome =
  | {
      readonly ok: true
      readonly rawResultMessageID: MessageID
      readonly output: string
      readonly structuredResultMessageID?: MessageID
      readonly structuredOutputReceipt?: StructuredOutputReceipt
    }
  | {
      readonly ok: false
      readonly rawResultMessageID?: MessageID
      readonly error: string
      readonly failure?: {
        readonly reason: string
        readonly attempts: number
        readonly error: {
          readonly code: string
          readonly message: string
          readonly data: Record<string, unknown>
        }
      }
    }

/**
 * Execute one provisioned run end-to-end.
 *
 * Steps:
 *   1. CAS provisioning → running (commit before calling loopFn — §6.4)
 *   2. Start background lease-renewal fiber
 *   3. Call loopFn — this is the opaque legacy activity boundary
 *   4. Check interrupt intent
 *   5. For automatic writers, persist a PR marker, submit, and persist the receipt
 *   6. Settle run with concurrent-priority rules
 *   7. Create background outbox row if delivery_mode=background
 */
export function run(input: RunInput): Effect.Effect<void, never, Database.Service> {
  return Effect.gen(function* () {
    const database = yield* Database.Service
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

    // ── 2. Provider execution races the lease guard ──────────────────────────
    // Losing the heartbeat fence interrupts the provider fiber immediately. A stale owner must
    // never keep producing tools or provider output after another process may take ownership.
    const renewInterval = Math.max(10, Math.floor(leaseMs / 3))
    const loopOutcome = input.loopFn(input.childSessionID).pipe(
      Effect.flatMap((message): Effect.Effect<ExecutionOutcome, unknown, never> => {
        if (message.info.role !== "assistant") {
          return Effect.succeed({
            ok: false as const,
            rawResultMessageID: undefined,
            error: "provider returned a non-assistant message",
            failure: undefined,
          })
        }
        if (message.info.error) {
          return Effect.succeed({
            ok: false as const,
            rawResultMessageID: message.info.id,
            error: `${message.info.error.name}: ${JSON.stringify(message.info.error.data)}`,
            failure: undefined,
          })
        }
        const contract = input.run.executionSpec?.structuredOutput
        if (contract) {
          const frozenModel = input.run.executionSpec?.model
          const frozenAgent = input.run.executionSpec?.agent
          if (!input.finalizeFn || !frozenModel?.providerID || !frozenModel.modelID || !frozenAgent) {
            const failureMessage = !input.finalizeFn
              ? "durable structured finalizer is unavailable"
              : "durable structured finalizer is unavailable: frozen model identity is missing"
            return Effect.succeed({
              ok: false as const,
              rawResultMessageID: message.info.id,
              error: failureMessage,
              failure: {
                reason: "structured_finalizer_unavailable",
                attempts: 0,
                error: {
                  code: "structured_finalizer_unavailable",
                  message: failureMessage,
                  data: { phase: "finalize", attempt: 0, failure_class: "unavailable" },
                },
              },
            })
          }
          return input
            .finalizeFn({
              run: input.run,
              research: message,
              contract,
              onFinalizing: (attempt) =>
                markStructuredFinalizerAttempt({
                  runID: input.run.runID,
                  ownerToken: input.ownerToken,
                  claimGeneration: input.claimGeneration,
                  ...attempt,
                }).pipe(Effect.provideService(Database.Service, database)),
              onPrepared: (prepared) => {
                if (prepared.receipt.transport === "degraded_text") {
                  return persistDegradedStructuredOutput({
                    runID: input.run.runID,
                    childSessionID: input.childSessionID,
                    ownerToken: input.ownerToken,
                    claimGeneration: input.claimGeneration,
                    contract,
                    sourceMessageID: prepared.sourceMessageID,
                    receipt: prepared.receipt,
                    output: prepared.output,
                  }).pipe(Effect.provideService(Database.Service, database))
                }
                if (!("responseMessageID" in prepared)) {
                  return Effect.die("structured finalizer response is missing its message identity")
                }
                return persistStructuredFinalizerResponse({
                  runID: input.run.runID,
                  childSessionID: input.childSessionID,
                  ownerToken: input.ownerToken,
                  claimGeneration: input.claimGeneration,
                  contract,
                  attempt: prepared.attempt,
                  sourceMessageID: prepared.sourceMessageID,
                  responseMessageID: prepared.responseMessageID,
                  receipt: prepared.receipt,
                  output: prepared.output,
                }).pipe(Effect.provideService(Database.Service, database))
              },
            })
            .pipe(
              Effect.map((finalized) => ({
                ok: true as const,
                rawResultMessageID: message.info.id,
                structuredResultMessageID: finalized.structuredResultMessageID,
                structuredOutputReceipt: finalized.receipt,
                output: finalized.output,
              })),
              Effect.catchCause((cause) => Effect.succeed(finalizerFailure(message.info.id, cause))),
            )
        }
        const text = message.parts
          .filter(
            (part): part is SessionV1.TextPart =>
              part.type === "text" && part.synthetic !== true && part.ignored !== true,
          )
          .map((part) => part.text)
          .join("\n")
          .trim()
        const output =
          text || (message.info.structured === undefined ? undefined : JSON.stringify(message.info.structured))
        if (!output) {
          return Effect.succeed({
            ok: false as const,
            rawResultMessageID: message.info.id,
            error: "assistant output is empty",
            failure: undefined,
          })
        }
        return Effect.succeed({ ok: true as const, rawResultMessageID: message.info.id, output })
      }),
      Effect.catchCause((cause) =>
        Effect.succeed({
          ok: false as const,
          rawResultMessageID: undefined,
          error: Cause.squash(cause) instanceof Error ? String(Cause.squash(cause)) : Cause.pretty(cause),
          failure: undefined,
        }),
      ),
    )
    const heartbeat = renewLease({
      runID: input.run.runID,
      ownerToken: input.ownerToken,
      claimGeneration: input.claimGeneration,
      leaseMs,
    }).pipe(
      Effect.repeat(Schedule.fixed(Duration.millis(renewInterval))),
      Effect.flatMap(() => Effect.never),
    )
    const outcome = yield* Effect.raceFirst(loopOutcome, heartbeat).pipe(
      Effect.map((result) => ({ _tag: "loop" as const, result })),
      Effect.catchCause((cause) => Effect.succeed({ _tag: "lease_lost" as const, reason: Cause.pretty(cause) })),
    )
    if (outcome._tag === "lease_lost") {
      yield* markLeaseLostRecovery({
        runID: input.run.runID,
        ownerToken: input.ownerToken,
        claimGeneration: input.claimGeneration,
        reason: outcome.reason,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("executor: failed to persist lease-loss recovery state", {
            runID: input.run.runID,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      )
      return
    }

    // ── 3. Check interrupt intent ─────────────────────────────────────────────
    const interruptStatus = yield* checkInterrupt(input.run.runID, input.ownerToken)

    if (outcome.result.ok && !interruptStatus.closed && input.automaticWorktree) {
      const operationKey = input.childSessionID.toString()
      const started = yield* startPRSubmission({
        runID: input.run.runID,
        ownerToken: input.ownerToken,
        claimGeneration: input.claimGeneration,
        operationKey,
      })
      if (!started) {
        yield* markLeaseLostRecovery({
          runID: input.run.runID,
          ownerToken: input.ownerToken,
          claimGeneration: input.claimGeneration,
          reason: "PR submission marker fence lost before the external side effect",
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("executor: failed to persist PR marker fence loss", {
              runID: input.run.runID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        )
        return
      }
      const submitted = yield* Effect.raceFirst(
        (input.submitWorktree
          ? input.submitWorktree(input.automaticWorktree)
          : Effect.fail(new Error("Durable PR submission service is unavailable"))
        ).pipe(
          Effect.map((value) => ({ _tag: "submitted" as const, value })),
          Effect.catchCause((cause) => Effect.succeed({ _tag: "failed" as const, cause })),
        ),
        heartbeat,
      ).pipe(Effect.catchCause((cause) => Effect.succeed({ _tag: "lease_lost" as const, cause })))
      if (submitted._tag !== "submitted") {
        const recovered = yield* markPRSubmissionRecovery({
          runID: input.run.runID,
          ownerToken: input.ownerToken,
          claimGeneration: input.claimGeneration,
          operationKey,
          message: Cause.pretty(submitted.cause),
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("executor: failed to persist ambiguous PR submission outcome", {
              runID: input.run.runID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        )
        if (!recovered) {
          yield* Effect.logWarning("executor: PR recovery CAS lost", { runID: input.run.runID, operationKey })
        }
        return
      }
      const recorded = yield* recordPRSubmission({
        runID: input.run.runID,
        ownerToken: input.ownerToken,
        claimGeneration: input.claimGeneration,
        operationKey,
        submission: submitted.value,
      })
      if (!recorded) {
        const recovered = yield* markPRSubmissionRecovery({
          runID: input.run.runID,
          ownerToken: input.ownerToken,
          claimGeneration: input.claimGeneration,
          operationKey,
          message: "PR adapter returned, but the durable submission receipt CAS was lost",
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("executor: failed to persist lost PR receipt outcome", {
              runID: input.run.runID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        )
        if (!recovered) {
          yield* Effect.logWarning("executor: lost PR receipt recovery CAS", {
            runID: input.run.runID,
            operationKey,
          })
        }
        return
      }
    }

    const settleState = interruptStatus.closed
      ? ("closed" as const)
      : interruptStatus.interrupted && !outcome.result.ok
        ? ("interrupted" as const)
        : outcome.result.ok
          ? ("completed" as const)
          : ("failed" as const)

    const settleReason =
      settleState === "completed"
        ? outcome.result.ok && outcome.result.structuredOutputReceipt
          ? outcome.result.structuredOutputReceipt.transport === "structured"
            ? "structured_output_valid"
            : outcome.result.structuredOutputReceipt.transport === "text_fallback"
              ? "structured_output_text_fallback"
              : "structured_output_degraded_text"
          : "text_output_valid"
        : settleState === "interrupted"
          ? (interruptStatus.reason ?? "human_interrupted")
          : settleState === "closed"
            ? "close_requested"
            : outcome.result.ok
              ? "loop_error"
              : (outcome.result.failure?.reason ?? outcome.result.error)

    // ── 6. Settle run (concurrent-priority CAS + optional outbox) ────────────
    // A-3 (P0-5): check CAS result — if won=false the run is in an inconsistent state;
    // log the loss so a reconciliation pass (classifyOnStartup) can recover it.
    const settleResult = yield* settleRun({
      runID: input.run.runID,
      parentSessionID: input.parentSessionID,
      ownerToken: input.ownerToken,
      claimGeneration: input.claimGeneration,
      deliveryMode: input.deliveryMode,
      directory: input.directory,
      agentType: input.agentType,
      state: settleState,
      reason: settleReason,
      output: outcome.result.ok ? outcome.result.output : undefined,
      rawResultMessageID: outcome.result.rawResultMessageID,
      structuredResultMessageID:
        outcome.result.ok && outcome.result.structuredOutputReceipt?.transport !== "degraded_text"
          ? outcome.result.structuredResultMessageID
          : undefined,
      structuredOutputReceipt: outcome.result.ok ? outcome.result.structuredOutputReceipt : undefined,
      attempts: outcome.result.ok ? undefined : outcome.result.failure?.attempts,
      error: outcome.result.ok ? undefined : outcome.result.failure?.error,
      childSessionID: input.childSessionID.toString(),
      now: Date.now(),
    })
    if (!settleResult.won) {
      yield* Effect.logWarning(
        "executor: settleRun CAS lost — run lease expired before settlement; classifyOnStartup will recover",
        {
          runID: input.run.runID,
          reason: settleResult.reason,
          intendedState: settleState,
        },
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("executor: unexpected defect", {
        runID: input.run.runID,
        cause: Cause.pretty(cause),
      }),
    ),
  )
}

function finalizerFailure(rawResultMessageID: MessageID, cause: Cause.Cause<unknown>): ExecutionOutcome {
  const error = Cause.squash(cause)
  const message = error instanceof Error ? error.message : Cause.pretty(cause)
  const failure = decodeFinalizerFailure(message)
  return {
    ok: false,
    rawResultMessageID,
    error: message,
    failure,
  }
}

// ---------------------------------------------------------------------------
// runFromClaim — convenience wrapper: read full Run from DB + call run()
// Called by the TaskDispatcher onClaimed callback.
// ---------------------------------------------------------------------------

export function runFromClaim(input: {
  readonly claim: ClaimResult
  readonly ownerToken: string
  readonly leaseMs?: number
  readonly loopFn: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts, unknown, never>
  readonly finalizeFn: NonNullable<RunInput["finalizeFn"]>
  readonly submitWorktree?: (info: Worktree.Info) => Effect.Effect<SubmittedPR | undefined, unknown, never>
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
      toolCapabilityHash: row.tool_capability_hash ?? "legacy-unknown",
      workspaceMode: (row.workspace_mode ?? "shared") as any,
      workspaceOwner: (row.workspace_owner ?? "parent") as any,
      inputState: (row.input_state ?? "legacy") as any,
      startAttempts: row.start_attempts ?? 0,
      claimGeneration: row.claim_generation ?? input.claim.claimGeneration,
      availableAt: row.available_at ?? row.time_created,
      executionSpec: row.execution_spec as Run["executionSpec"],
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
      ...(row.workspace_owner === "run" &&
      row.worktree_state === "ready" &&
      row.worktree_directory &&
      row.worktree_branch
        ? {
            automaticWorktree: {
              name: row.worktree_branch.slice(row.worktree_branch.lastIndexOf("/") + 1),
              directory: row.worktree_directory,
              branch: row.worktree_branch,
            },
            submitWorktree: input.submitWorktree,
          }
        : {}),
      leaseMs: input.leaseMs,
      loopFn: input.loopFn,
      finalizeFn: input.finalizeFn,
    })
  })
}

export * as LegacySubagentExecutor from "./task-executor"
