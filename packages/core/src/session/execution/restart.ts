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
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { V2ProviderTurnReceiptTable } from "../runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "../runner/v2-tool-effect.sql"
import { SessionInputTable } from "../sql"

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
  readonly executionClaimToken?: number
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
  readonly state: "admitted" | "settled" | "failed"
  readonly grantBound: boolean
  readonly classification: "recovery_required" | "terminal_consistent"
}

export type PendingRecovery = {
  readonly sessionID: SessionSchema.ID
  readonly claimToken: number
  readonly turns: readonly RecoveryTurn[]
  readonly tools: readonly RecoveryToolReceipt[]
  readonly tasks: readonly RecoveryTaskRun[]
  // Tool-effect admissions are classification inputs. An admission without a matching terminal
  // row proves only that execution was allowed to start, so its outcome is unknown and must move
  // the Session into explicit recovery. Terminal rows remain execution-watermark evidence.
  readonly effects: readonly RecoveryToolEffect[]
  readonly disposition:
    | "claim_only"
    | "safe_before_dispatch"
    | "recovery_required"
    | "terminal_consistent"
    | "authority_conflict"
    | "owned_elsewhere"
}

export type StartupRedrive = {
  readonly released: readonly SessionSchema.ID[]
  readonly woken: readonly SessionSchema.ID[]
  readonly blocked: ReadonlyArray<{
    readonly sessionID: SessionSchema.ID
    readonly disposition: PendingRecovery["disposition"] | "claim_changed"
  }>
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
  /** Exact-releases and re-wakes only provably safe startup work. Past-dispatch work remains fenced. */
  readonly redriveStartup: Effect.Effect<StartupRedrive, SessionRunner.RunError>
}

/** Restart continuity actions. The host must invoke them explicitly. */
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const db = (yield* Database.Service).db
    const service = Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* Effect.forEach(
          yield* execution.active,
          (sessionID) =>
            store.claimToken(sessionID).pipe(
              Effect.flatMap((token) =>
                token === undefined ? Effect.die(`Active Session has no durable claim: ${sessionID}`) : Effect.void,
              ),
            ),
          { discard: true },
        )
      }),
      pendingRecovery: Effect.gen(function* () {
        const active = yield* execution.active
        const claims = (yield* store.listSuspendedClaims()).filter((claim) => !active.has(claim.sessionID))
        const sessionIDs = claims.map((claim) => claim.sessionID)
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
                  attemptExecutionClaimToken: SessionProviderAttemptTable.execution_claim_token,
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
              const effectRows = yield* tx
                .select({
                  sessionID: V2ToolEffectAdmissionTable.session_id,
                  admissionId: V2ToolEffectAdmissionTable.admission_id,
                  effectId: V2ToolEffectTable.effect_id,
                  receiptId: V2ToolEffectAdmissionTable.receipt_id,
                  providerAttemptId: V2ToolEffectAdmissionTable.provider_attempt_id,
                  toolCallId: V2ToolEffectAdmissionTable.tool_call_id,
                  toolName: V2ToolEffectAdmissionTable.tool_name,
                  effectKind: V2ToolEffectAdmissionTable.effect_kind,
                  state: V2ToolEffectTable.state,
                  grantReceiptId: V2ToolEffectTable.grant_receipt_id,
                })
                .from(V2ToolEffectAdmissionTable)
                .leftJoin(
                  V2ToolEffectTable,
                  and(
                    eq(V2ToolEffectAdmissionTable.receipt_id, V2ToolEffectTable.receipt_id),
                    eq(V2ToolEffectAdmissionTable.tool_call_id, V2ToolEffectTable.tool_call_id),
                  ),
                )
                .where(inArray(V2ToolEffectAdmissionTable.session_id, sessionIDs))
                .all()
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
          const claim = claims.find((candidate) => candidate.sessionID === sessionID)!
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
                      executionClaimToken: row.attemptExecutionClaimToken!,
                      ...(row.attemptOwnerToken === null ? {} : { ownerToken: row.attemptOwnerToken }),
                      ...(row.attemptPreparedTurnHash === null
                        ? {}
                        : { preparedTurnHash: row.attemptPreparedTurnHash }),
                      ...(row.attemptWireRequestHash === null ? {} : { wireRequestHash: row.attemptWireRequestHash }),
                      ...(row.resolutionDecision === null ? {} : { resolutionDecision: row.resolutionDecision }),
                      ...(row.bridgeReceiptId === null ? {} : { bridgeReceiptId: row.bridgeReceiptId }),
                    }
              // A TERMINAL receipt (settled / failed / indeterminate_after_crash) has its outcome
              // durably decided: a still-live owner lease cannot represent in-flight work for it,
              // so the lease fence only applies to non-terminal rows. This matters when a kill
              // lands in the window between an idle successor drain's claim and its release —
              // recovery must release that claim instead of fencing on the dead chain's lease.
              const receiptTerminal = ["settled", "failed", "indeterminate_after_crash"].includes(receipt.state)
              const ownedElsewhere =
                !receiptTerminal &&
                row.ownerReleasedAt === null &&
                (row.ownerExpiresAt ?? 0) > inventory.observedAt
              // A turn recorded under a DIFFERENT execution claim belongs to an older ownership
              // chain: the claim CAS only lets this claim exist after that chain released, and a
              // release follows the turn's terminal classification — so a TERMINAL row under a
              // foreign token is settled history for this claim's disposition (releasing cannot
              // replay it: past-dispatch work stays fenced by the wake barrier and the receipt
              // state machine). A non-terminal foreign row keeps the conflict fence (unknown
              // in-flight ownership).
              const claimTokenMismatch = attempt !== undefined && attempt.executionClaimToken !== claim.token
              return {
                receipt,
                ...(attempt === undefined ? {} : { attempt }),
                classification: ownedElsewhere
                  ? "owned_elsewhere"
                  : claimTokenMismatch && receiptTerminal
                    ? "terminal_consistent"
                    : claimTokenMismatch
                      ? "authority_conflict"
                      : classifyTurn(receipt, attempt),
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
            .filter((row) => row.sessionID === sessionID)
            .map((row): RecoveryToolEffect => ({
              effectId: row.effectId ?? row.admissionId,
              receiptId: row.receiptId,
              providerAttemptId: row.providerAttemptId,
              toolCallId: row.toolCallId,
              toolName: row.toolName,
              effectKind: row.effectKind,
              state: row.state ?? "admitted",
              grantBound: row.grantReceiptId !== null,
              classification: row.state === null || row.grantReceiptId === null ? "recovery_required" : "terminal_consistent",
            }))
          return {
            sessionID,
            claimToken: claim.token,
            turns,
            tools,
            tasks,
            effects,
            disposition: aggregate([
              ...turns.map((turn) => turn.classification),
              ...tools.map((tool) => tool.classification),
              ...tasks.map((task) => task.classification),
              ...effects.map((effect) => effect.classification),
            ]),
          }
        })
      }),
      redriveStartup: Effect.gen(function* () {
        const recoveries = yield* Effect.suspend(() => service.pendingRecovery)
        const active = yield* execution.active
        const claims = yield* store.listSuspendedClaims()
        const pendingInputs = yield* db
          .all<{ session_id: string; admitted_seq: number }>(sql`
            SELECT session_id, MAX(admitted_seq) AS admitted_seq
            FROM ${SessionInputTable}
            WHERE promoted_seq IS NULL AND delivery IN ('steer', 'queue', 'goal_steer')
            GROUP BY session_id
          `)
          .pipe(Effect.orDie)
        const released: SessionSchema.ID[] = []
        const woken: SessionSchema.ID[] = []
        const blocked: StartupRedrive["blocked"][number][] = []
        const pendingBySession = new Map(
          pendingInputs.map((input) => [SessionSchema.ID.make(input.session_id), input.admitted_seq]),
        )
        const wakePending = (sessionID: SessionSchema.ID) => {
          const seq = pendingBySession.get(sessionID)
          if (seq === undefined) return Effect.void
          return store.interruptSeq(sessionID).pipe(
            Effect.flatMap((interruptSeq) => {
              if (interruptSeq !== undefined && seq <= interruptSeq) return Effect.void
              woken.push(sessionID)
              return execution.wake(sessionID, seq)
            }),
          )
        }

        yield* Effect.forEach(
          recoveries,
          (recovery) => {
            if (
              recovery.disposition !== "claim_only" &&
              recovery.disposition !== "safe_before_dispatch" &&
              recovery.disposition !== "terminal_consistent"
            ) {
              blocked.push({ sessionID: recovery.sessionID, disposition: recovery.disposition })
              return Effect.void
            }
            return store.release(recovery.sessionID, recovery.claimToken).pipe(
              Effect.flatMap((didRelease) => {
                if (!didRelease) {
                  blocked.push({ sessionID: recovery.sessionID, disposition: "claim_changed" })
                  return Effect.void
                }
                released.push(recovery.sessionID)
                return wakePending(recovery.sessionID)
              }),
            )
          },
          { discard: true },
        )

        const claimed = new Set(claims.map((claim) => claim.sessionID))
        yield* Effect.forEach(
          pendingInputs.filter(
            (input) =>
              !claimed.has(SessionSchema.ID.make(input.session_id)) &&
              !active.has(SessionSchema.ID.make(input.session_id)) &&
              !woken.includes(SessionSchema.ID.make(input.session_id)),
          ),
          (input) => {
            const sessionID = SessionSchema.ID.make(input.session_id)
            return wakePending(sessionID)
          },
          { discard: true },
        )

        return { released, woken, blocked }
      }),
    })
    return service
  }),
)
