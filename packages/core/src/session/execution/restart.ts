export * as SessionRestart from "./restart"

import { Context, Effect, Layer } from "effect"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Database } from "../../database/database"
import {
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "../../context-federation/session-sql"
import { V2ProviderRecoveryBridgeTable } from "../runner/v2-provider-turn.sql"
import { SessionProviderOwner } from "../../context-federation/provider-owner"
import { SessionExecution } from "../execution"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { V2ProviderTurnReceiptTable } from "../runner/v2-provider-turn.sql"

export type RecoveryReceipt = {
  readonly receiptId: string
  readonly state: typeof V2ProviderTurnReceiptTable.$inferSelect.state
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly providerAttemptId?: string
  readonly requestHash: string
  readonly providerId: string
  readonly ownerToken: string
  readonly preparedTurnHash?: string
  readonly wireRequestHash?: string
  readonly dispatchingAt?: number
}

export type RecoveryAttempt = {
  readonly attemptId: string
  readonly state: typeof SessionProviderAttemptTable.$inferSelect.state
  readonly activityId: string
  readonly providerTurnSeq: number
  readonly requestHash: string
  readonly providerId: string
  readonly ownerToken?: string
  readonly preparedTurnHash?: string
  readonly wireRequestHash?: string
  readonly resolutionDecision?: "abandoned" | "settled" | "replayed"
  readonly bridgeReceiptId?: string
}

export type RecoveryTurn = {
  readonly receipt: RecoveryReceipt
  readonly attempt?: RecoveryAttempt
  readonly classification:
    | "safe_before_dispatch"
    | "recovery_required"
    | "terminal_consistent"
    | "authority_conflict"
    | "owned_elsewhere"
}

export type RecoveryToolReceipt = {
  readonly receiptId: string
  readonly providerAttemptId?: string
  readonly providerState:
    | "preparing"
    | "prepared"
    | "dispatching"
    | "streaming"
    | "indeterminate_after_crash"
  readonly requestState: string
  readonly dispatchingAt?: number
  readonly classification: "safe_before_dispatch" | "recovery_required"
}

export type RecoveryTaskRun = {
  readonly runId: string
  readonly childSessionId: string
  readonly state: string
  readonly executionOwner?: string
  readonly classification: "safe_before_dispatch" | "recovery_required" | "owned_elsewhere"
}

export type RecoveryClassification =
  | RecoveryTurn["classification"]
  | RecoveryToolReceipt["classification"]
  | RecoveryTaskRun["classification"]

export type RecoveryToolEffect = {
  readonly effectId: string
  readonly receiptId: string
  readonly providerAttemptId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly effectKind: "mutating" | "read_only"
  readonly state: "settled" | "failed"
  readonly grantBound: boolean
}

export type PendingRecovery = {
  readonly sessionID: SessionSchema.ID
  readonly turns: readonly RecoveryTurn[]
  readonly tools: readonly RecoveryToolReceipt[]
  readonly tasks: readonly RecoveryTaskRun[]
  // Terminal side-effect evidence: capability-layer recovery decisions must know the recorded
  // watermark of what already executed. Effects are evidence, not classification inputs — every
  // row is terminal by construction, so they never move the disposition vocabulary.
  readonly effects: readonly RecoveryToolEffect[]
  readonly disposition:
    | "claim_only"
    | "safe_before_dispatch"
    | "recovery_required"
    | "terminal_consistent"
    | "authority_conflict"
    | "owned_elsewhere"
}

export function classifyTurn(receipt: RecoveryReceipt, attempt?: RecoveryAttempt): RecoveryTurn["classification"] {
  if (!attempt || receipt.providerAttemptId !== attempt.attemptId) return "authority_conflict"
  if (
    receipt.activityId !== attempt.activityId ||
    receipt.providerTurnSeq !== attempt.providerTurnSeq ||
    receipt.requestHash !== attempt.requestHash ||
    receipt.providerId !== attempt.providerId ||
    receipt.ownerToken !== attempt.ownerToken ||
    receipt.preparedTurnHash !== attempt.preparedTurnHash ||
    receipt.wireRequestHash !== attempt.wireRequestHash
  )
    return "authority_conflict"
  if (
    attempt.state === "resolved_abandoned" ||
    attempt.state === "resolved_settled" ||
    attempt.state === "resolved_replayed"
  ) {
    // Resolved attempts are only trustworthy through their explicit resolution + bridge rows; the
    // resolved state alone never proves which receipt/command the resolution applies to.
    if (
      attempt.resolutionDecision === undefined ||
      attempt.bridgeReceiptId === undefined ||
      attempt.bridgeReceiptId !== receipt.receiptId ||
      attempt.state !== `resolved_${attempt.resolutionDecision}`
    )
      return "authority_conflict"
    return receipt.state === "indeterminate_after_crash" ? "terminal_consistent" : "authority_conflict"
  }
  if (
    ["dispatching", "streaming", "indeterminate_after_crash"].includes(receipt.state) ||
    ["dispatching", "streaming", "indeterminate_after_crash"].includes(attempt.state)
  )
    return "recovery_required"
  if (
    receipt.state === "preparing" &&
    attempt.state === "prepared" &&
    receipt.preparedTurnHash === undefined &&
    receipt.wireRequestHash === undefined &&
    receipt.dispatchingAt === undefined
  )
    return "safe_before_dispatch"
  if (
    (receipt.state === "settled" && attempt.state === "settled") ||
    (receipt.state === "failed" && attempt.state === "failed")
  )
    return "terminal_consistent"
  return "authority_conflict"
}

// Legacy tool request receipts are durable evidence of a provider turn that offered tool calls.
// A receipt that never reached physical dispatch proves no remote work happened; anything past
// dispatch has an unknown outcome and must go through explicit recovery.
export function classifyToolReceipt(receipt: {
  readonly providerState: RecoveryToolReceipt["providerState"]
}): RecoveryToolReceipt["classification"] {
  if (receipt.providerState === "preparing" || receipt.providerState === "prepared")
    return "safe_before_dispatch"
  return "recovery_required"
}

// TaskRun recovery follows the same posture as provider turns: a live execution lease always wins
// (claiming writes the owner and lease before the run leaves provisioning, so a pre-dispatch row
// with a live lease is mid-claim elsewhere); lease-less pre-dispatch rows may be re-admitted;
// executing rows with a dead lease have an unknown outcome and require explicit recovery.
export function classifyTaskRun(
  run: {
    readonly state: string
    readonly executionOwner?: string
    readonly leaseExpiresAt?: number
  },
  observedAt: number,
): RecoveryTaskRun["classification"] {
  if (run.executionOwner !== undefined && (run.leaseExpiresAt ?? 0) > observedAt)
    return "owned_elsewhere"
  if (run.state === "admitted" || run.state === "queued" || run.state === "provisioning")
    return "safe_before_dispatch"
  return "recovery_required"
}

function aggregate(classifications: readonly RecoveryClassification[]): PendingRecovery["disposition"] {
  if (classifications.length === 0) return "claim_only"
  for (const disposition of [
    "authority_conflict",
    "owned_elsewhere",
    "recovery_required",
    "safe_before_dispatch",
  ] as const) {
    if (classifications.some((classification) => classification === disposition)) return disposition
  }
  return "terminal_consistent"
}

export interface Interface {
  /** Ensures current process-local owners have a durable execution claim before orderly teardown. */
  readonly suspendActiveSessions: Effect.Effect<void>
  /** Lists unowned claims requiring explicit recovery classification. Never starts provider work. */
  readonly pendingRecovery: Effect.Effect<ReadonlyArray<PendingRecovery>>
}

/** Restart continuity actions. The host must invoke them explicitly. */
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const db = (yield* Database.Service).db
    return Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* Effect.forEach(yield* execution.active, store.claim, { discard: true })
      }),
      pendingRecovery: Effect.gen(function* () {
        const active = yield* execution.active
        const sessionIDs = (yield* store.listSuspended()).filter((sessionID) => !active.has(sessionID))
        if (sessionIDs.length === 0) return []
        const inventory = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const observedAt = yield* SessionProviderOwner.observedAtInTransaction(tx)
              const rows = yield* tx
                .select({
                  sessionID: V2ProviderTurnReceiptTable.session_id,
                  receiptId: V2ProviderTurnReceiptTable.receipt_id,
                  state: V2ProviderTurnReceiptTable.state,
                  activityId: V2ProviderTurnReceiptTable.activity_id,
                  providerTurnSeq: V2ProviderTurnReceiptTable.provider_turn_seq,
                  providerAttemptId: V2ProviderTurnReceiptTable.provider_attempt_id,
                  requestHash: V2ProviderTurnReceiptTable.request_input_hash,
                  providerId: V2ProviderTurnReceiptTable.provider_id,
                  ownerToken: V2ProviderTurnReceiptTable.owner_token,
                  preparedTurnHash: V2ProviderTurnReceiptTable.prepared_turn_hash,
                  wireRequestHash: V2ProviderTurnReceiptTable.wire_request_hash,
                  dispatchingAt: V2ProviderTurnReceiptTable.dispatching_at,
                  attemptState: SessionProviderAttemptTable.state,
                  attemptActivityId: SessionProviderAttemptTable.activity_id,
                  attemptTurnSeq: SessionProviderAttemptTable.provider_turn_seq,
                  attemptRequestHash: SessionProviderAttemptTable.request_hash,
                  attemptProviderId: SessionProviderAttemptTable.provider_id,
                  attemptOwnerToken: SessionProviderAttemptTable.owner_token,
                  attemptPreparedTurnHash: SessionProviderAttemptTable.prepared_turn_hash,
                  attemptWireRequestHash: SessionProviderAttemptTable.wire_request_hash,
                  resolutionDecision: SessionProviderAttemptResolutionTable.decision,
                  bridgeReceiptId: V2ProviderRecoveryBridgeTable.receipt_id,
                  ownerExpiresAt: SessionProviderOwnerLeaseTable.lease_expires_at,
                  ownerReleasedAt: SessionProviderOwnerLeaseTable.released_at,
                })
                .from(V2ProviderTurnReceiptTable)
                .leftJoin(
                  SessionProviderAttemptTable,
                  eq(V2ProviderTurnReceiptTable.provider_attempt_id, SessionProviderAttemptTable.attempt_id),
                )
                .leftJoin(
                  SessionProviderAttemptResolutionTable,
                  eq(V2ProviderTurnReceiptTable.provider_attempt_id, SessionProviderAttemptResolutionTable.attempt_id),
                )
                .leftJoin(
                  V2ProviderRecoveryBridgeTable,
                  eq(V2ProviderTurnReceiptTable.provider_attempt_id, V2ProviderRecoveryBridgeTable.attempt_id),
                )
                .leftJoin(
                  SessionProviderOwnerLeaseTable,
                  eq(V2ProviderTurnReceiptTable.owner_token, SessionProviderOwnerLeaseTable.owner_token),
                )
                .where(
                  and(
                    inArray(V2ProviderTurnReceiptTable.session_id, sessionIDs),
                    eq(V2ProviderTurnReceiptTable.owner_mode, "v2"),
                  ),
                )
                .all()
              // Legacy durable authorities, read-only in the same snapshot: the recovery
              // inventory must surface them fail-closed even though V2 never writes them.
              const inSessions = sql.join(
                sessionIDs.map((id) => sql`${id}`),
                sql`, `,
              )
              const toolRows = yield* tx.all<{
                session_id: string
                receipt_id: string
                provider_attempt_id: string | null
                provider_state: string
                request_state: string
                dispatching_at: number | null
              }>(sql`
                SELECT session_id, receipt_id, provider_attempt_id, provider_state, request_state, dispatching_at
                FROM session_tool_request_receipt
                WHERE session_id IN (${inSessions})
                  AND provider_state NOT IN ('settled', 'failed')
              `)
              const effectRows = yield* tx.all<{
                session_id: string
                effect_id: string
                receipt_id: string
                provider_attempt_id: string
                tool_call_id: string
                tool_name: string
                effect_kind: string
                state: string
                grant_receipt_id: string | null
              }>(sql`
                SELECT session_id, effect_id, receipt_id, provider_attempt_id, tool_call_id, tool_name,
                       effect_kind, state, grant_receipt_id
                FROM session_v2_tool_effect
                WHERE session_id IN (${inSessions})
              `)
              const taskRows = yield* tx.all<{
                run_id: string
                parent_session_id: string
                child_session_id: string
                state: string
                execution_owner: string | null
                lease_expires_at: number | null
              }>(sql`
                SELECT run_id, parent_session_id, child_session_id, state, execution_owner, lease_expires_at
                FROM task_run
                WHERE parent_session_id IN (${inSessions})
                  AND state NOT IN ('completed', 'failed', 'error', 'cancelled', 'interrupted', 'closed')
              `)
              return { observedAt, rows, toolRows, taskRows, effectRows }
            }),
          )
          .pipe(Effect.orDie)
        return sessionIDs.map((sessionID) => {
          const turns = inventory.rows
            .filter((row) => row.sessionID === sessionID)
            .map((row): RecoveryTurn => {
              const receipt = {
                receiptId: row.receiptId,
                state: row.state,
                activityId: row.activityId,
                providerTurnSeq: row.providerTurnSeq,
                ...(row.providerAttemptId === null ? {} : { providerAttemptId: row.providerAttemptId }),
                requestHash: row.requestHash,
                providerId: row.providerId,
                ownerToken: row.ownerToken,
                ...(row.preparedTurnHash === null ? {} : { preparedTurnHash: row.preparedTurnHash }),
                ...(row.wireRequestHash === null ? {} : { wireRequestHash: row.wireRequestHash }),
                ...(row.dispatchingAt === null ? {} : { dispatchingAt: row.dispatchingAt }),
              }
              const attempt =
                row.providerAttemptId === null || row.attemptState === null
                  ? undefined
                  : {
                      attemptId: row.providerAttemptId,
                      state: row.attemptState,
                      activityId: row.attemptActivityId!,
                      providerTurnSeq: row.attemptTurnSeq!,
                      requestHash: row.attemptRequestHash!,
                      providerId: row.attemptProviderId!,
                      ...(row.attemptOwnerToken === null ? {} : { ownerToken: row.attemptOwnerToken }),
                      ...(row.attemptPreparedTurnHash === null
                        ? {}
                        : { preparedTurnHash: row.attemptPreparedTurnHash }),
                      ...(row.attemptWireRequestHash === null ? {} : { wireRequestHash: row.attemptWireRequestHash }),
                      ...(row.resolutionDecision === null ? {} : { resolutionDecision: row.resolutionDecision }),
                      ...(row.bridgeReceiptId === null ? {} : { bridgeReceiptId: row.bridgeReceiptId }),
                    }
              const ownedElsewhere = row.ownerReleasedAt === null && (row.ownerExpiresAt ?? 0) > inventory.observedAt
              return {
                receipt,
                ...(attempt === undefined ? {} : { attempt }),
                classification: ownedElsewhere ? "owned_elsewhere" : classifyTurn(receipt, attempt),
              }
            })
          const tools = inventory.toolRows
            .filter((row) => row.session_id === sessionID)
            .map((row): RecoveryToolReceipt => {
              const providerState = row.provider_state as RecoveryToolReceipt["providerState"]
              return {
                receiptId: row.receipt_id,
                ...(row.provider_attempt_id === null ? {} : { providerAttemptId: row.provider_attempt_id }),
                providerState,
                requestState: row.request_state,
                ...(row.dispatching_at === null ? {} : { dispatchingAt: row.dispatching_at }),
                classification: classifyToolReceipt({ providerState }),
              }
            })
          const tasks = inventory.taskRows
            .filter((row) => row.parent_session_id === sessionID)
            .map((row): RecoveryTaskRun => ({
              runId: row.run_id,
              childSessionId: row.child_session_id,
              state: row.state,
              ...(row.execution_owner === null ? {} : { executionOwner: row.execution_owner }),
              classification: classifyTaskRun(
                {
                  state: row.state,
                  ...(row.execution_owner === null ? {} : { executionOwner: row.execution_owner }),
                  ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
                },
                inventory.observedAt,
              ),
            }))
          const effects = inventory.effectRows
            .filter((row) => row.session_id === sessionID)
            .map((row): RecoveryToolEffect => ({
              effectId: row.effect_id,
              receiptId: row.receipt_id,
              providerAttemptId: row.provider_attempt_id,
              toolCallId: row.tool_call_id,
              toolName: row.tool_name,
              effectKind: row.effect_kind as RecoveryToolEffect["effectKind"],
              state: row.state as RecoveryToolEffect["state"],
              grantBound: row.grant_receipt_id !== null,
            }))
          return {
            sessionID,
            turns,
            tools,
            tasks,
            effects,
            disposition: aggregate([
              ...turns.map((turn) => turn.classification),
              ...tools.map((tool) => tool.classification),
              ...tasks.map((task) => task.classification),
            ]),
          }
        })
      }),
    })
  }),
)
