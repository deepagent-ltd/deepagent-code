export * as WorkAuthority from "./work-authority"

import { and, eq, ne, or, sql } from "drizzle-orm"
import { LLMEvent } from "@deepagent-code/llm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import {
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "../context-federation/session-sql"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkDispatchReservationTable, WorkExecutionTable } from "./work-authority.sql"
import { WorkExecutionProfile } from "./work-execution-profile"

type Db = Database.Interface["db"]
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Reader = Pick<Db, "select" | "all">
export type Work = typeof WorkExecutionTable.$inferSelect
export type Reservation = typeof WorkDispatchReservationTable.$inferSelect

/** Trusted host services read local authority facts in the caller's transaction. These methods
 * must not perform network/model work or accept proof objects from ordinary HTTP/plugin metadata. */
export interface Verification {
  readonly authorizeSource: (
    tx: Transaction,
    binding: WorkAuthoritySchema.Binding,
  ) => Effect.Effect<
    {
      readonly authorityID: string
      readonly revision: number
      readonly recordHash: string
    },
    WorkAuthoritySchema.Error
  >
  readonly resolveRoute: (
    tx: Transaction,
    binding: WorkAuthoritySchema.Binding,
  ) => Effect.Effect<
    {
      readonly evidenceID: string
      readonly evidenceHash: string
      readonly configurationHash: string
    },
    WorkAuthoritySchema.Error
  >
}
export class Verifier extends Context.Service<Verifier, Verification>()("@deepagent-code/WorkAuthority/Verifier") {}

export const get = (db: Reader, workID: string) =>
  db.select().from(WorkExecutionTable).where(eq(WorkExecutionTable.work_id, workID)).get().pipe(Effect.orDie)

export const lookupSession = Effect.fn("WorkAuthority.lookupSession")(function* (db: Reader, sessionID: string) {
  const work = yield* db
    .select()
    .from(WorkExecutionTable)
    .where(eq(WorkExecutionTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (work) return { kind: "bound" as const, work }
  // Parent links are durable Session facts; a receipt-backed ancestor is a conservative denial
  // marker, never a grant. Do not infer execution authority from prompt text or JSON metadata.
  const legacy = yield* db
    .all<{ session_id: string }>(
      sql`
    WITH RECURSIVE lineage(id, parent_id) AS (
      SELECT id, parent_id FROM session WHERE id = ${sessionID}
      UNION
      SELECT s.id, s.parent_id FROM session s JOIN lineage p ON s.id = p.parent_id
    )
    SELECT session_id FROM deepagent_event_admission
    WHERE status = 'resolved' AND (session_id = ${sessionID} OR session_id IN (SELECT id FROM lineage))
    UNION SELECT session_id FROM event_work_receipt
      WHERE session_id = ${sessionID} OR session_id IN (SELECT id FROM lineage)
    UNION SELECT session_id FROM work_execution WHERE session_id IN (SELECT id FROM lineage)
    UNION SELECT session_id FROM im_mention_intent WHERE session_id IS NOT NULL AND
      (session_id = ${sessionID} OR session_id IN (SELECT id FROM lineage))
    UNION SELECT i.session_id FROM im_mention_intent m JOIN session_input i ON i.id = m.input_id
      WHERE i.session_id = ${sessionID} OR i.session_id IN (SELECT id FROM lineage)
    LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  if (legacy.length > 0) return { kind: "legacy_unbound" as const, sourceSessionID: legacy[0]!.session_id }
  const artifact = yield* db
    .all<{ event_id: string }>(
      sql`
    WITH RECURSIVE lineage(id, parent_id) AS (
      SELECT id, parent_id FROM session WHERE id = ${sessionID}
      UNION SELECT s.id, s.parent_id FROM session s JOIN lineage p ON s.id = p.parent_id
    )
    SELECT e.event_id FROM deepagent_agent_execution e, json_each(e.artifacts) artifact
    WHERE artifact.value = ${`session:${sessionID}`} OR artifact.value IN (SELECT 'session:' || id FROM lineage) LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  if (artifact.length > 0) return { kind: "legacy_unbound" as const, sourceSessionID: sessionID }
  // Before completion, AgentExecution has no Session artifact. Metadata is only a lookup hint:
  // a real durable execution row AND the historical deterministic child ID must both match.
  const running = yield* db
    .all<{ session_id: string; event_id: string; task_id: string; generation: number }>(
      sql`
    WITH RECURSIVE lineage(id, parent_id) AS (
      SELECT id, parent_id FROM session WHERE id = ${sessionID}
      UNION SELECT s.id, s.parent_id FROM session s JOIN lineage p ON s.id = p.parent_id
    )
    SELECT s.id session_id, e.event_id, e.task_id, json_extract(s.metadata, '$.generation') generation
    FROM session s JOIN deepagent_agent_execution e
      ON e.event_id = json_extract(s.metadata, '$.eventID') AND e.task_id = json_extract(s.metadata, '$.taskID')
    WHERE s.id IN (SELECT id FROM lineage) AND json_valid(s.metadata)
      AND json_extract(s.metadata, '$.generation') BETWEEN 1 AND e.generation
  `,
    )
    .pipe(Effect.orDie)
  if (
    running.some(
      (row) =>
        Number.isSafeInteger(row.generation) &&
        row.session_id ===
          `ses_v4_${Hash.sha256(CanonicalJson.stringify(["event-turn-session", row.event_id, row.task_id, row.generation])).slice(0, 40)}`,
    )
  )
    return { kind: "legacy_unbound" as const, sourceSessionID: sessionID }
  return { kind: "ordinary" as const }
})

export const reserve = Effect.fn("WorkAuthority.reserve")(function* (
  db: Db,
  input: { readonly binding: unknown; readonly now?: number; readonly allowLoopbackHTTP?: boolean },
) {
  const binding = yield* validated(WorkAuthorityPolicy.validateBinding(input.binding, input))
  return yield* db.transaction((tx) => reserveInTransaction(tx, { ...input, binding }), { behavior: "immediate" })
})

/** Source business receipts reserve through this same verifier and identity boundary. The
 * caller owns the immediate transaction and rolls back its receipt if reservation fails. */
export const reserveInTransaction = Effect.fn("WorkAuthority.reserveInTransaction")(function* (
  tx: Transaction,
  input: { readonly binding: unknown; readonly now?: number; readonly allowLoopbackHTTP?: boolean },
) {
  const binding = yield* validated(WorkAuthorityPolicy.validateBinding(input.binding, input))
  if (binding.parentWorkID)
    return yield* failure("PROFILE_UNAVAILABLE", "Child execution requires a shared-root escrow and is unavailable")
  const digest = WorkAuthorityPolicy.fingerprint(binding)
  const now = input.now ?? Date.now()
  const existing = yield* tx
    .select()
    .from(WorkExecutionTable)
    .where(
      or(
        eq(WorkExecutionTable.work_id, binding.workID),
        eq(WorkExecutionTable.session_id, binding.sessionID),
        eq(WorkExecutionTable.input_id, binding.inputID),
        and(
          eq(WorkExecutionTable.source_kind, binding.source.kind),
          eq(WorkExecutionTable.authority_id, binding.source.authorityID),
          eq(WorkExecutionTable.source_request_id, binding.source.requestID),
        ),
      ),
    )
    .all()
  if (existing.length > 0) {
    if (existing.length !== 1 || existing[0]!.binding_hash !== digest)
      return yield* failure("WORK_REQUEST_CONFLICT", "Work identity is already bound to a different request")
    return existing[0]!
  }
  if (binding.deadline <= now || binding.deadline - now > binding.budget.maxDurationMs)
    return yield* failure("WORK_EXPIRED", "Work deadline is expired or exceeds its duration ceiling")
  // No adopting an existing unrestricted Session. Reserve must win before native creation.
  const session = yield* tx
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(binding.sessionID)))
    .get()
  if (session) return yield* failure("WORK_BINDING_CONFLICT", "A new work cannot adopt an existing Session")
  const proof = yield* verify(tx, binding)
  const row = yield* tx
    .insert(WorkExecutionTable)
    .values({
      work_id: binding.workID,
      root_work_id: binding.rootWorkID,
      parent_work_id: null,
      execution_role: WorkAuthorityPolicy.hasSharedRootProfile(binding.profile) && binding.profile.id === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id ? "dag_controller" : "agent",
      session_id: binding.sessionID,
      input_id: binding.inputID,
      source_kind: binding.source.kind,
      authority_id: binding.source.authorityID,
      source_request_id: binding.source.requestID,
      source_revision: proof.source.revision,
      source_record_hash: proof.source.recordHash,
      route_evidence_hash: proof.route.evidenceHash,
      binding_hash: digest,
      binding_version: binding.schemaVersion === "work-execution.v2" ? 2 : 1,
      binding,
      security_namespace_id: binding.scope.securityNamespaceID,
      agent_id: binding.agentID,
      admission_state: "reserved",
      control_state: "active",
      outcome: "pending",
      control_revision: 1,
      control_receipts: [],
      loopback_http: input.allowLoopbackHTTP === true,
      created_at: now,
      updated_at: now,
    })
    .returning()
    .get()
  if (!row) return yield* failure("WORK_BINDING_CONFLICT", "Work reservation returned no row")
  return row
})

/** Admission retries must recheck proof before Session.create or any Location/Agent reads. */
export const requireAdmission = Effect.fn("WorkAuthority.requireAdmission")(function* (
  db: Db,
  input: {
    readonly workID: string
    readonly expectedRevision?: number
    readonly now?: number
  },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const work = yield* requireWork(tx, input.workID)
        yield* current(work, input.expectedRevision ?? work.control_revision, input.now ?? Date.now(), false)
        if (work.admission_state === "rejected") return yield* failure("WORK_NOT_READY", "Work admission was rejected")
        yield* verifyExisting(tx, work)
        return work
      }),
    { behavior: "immediate" },
  )
})

/** Original admission/control verifier inside the caller's transaction, before Session exists. */
export const requireReservedInTransaction = Effect.fn("WorkAuthority.requireReservedInTransaction")(function* (tx: Transaction,
  input: { workID: string; expectedRevision: number }) {
  const work = yield* requireWork(tx, input.workID)
  yield* current(work, input.expectedRevision, Date.now(), false)
  if (work.admission_state === "rejected") return yield* failure("WORK_NOT_READY", "Work admission was rejected")
  yield* verifyExisting(tx, work)
  return work
})

/** Call from SessionInput.admit's commit hook. The hook shares the event/inbox transaction. */
export const bindInputInTransaction = Effect.fn("WorkAuthority.bindInputInTransaction")(function* (
  tx: Transaction,
  input: {
    readonly workID: string
    readonly sessionID: string
    readonly inputID: string
    readonly promptHash: string
    readonly admittedSeq: number
    readonly expectedRevision: number
    readonly now?: number
  },
) {
  const work = yield* requireWork(tx, input.workID)
  yield* current(work, input.expectedRevision, input.now ?? Date.now(), false)
  yield* verifyExisting(tx, work)
  if (
    work.session_id !== input.sessionID ||
    work.input_id !== input.inputID ||
    work.binding.auditedText.hash !== input.promptHash ||
    !Number.isSafeInteger(input.admittedSeq) ||
    input.admittedSeq < 1
  )
    return yield* failure("WORK_BINDING_CONFLICT", "Work input identity does not match the reserved request")
  const session = yield* tx
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id)))
    .get()
  if (
    !session ||
    !session.v2_authority ||
    session.directory !== work.binding.location.directory ||
    session.workspace_id !== (work.binding.location.workspaceID ?? null) ||
    session.agent !== work.binding.agentID ||
    !matchesSessionModel(session, work.binding)
  )
    return yield* failure("WORK_BINDING_CONFLICT", "Work Session placement or Agent differs from its reservation")
  const admitted = yield* tx
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, SessionMessage.ID.make(input.inputID)))
    .get()
  if (
    !admitted ||
    admitted.session_id !== input.sessionID ||
    admitted.admitted_seq !== input.admittedSeq ||
    admitted.delivery !== "queue" ||
    Hash.sha256(admitted.prompt.text) !== input.promptHash ||
    Buffer.byteLength(admitted.prompt.text, "utf8") !== work.binding.auditedText.utf8Bytes ||
    !matchesRestrictedPrompt(admitted.prompt, work.binding)
  )
    return yield* failure("WORK_BINDING_CONFLICT", "The committed queue input does not match the audited text")
  if (work.admission_state === "ready") {
    if (work.admitted_seq !== input.admittedSeq)
      return yield* failure("WORK_BINDING_CONFLICT", "Work input sequence changed")
    return work
  }
  const row = yield* tx
    .update(WorkExecutionTable)
    .set({ admission_state: "ready", admitted_seq: input.admittedSeq, updated_at: input.now ?? Date.now() })
    .where(
      and(
        eq(WorkExecutionTable.work_id, work.work_id),
        eq(WorkExecutionTable.control_revision, input.expectedRevision),
        eq(WorkExecutionTable.admission_state, "reserved"),
      ),
    )
    .returning()
    .get()
  if (!row) return yield* failure("WORK_CONTROL_CONFLICT", "Work changed during input admission")
  return row
})

export const requireRunnable = Effect.fn("WorkAuthority.requireRunnable")(function* (
  db: Reader,
  input: {
    readonly sessionID: string
    readonly location?: WorkAuthoritySchema.Location
    readonly now?: number
  },
) {
  const found = yield* lookupSession(db, input.sessionID)
  if (found.kind === "ordinary") return undefined
  if (found.kind === "legacy_unbound")
    return yield* failure("WORK_AUTHORITY_MISSING", "Legacy event work has no trusted execution binding")
  yield* requireWork(db, found.work.work_id)
  if (found.work.execution_role === "dag_controller")
    return yield* failure("PROFILE_UNAVAILABLE", "Event controller trace cannot execute a provider or tool")
  yield* current(found.work, found.work.control_revision, input.now ?? Date.now())
  if (
    input.location &&
    CanonicalJson.stringify(input.location) !== CanonicalJson.stringify(found.work.binding.location)
  )
    return yield* failure("WORK_BINDING_CONFLICT", "Work Location changed")
  const pending = yield* db
    .select({ state: WorkDispatchReservationTable.state })
    .from(WorkDispatchReservationTable)
    .where(
      and(
        found.work.binding.schemaVersion === "work-execution.v2"
          ? eq(WorkDispatchReservationTable.root_work_id, found.work.root_work_id)
          : eq(WorkDispatchReservationTable.work_id, found.work.work_id),
        ne(WorkDispatchReservationTable.state, "released"),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  if (found.work.binding.schemaVersion === "work-execution.v2") {
    const { WorkKnownRecovery } = yield* Effect.promise(() => import("./work-known-recovery"))
    yield* WorkKnownRecovery.requireContinuation(db, found.work).pipe(
      Effect.mapError(() => new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED", message: "Explicit known recovery continuation is required" })))
  }
  if (pending.some((row) => row.state === "unknown" || row.state === "dispatching"))
    return yield* failure("WORK_RECOVERY_REQUIRED", "Work has an unsettled physical dispatch")
  if (found.work.binding.schemaVersion === "work-execution.v1" && pending.some((row) => row.state === "settled"))
    return yield* failure("WORK_BUDGET_EXHAUSTED", "The text-only physical dispatch has already completed")
  return found.work
})

/** Must run before Agent/model/Context loading. The trusted verifier reads current source/route
 * facts in the same transaction. Dispatch still needs its separate one-way atomic permit. */
export const requireContext = Effect.fn("WorkAuthority.requireContext")(function* (
  db: Db,
  input: Parameters<typeof requireRunnable>[1],
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const work = yield* requireRunnable(tx, input)
        if (!work) return undefined
        yield* verifyExisting(tx, work)
        return work
      }),
    { behavior: "immediate" },
  )
})

/** Current authority for an already admitted operation. Unlike a new drain, a tool belonging
 * to this turn may run while its own provider reservation is dispatching/settled. Callers
 * must additionally verify that exact receipt/attempt/claim; this does not grant execution. */
export const requireCurrentControlInTransaction = Effect.fn("WorkAuthority.requireCurrentControlInTransaction")(function* (
  tx: Transaction,
  input: { readonly workID: string; readonly expectedRevision: number },
) {
  const work = yield* requireWork(tx, input.workID)
  yield* current(work, input.expectedRevision, Date.now())
  if (work.outcome !== "pending") return yield* failure("WORK_NOT_READY", "Work is no longer pending")
  yield* verifyExisting(tx, work)
  return work
})

export type ReserveDispatchInput = {
  readonly workID: string
  readonly dispatchKey: string
  readonly receiptID: string
  readonly attemptID: string
  readonly sessionClaimToken: number
  readonly ownerToken: string
  readonly contextSelectionID: string
  readonly contextProjectionHash: string
  readonly inputUpperBound: WorkAuthoritySchema.InputBound
  readonly completionTokens: number
  readonly expectedRevision: number
  readonly now?: number
}

/** Called inside canonical commitTurn's transaction, after its real attempt/receipt insert. */
export const reserveDispatchInTransaction = Effect.fn("WorkAuthority.reserveDispatchInTransaction")(function* (
  tx: Transaction,
  input: ReserveDispatchInput,
) {
  const work = yield* requireWork(tx, input.workID)
  const now = input.now ?? Date.now()
  if (work.execution_role === "dag_controller")
    return yield* failure("PROFILE_UNAVAILABLE", "Event controller cannot reserve a provider dispatch")
  yield* current(work, input.expectedRevision, now)
  yield* verifyExisting(tx, work)
  yield* requireReceipt(tx, work, input, now)
  const budget = yield* validated(
    WorkAuthorityPolicy.providerReservation(work.binding.budget, input.inputUpperBound, input.completionTokens),
  )
  if (
    !input.dispatchKey ||
    !input.contextSelectionID ||
    !Schema.is(WorkAuthoritySchema.Digest)(input.contextProjectionHash)
  )
    return yield* failure("WORK_INVALID_REQUEST", "Provider reservation requires context and dispatch identity")
  const { now: ignored, ...request } = input
  const requestHash = Hash.sha256(CanonicalJson.stringify(request))
  const prior = yield* tx
    .select()
    .from(WorkDispatchReservationTable)
    .where(
      and(
        eq(WorkDispatchReservationTable.work_id, work.work_id),
        eq(WorkDispatchReservationTable.dispatch_key, input.dispatchKey),
      ),
    )
    .get()
  if (prior) {
    if (prior.request_hash !== requestHash)
      return yield* failure("WORK_DISPATCH_CONFLICT", "Dispatch identity was reused with different arguments")
    if (prior.state !== "reserved")
      return yield* failure("WORK_RECOVERY_REQUIRED", "A dispatched or terminal reservation cannot be replayed")
    return prior
  }
  const spent = yield* tx
    .select()
    .from(WorkDispatchReservationTable)
    .where(
      and(
        eq(WorkDispatchReservationTable.root_work_id, work.root_work_id),
        ne(WorkDispatchReservationTable.state, "released"),
      ),
    )
    .all()
  if (spent.some((row) => row.state === "unknown" || row.state === "dispatching"))
    return yield* failure("WORK_RECOVERY_REQUIRED", "Root work has an unsettled dispatch")
  const root = work.parent_work_id ? yield* requireWork(tx, work.root_work_id) : work
  const own = spent.filter((row) => row.work_id === work.work_id)
  if (spent.length >= root.binding.budget.maxProviderDispatches ||
    spent.reduce((sum, row) => sum + row.charged_tokens, 0) + budget.totalTokens > root.binding.budget.maxTotalTokens ||
    own.length >= work.binding.budget.maxProviderDispatches ||
    own.reduce((sum, row) => sum + row.charged_tokens, 0) + budget.totalTokens > work.binding.budget.maxTotalTokens)
    return yield* failure("WORK_BUDGET_EXHAUSTED", "Root work has no remaining dispatch budget")
  const hourly = yield* tx
    .select({ charge: WorkDispatchReservationTable.charged_tokens })
    .from(WorkDispatchReservationTable)
    .innerJoin(WorkExecutionTable, eq(WorkDispatchReservationTable.work_id, WorkExecutionTable.work_id))
    .where(
      and(
        eq(WorkExecutionTable.security_namespace_id, work.security_namespace_id),
        eq(WorkExecutionTable.agent_id, work.agent_id),
        ne(WorkDispatchReservationTable.state, "released"),
        or(
          sql`${WorkDispatchReservationTable.created_at} > ${now - work.binding.budget.hourWindowMinutes * 60_000}`,
          eq(WorkDispatchReservationTable.state, "unknown"),
          eq(WorkDispatchReservationTable.state, "dispatching"),
          eq(WorkDispatchReservationTable.state, "reserved"),
        ),
      ),
    )
    .all()
  if (hourly.reduce((sum, row) => sum + row.charge, 0) + budget.totalTokens > work.binding.budget.hourTokensMax)
    return yield* failure("WORK_BUDGET_EXHAUSTED", "Agent namespace rolling-hour budget is exhausted")
  if (root.binding.profile.id === WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id) {
    const sharedHour = yield* tx.all<{ charge: number }>(sql`SELECT r.charged_tokens charge FROM work_dispatch_reservation r
      JOIN work_execution root ON root.work_id=r.root_work_id WHERE root.security_namespace_id=${root.security_namespace_id}
      AND root.agent_id=${root.agent_id} AND r.state != 'released' AND
      (r.created_at > ${now - root.binding.budget.hourWindowMinutes * 60_000} OR r.state IN ('unknown','dispatching','reserved'))`)
    if (sharedHour.reduce((sum, row) => sum + row.charge, 0) + budget.totalTokens > root.binding.budget.hourTokensMax)
      return yield* failure("WORK_BUDGET_EXHAUSTED", "Shared root namespace rolling-hour budget is exhausted")
  }
  const row = yield* tx
    .insert(WorkDispatchReservationTable)
    .values({
      reservation_id: `wdr_${Hash.sha256(CanonicalJson.stringify([work.work_id, input.dispatchKey]))}`,
      work_id: work.work_id,
      root_work_id: work.root_work_id,
      kind: "provider",
      dispatch_key: input.dispatchKey,
      request_hash: requestHash,
      receipt_id: input.receiptID,
      attempt_id: input.attemptID,
      session_claim_token: input.sessionClaimToken,
      owner_token: input.ownerToken,
      control_revision: input.expectedRevision,
      context_selection_id: input.contextSelectionID,
      context_projection_hash: input.contextProjectionHash,
      state: "reserved",
      input_bound: input.inputUpperBound,
      reserved_input_tokens: budget.inputTokens,
      reserved_completion_tokens: budget.completionTokens,
      reserved_total_tokens: budget.totalTokens,
      charged_tokens: budget.totalTokens,
      created_at: now,
    })
    .returning()
    .get()
  if (!row) return yield* failure("WORK_DISPATCH_CONFLICT", "Dispatch reservation returned no row")
  return row
})

/** The caller MUST run this inside the provider receipt's preparing→dispatching transaction.
 * A returned row is a one-way permit, not permission to retry a later physical send. */
export const authorizeDispatchInTransaction = Effect.fn("WorkAuthority.authorizeDispatchInTransaction")(function* (
  tx: Transaction,
  input: {
    readonly reservationID: string
    readonly expectedRevision: number
    readonly wireHash: string
    readonly method: string | undefined
    readonly endpoint: string | undefined
    readonly contextSelectionID: string
    readonly contextProjectionHash: string
    readonly now?: number
  },
) {
  const reservation = yield* requireReservation(tx, input.reservationID)
  const work = yield* requireWork(tx, reservation.work_id)
  const now = input.now ?? Date.now()
  yield* current(work, input.expectedRevision, now)
  if (reservation.state !== "reserved" || reservation.control_revision !== input.expectedRevision)
    return yield* failure("WORK_DISPATCH_CONFLICT", "The dispatch permit is stale or already consumed")
  yield* requireReceipt(
    tx,
    work,
    {
      receiptID: reservation.receipt_id,
      attemptID: reservation.attempt_id,
      sessionClaimToken: reservation.session_claim_token,
      ownerToken: reservation.owner_token,
      contextSelectionID: reservation.context_selection_id,
      contextProjectionHash: reservation.context_projection_hash,
    },
    now,
  )
  yield* verifyExisting(tx, work)
  if (input.method !== "POST" || input.endpoint === undefined || !Schema.is(WorkAuthoritySchema.Digest)(input.wireHash))
    return yield* failure("WORK_ENDPOINT_DENIED", "Restricted dispatch requires a complete final HTTP seal")
  const endpoint = yield* validated(
    WorkAuthorityPolicy.normalizeEndpoint(input.endpoint, { allowLoopbackHTTP: work.loopback_http }),
  )
  if (
    endpoint !== work.binding.provider.endpoint ||
    input.contextSelectionID !== reservation.context_selection_id ||
    input.contextProjectionHash !== reservation.context_projection_hash
  )
    return yield* failure("WORK_BINDING_CONFLICT", "Final endpoint or Context differs from the reserved dispatch")
  const row = yield* tx
    .update(WorkDispatchReservationTable)
    .set({ state: "dispatching", wire_hash: input.wireHash, endpoint, dispatching_at: now })
    .where(
      and(
        eq(WorkDispatchReservationTable.reservation_id, input.reservationID),
        eq(WorkDispatchReservationTable.state, "reserved"),
        eq(WorkDispatchReservationTable.control_revision, input.expectedRevision),
      ),
    )
    .returning()
    .get()
  if (!row) return yield* failure("WORK_DISPATCH_CONFLICT", "Dispatch permit was already consumed")
  return row
})

export const settleDispatchInTransaction = Effect.fn("WorkAuthority.settleDispatchInTransaction")(function* (
  tx: Transaction,
  input: {
    readonly reservationID: string
    readonly outcome: "settled" | "unknown" | "released"
    readonly usage?: WorkAuthoritySchema.Usage
    readonly now?: number
  },
) {
  const prior = yield* requireReservation(tx, input.reservationID)
  yield* validated(WorkAuthorityPolicy.checkDispatchTransition(prior.state, input.outcome))
  if (prior.state === input.outcome) {
    if (CanonicalJson.stringify(prior.actual_usage ?? undefined) !== CanonicalJson.stringify(input.usage))
      return yield* failure("WORK_DISPATCH_CONFLICT", "Settlement retry carries different usage")
    return prior
  }
  if (input.outcome === "settled" && !input.usage)
    return yield* failure("WORK_INVALID_REQUEST", "Known settlement requires provider usage")
  if (input.outcome !== "settled" && input.usage)
    return yield* failure("WORK_INVALID_REQUEST", "Unknown or undispatched outcomes cannot invent terminal usage")
  const actual = input.usage ? yield* validated(WorkAuthorityPolicy.usageTotal(input.usage)) : undefined
  const overrun =
    input.usage !== undefined &&
    (input.usage.inputTokens > prior.reserved_input_tokens ||
      input.usage.completionTokens > prior.reserved_completion_tokens)
  const state = overrun ? "unknown" : input.outcome
  const now = input.now ?? Date.now()
  const row = yield* tx
    .update(WorkDispatchReservationTable)
    .set({
      state,
      actual_usage: input.usage ?? null,
      charged_tokens:
        state === "released" ? 0 : state === "settled" ? actual! : Math.max(prior.charged_tokens, actual ?? 0),
      error_code: overrun ? "WORK_BUDGET_EXCEEDED_BY_PROVIDER" : null,
      settled_at: state === "unknown" ? null : now,
    })
    .where(
      and(
        eq(WorkDispatchReservationTable.reservation_id, prior.reservation_id),
        eq(WorkDispatchReservationTable.state, prior.state),
      ),
    )
    .returning()
    .get()
  if (!row) return yield* failure("WORK_DISPATCH_CONFLICT", "Dispatch changed during settlement")
  if (state === "unknown")
    yield* tx
      .update(WorkExecutionTable)
      .set({ outcome: "unknown", updated_at: now })
      .where(eq(WorkExecutionTable.work_id, prior.work_id))
      .run()
  return row
})

export const control = Effect.fn("WorkAuthority.control")(function* (
  db: Db,
  input: {
    readonly workID: string
    readonly requestID: string
    readonly expectedRevision: number
    readonly action: "pause" | "resume" | "revoke" | "cancel"
    readonly now?: number
  },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const work = yield* requireWork(tx, input.workID)
        const prior = work.control_receipts.find((receipt) => receipt.requestID === input.requestID)
        if (prior) {
          if (prior.action !== input.action || prior.expectedRevision !== input.expectedRevision)
            return yield* failure("WORK_REQUEST_CONFLICT", "Control request identity was reused")
          return { work, receipt: prior }
        }
        if (!input.requestID || input.expectedRevision !== work.control_revision || work.control_receipts.length >= 128)
          return yield* failure("WORK_CONTROL_CONFLICT", "Control revision changed or receipt capacity was reached")
        if (["revoked", "cancelled", "expired"].includes(work.control_state))
          return yield* failure("WORK_REVOKED", "Terminal work control cannot be reopened")
        if (input.action === "resume" && (work.control_state !== "paused" || work.outcome === "unknown"))
          return yield* failure(
            work.outcome === "unknown" ? "WORK_RECOVERY_REQUIRED" : "WORK_CONTROL_CONFLICT",
            "Work cannot resume from this state",
          )
        const state =
          input.action === "pause"
            ? "paused"
            : input.action === "resume"
              ? "active"
              : input.action === "revoke"
                ? "revoked"
                : "cancelled"
        const receipt = {
          requestID: input.requestID,
          action: input.action,
          expectedRevision: input.expectedRevision,
          revision: work.control_revision + 1,
          state,
        } as const
        const updated = yield* tx
          .update(WorkExecutionTable)
          .set({
            control_state: state,
            control_revision: receipt.revision,
            control_receipts: [...work.control_receipts, receipt],
            updated_at: input.now ?? Date.now(),
          })
          .where(
            and(
              eq(WorkExecutionTable.work_id, work.work_id),
              eq(WorkExecutionTable.control_revision, input.expectedRevision),
            ),
          )
          .returning()
          .get()
        if (!updated) return yield* failure("WORK_CONTROL_CONFLICT", "Work control changed concurrently")
        return { work: updated, receipt }
      }),
    { behavior: "immediate" },
  )
})

/** Result authority is stronger than a settled provider receipt: require the consumed permit,
 * exact accounted usage and the completed, actually projected assistant of this single-input
 * Work. Caller may add activity/outbox writes to the SAME transaction. No physical retry occurs. */
export const completeInTransaction = Effect.fn("WorkAuthority.completeInTransaction")(function* (
  tx: Transaction,
  input: {
    readonly workID: string
    readonly expectedRevision: number
    readonly receiptID: string
    readonly assistantMessageID: string
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const work = yield* requireWork(tx, input.workID)
  yield* current(work, input.expectedRevision, now)
  yield* verifyExisting(tx, work)
  yield* WorkExecutionProfile.requirePlacement(tx, work)
  const reservations = yield* tx
    .select()
    .from(WorkDispatchReservationTable)
    .where(eq(WorkDispatchReservationTable.work_id, work.work_id))
    .all()
  const consumed = reservations.filter((reservation) => reservation.state !== "released")
  const project = work.binding.schemaVersion === "work-execution.v2"
  const permit = project ? consumed.find((row) => row.receipt_id === input.receiptID) : consumed[0]
  if (
    (!project && consumed.length !== 1) ||
    (project && (consumed.length < 1 || consumed.length > work.binding.budget.maxProviderDispatches ||
      consumed.some((row) => row.state !== "settled" || !row.actual_usage))) ||
    !permit ||
    permit.receipt_id !== input.receiptID ||
    permit.state !== "settled" ||
    permit.control_revision !== input.expectedRevision ||
    !permit.actual_usage
  )
    return yield* failure("WORK_RECOVERY_REQUIRED", "Work lacks one fully accounted physical result")
  const charged = yield* validated(WorkAuthorityPolicy.usageTotal(permit.actual_usage))
  if (project) {
    const { WorkToolPolicy } = yield* Effect.promise(() => import("./work-tool-policy"))
    const predecessor = yield* WorkToolPolicy.previous(tx, work, input.receiptID)
    if ((consumed.length > 1 && !predecessor) || (consumed.length === 1 && predecessor))
      return yield* failure("WORK_RECOVERY_REQUIRED", "Project results do not form the authenticated predecessor chain")
    for (const row of consumed) {
      if (row.control_revision !== input.expectedRevision) {
        const { WorkKnownRecovery } = yield* Effect.promise(() => import("./work-known-recovery"))
        yield* WorkKnownRecovery.requireBridge(tx, work, { reservation: row }).pipe(
          Effect.mapError(() => new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED", message: "Historical charge lacks explicit current recovery" })))
      }
      if (!row.actual_usage || (yield* validated(WorkAuthorityPolicy.usageTotal(row.actual_usage))) !== row.charged_tokens)
        return yield* failure("WORK_RECOVERY_REQUIRED", "Project cumulative provider charges are inconsistent")
    }
  }
  const receipt = yield* tx
    .select()
    .from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptID))
    .get()
  const messages = yield* tx
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make(work.session_id)))
    .limit(project ? 34 : 3)
    .all()
  const assistant = messages.find((message) => message.id === input.assistantMessageID)
  const projected = assistant
    ? Schema.decodeUnknownOption(SessionMessage.Assistant)({
        ...assistant.data,
        id: assistant.id,
        type: assistant.type,
      })
    : Option.none()
  const artifact = Schema.decodeUnknownOption(Schema.Array(LLMEvent))(receipt?.outcome_artifact)
  if (
    !receipt ||
    receipt.session_id !== work.session_id ||
    receipt.user_message_id !== work.input_id ||
    receipt.state !== "settled" ||
    receipt.wire_request_hash !== permit.wire_hash ||
    receipt.provider_attempt_id !== permit.attempt_id ||
    receipt.outcome_hash !== Hash.sha256(CanonicalJson.stringify(receipt.outcome_artifact)) ||
    charged !== permit.charged_tokens ||
    messages.length !== (project ? consumed.length + 1 : 2) ||
    !messages.some((message) => message.id === work.input_id && message.type === "user") ||
    Option.isNone(projected) ||
    Option.isNone(artifact)
  )
    return yield* failure("WORK_RECOVERY_REQUIRED", "Projected result or provider/Work accounting is inconsistent")
  const finish = artifact.value.filter(LLMEvent.is.finish)
  const steps = artifact.value.filter(LLMEvent.is.stepFinish)
  const deltas = artifact.value.filter(LLMEvent.is.textDelta).reduce((values, event) => {
    const chunks = values.get(event.id)
    if (chunks) {
      chunks.push(event.text)
      return values
    }
    values.set(event.id, [event.text])
    return values
  }, new Map<string, string[]>())
  const ends = artifact.value.filter(LLMEvent.is.textEnd)
  const ended = new Set(ends.map((event) => event.id))
  const texts = projected.value.content.filter((part) => part.type === "text")
  const textIDs = new Set(texts.map((text) => text.id))
  if (
    finish.length !== 1 ||
    steps.length !== 1 ||
    finish[0]?.usage?.inputTokens !== permit.actual_usage.inputTokens ||
    finish[0]?.usage?.outputTokens !== permit.actual_usage.completionTokens ||
    finish[0]?.usage?.reasoningTokens !== permit.actual_usage.reasoningTokens ||
    finish[0]?.reason !== steps[0]?.reason ||
    projected.value.finish !== finish[0]?.reason ||
    projected.value.time.completed === undefined ||
    projected.value.error !== undefined ||
    projected.value.agent !== work.binding.agentID ||
    projected.value.model.providerID !== work.binding.provider.providerID ||
    projected.value.model.id !== work.binding.provider.modelID ||
    projected.value.content.some((part) => part.type === "tool") ||
    texts.length !== ends.length ||
    ended.size !== ends.length ||
    textIDs.size !== texts.length ||
    texts.some((text) => !ended.has(text.id) || (deltas.get(text.id)?.join("") ?? "") !== text.text) ||
    [...deltas.keys()].some((id) => !textIDs.has(id))
  )
    return yield* failure(
      "WORK_RECOVERY_REQUIRED",
      "Visible assistant does not match the unique completed provider turn",
    )
  const outcome = finish[0]?.reason === "stop" && texts.some((text) => text.text.trim()) ? "succeeded" : "failed"
  if (work.outcome !== "pending" && work.outcome !== outcome)
    return yield* failure("WORK_CONTROL_CONFLICT", "Work already has a different terminal result")
  const completed = yield* tx
    .update(WorkExecutionTable)
    .set({ outcome, updated_at: now })
    .where(
      and(
        eq(WorkExecutionTable.work_id, work.work_id),
        eq(WorkExecutionTable.control_revision, input.expectedRevision),
      ),
    )
    .returning()
    .get()
  if (!completed) return yield* failure("WORK_CONTROL_CONFLICT", "Work changed while recording its result")
  return completed
})

const requireWork = Effect.fn("WorkAuthority.requireWork")(function* (db: Reader, workID: string) {
  const work = yield* get(db, workID)
  if (!work) return yield* failure("WORK_AUTHORITY_MISSING", "Work authority was not found")
  const binding = yield* validated(
    WorkAuthorityPolicy.validateBinding(work.binding, { allowLoopbackHTTP: work.loopback_http }),
  )
  if (
    WorkAuthorityPolicy.fingerprint(binding) !== work.binding_hash ||
    work.binding_version !== (binding.schemaVersion === "work-execution.v2" ? 2 : 1) ||
    binding.workID !== work.work_id ||
    binding.sessionID !== work.session_id ||
    binding.inputID !== work.input_id ||
    binding.rootWorkID !== work.root_work_id ||
    (binding.parentWorkID ?? null) !== work.parent_work_id ||
    binding.scope.securityNamespaceID !== work.security_namespace_id ||
    binding.agentID !== work.agent_id ||
    binding.source.kind !== work.source_kind ||
    binding.source.authorityID !== work.authority_id ||
    binding.source.authorityRevision !== work.source_revision ||
    binding.source.requestID !== work.source_request_id
    || work.execution_role !== (binding.profile.id === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id && !binding.parentWorkID ? "dag_controller" : "agent")
  )
    return yield* failure("WORK_BINDING_CONFLICT", "Durable work binding failed its fingerprint check")
  return work
})

const requireReservation = Effect.fn("WorkAuthority.requireReservation")(function* (tx: Transaction, id: string) {
  const row = yield* tx
    .select()
    .from(WorkDispatchReservationTable)
    .where(eq(WorkDispatchReservationTable.reservation_id, id))
    .get()
  if (!row) return yield* failure("WORK_AUTHORITY_MISSING", "Dispatch reservation was not found")
  return row
})

const verify = Effect.fn("WorkAuthority.verify")(function* (tx: Transaction, binding: WorkAuthoritySchema.Binding) {
  const service = yield* Effect.serviceOption(Verifier)
  if (Option.isNone(service))
    return yield* failure("PROFILE_UNAVAILABLE", "Trusted source and provider route verification are not wired")
  const source = yield* service.value.authorizeSource(tx, binding)
  const route = yield* service.value.resolveRoute(tx, binding)
  if (
    source.authorityID !== binding.source.authorityID ||
    source.revision !== binding.source.authorityRevision ||
    !Schema.is(WorkAuthoritySchema.Digest)(source.recordHash)
  )
    return yield* failure("WORK_REVOKED", "Source authority does not match the requested revision")
  if (
    route.evidenceID !== binding.provider.evidenceID ||
    route.evidenceHash !== binding.provider.evidenceHash ||
    route.configurationHash !== binding.provider.configurationHash
  )
    return yield* failure("PROFILE_UNAVAILABLE", "Trusted runtime route evidence does not match the requested route")
  return { source, route }
})

const verifyExisting = Effect.fn("WorkAuthority.verifyExisting")(function* (tx: Transaction, work: Work): Effect.fn.Return<void, WorkAuthoritySchema.Error> {
  if (work.parent_work_id) {
    const { WorkDerivedAuthority } = yield* Effect.promise(() => import("./work-derived-authority"))
    yield* WorkDerivedAuthority.requireCurrent(tx, work).pipe(Effect.mapError((error) =>
      error instanceof WorkAuthoritySchema.Error ? error : new WorkAuthoritySchema.Error({
        code: "WORK_RECOVERY_REQUIRED", message: "Original derived child authority could not be verified",
      })))
    return
  }
  const proof = yield* verify(tx, work.binding)
  if (proof.source.recordHash !== work.source_record_hash || proof.route.evidenceHash !== work.route_evidence_hash)
    return yield* failure("WORK_REVOKED", "Source or route authority changed after admission")
})

const current = Effect.fn("WorkAuthority.current")(function* (work: Work, revision: number, now: number, ready = true) {
  if (work.control_revision !== revision)
    return yield* failure("WORK_CONTROL_CONFLICT", "Work control revision changed")
  if (work.outcome === "unknown")
    return yield* failure("WORK_RECOVERY_REQUIRED", "Unknown work outcome requires explicit recovery")
  if (work.control_state === "paused") return yield* failure("WORK_PAUSED", "Work is paused")
  if (work.control_state !== "active") return yield* failure("WORK_REVOKED", "Work control is terminal")
  if (work.binding.deadline <= now || work.created_at + work.binding.budget.maxDurationMs <= now)
    return yield* failure("WORK_EXPIRED", "Work deadline expired")
  if (ready && work.admission_state !== "ready") return yield* failure("WORK_NOT_READY", "Work input has not committed")
})

const requireReceipt = Effect.fn("WorkAuthority.requireReceipt")(function* (
  tx: Transaction,
  work: Work,
  input: {
    readonly receiptID: string
    readonly attemptID: string
    readonly sessionClaimToken: number
    readonly ownerToken: string
    readonly contextSelectionID: string
    readonly contextProjectionHash: string
  },
  now: number,
) {
  const session = yield* tx
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id)))
    .get()
  const receipt = yield* tx
    .select()
    .from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.receipt_id, input.receiptID))
    .get()
  const prompt = yield* tx
    .select()
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, SessionMessage.ID.make(work.input_id)))
    .get()
  const attempt = yield* tx
    .select()
    .from(SessionProviderAttemptTable)
    .where(eq(SessionProviderAttemptTable.attempt_id, input.attemptID))
    .get()
  const selection = yield* tx
    .select()
    .from(SessionContextSelectionTable)
    .where(eq(SessionContextSelectionTable.selection_id, input.contextSelectionID))
    .get()
  const owner = yield* tx
    .select()
    .from(SessionProviderOwnerLeaseTable)
    .where(eq(SessionProviderOwnerLeaseTable.owner_token, input.ownerToken))
    .get()
  if (
    !session ||
    !session.v2_authority ||
    session.agent !== work.binding.agentID ||
    !matchesSessionModel(session, work.binding) ||
    session.execution_claim_token !== input.sessionClaimToken ||
    !prompt ||
    prompt.session_id !== work.session_id ||
    prompt.admitted_seq !== work.admitted_seq ||
    !receipt ||
    receipt.session_id !== work.session_id ||
    receipt.user_message_id !== work.input_id ||
    receipt.provider_attempt_id !== input.attemptID ||
    receipt.owner_token !== input.ownerToken ||
    !["preparing", "dispatching"].includes(receipt.state) ||
    receipt.provider_id !== work.binding.provider.providerID ||
    receipt.model_id !== work.binding.provider.modelID ||
    receipt.protocol !== work.binding.provider.protocol ||
    !attempt ||
    attempt.session_id !== work.session_id ||
    attempt.activity_id !== receipt.activity_id ||
    attempt.owner_token !== input.ownerToken ||
    attempt.execution_claim_token !== input.sessionClaimToken ||
    attempt.provider_id !== work.binding.provider.providerID ||
    attempt.selection_id !== input.contextSelectionID ||
    attempt.projection_hash !== input.contextProjectionHash ||
    !["prepared", "dispatching"].includes(attempt.state) ||
    !selection ||
    selection.session_id !== work.session_id ||
    selection.activity_id !== receipt.activity_id ||
    selection.trigger_input_id !== work.input_id ||
    selection.projection_hash !== input.contextProjectionHash ||
    selection.security_namespace_id !== work.binding.scope.securityNamespaceID ||
    selection.project_scope_key !== work.binding.scope.projectScopeKey ||
    !owner ||
    owner.released_at !== null ||
    owner.lease_expires_at <= now ||
    session.directory !== work.binding.location.directory ||
    session.workspace_id !== (work.binding.location.workspaceID ?? null)
  )
    return yield* failure(
      "WORK_BINDING_CONFLICT",
      "Provider receipt, inbox, claim or placement does not match the work",
    )
})

function validated<A>(result: WorkAuthoritySchema.Validation<A>) {
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)
}

function failure(code: WorkAuthoritySchema.ErrorCode, message: string) {
  return Effect.fail(new WorkAuthoritySchema.Error({ code, message }))
}

function matchesRestrictedPrompt(
  prompt: (typeof SessionInputTable.$inferSelect)["prompt"],
  binding: WorkAuthoritySchema.Binding,
) {
  return (
    Object.keys(prompt).every((key) => ["text", "agent", "model"].includes(key)) &&
    (prompt.agent === undefined || prompt.agent === binding.agentID) &&
    (prompt.model === undefined ||
      (prompt.model.id === binding.provider.modelID &&
        prompt.model.providerID === binding.provider.providerID &&
        prompt.model.variant === undefined))
  )
}

function matchesSessionModel(session: typeof SessionTable.$inferSelect, binding: WorkAuthoritySchema.Binding) {
  return (
    session.model?.id === binding.provider.modelID &&
    session.model.providerID === binding.provider.providerID &&
    session.model.variant === undefined
  )
}
