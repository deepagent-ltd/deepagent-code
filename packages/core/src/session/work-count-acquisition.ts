export * as WorkCountAcquisition from "./work-count-acquisition"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { CanonicalJson } from "../util/canonical-json"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionInputTable, SessionTable } from "./sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { WorkAuthority } from "./work-authority"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkRouteApproval } from "./work-route-approval"
import { WorkCountAcquisitionSchema } from "./work-count-acquisition.schema"
import { WorkCountAcquisitionTable } from "./work-count-acquisition.sql"
import { WorkToolPolicy } from "./work-tool-policy"
import { WorkDerivedAuthority } from "./work-derived-authority"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
type Reader = Pick<Db, "select">
type Owner = { acquisitionID: string; expectedRevision: number; ownerToken: string; bootID: string }
type ProjectOwner = Owner & { workID: string; turnKey: string }
/** Host only, no default. requireCapture validates the actual final request and credential
 * generation through an opaque private registry; schema fields are not construction proof. */
export class Authority extends Context.Service<
  Authority,
  {
    readonly requireCapture: (
      binding: WorkCountAcquisitionSchema.Binding,
    ) => Effect.Effect<void, WorkCountAcquisitionSchema.Error>
    readonly authenticate: (
      record: WorkCountAcquisitionSchema.Record,
    ) => Effect.Effect<string, WorkCountAcquisitionSchema.Error>
    readonly verify: (
      record: WorkCountAcquisitionSchema.Record,
      mac: string,
    ) => Effect.Effect<void, WorkCountAcquisitionSchema.Error>
    readonly requireProjectCapture?: (binding: WorkCountAcquisitionSchema.ProjectBinding) => Effect.Effect<void, WorkCountAcquisitionSchema.Error>
    readonly authenticateProject?: (record: WorkCountAcquisitionSchema.ProjectRecord) => Effect.Effect<string, WorkCountAcquisitionSchema.Error>
    readonly verifyProject?: (record: WorkCountAcquisitionSchema.ProjectRecord, mac: string) => Effect.Effect<void, WorkCountAcquisitionSchema.Error>
  }
>()("@deepagent-code/WorkCountAcquisition/Authority") {}
const hash = WorkRouteApproval.hash
export const failure = (code: WorkCountAcquisitionSchema.Error["code"]) =>
  new WorkCountAcquisitionSchema.Error({ code, message: "Native token-count acquisition is unavailable or changed" })
const authority = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value)) return yield* failure("COUNT_UNAVAILABLE")
  return value.value
})
function decode<A>(schema: Schema.Decoder<A>, input: unknown) {
  const value = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(failure("COUNT_INVALID_RECORD"))
}
export function sealedRequestHash(
  input: Pick<
    WorkCountAcquisitionSchema.Binding,
    "wireHash" | "nonsecretHeadersHash" | "credentialFingerprint" | "credentialGeneration"
  >,
) {
  return hash({
    version: "native-sealed-request.v1",
    wireHash: input.wireHash,
    nonsecretHeadersHash: input.nonsecretHeadersHash,
    credentialFingerprint: input.credentialFingerprint,
    credentialGeneration: input.credentialGeneration,
  })
}

/** Read-only, including expired sending records. Explicit recovery is a separate CAS. */
export const get = Effect.fn("WorkCountAcquisition.get")(function* (db: Reader, workID: string) {
  const size = yield* query(() =>
    db
      .select({ bytes: sql<number>`length(CAST(${WorkCountAcquisitionTable.record} AS BLOB))` })
      .from(WorkCountAcquisitionTable)
      .where(and(eq(WorkCountAcquisitionTable.work_id, workID), eq(WorkCountAcquisitionTable.slot_version, 1)))
      .get(),
  )
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkCountAcquisitionSchema.MAX_RECORD_BYTES)
    return yield* failure("COUNT_INVALID_RECORD")
  const row = yield* query(() =>
    db
      .select()
      .from(WorkCountAcquisitionTable)
      .where(
        and(
          eq(WorkCountAcquisitionTable.work_id, workID),
          eq(WorkCountAcquisitionTable.slot_version, 1),
          sql`length(CAST(${WorkCountAcquisitionTable.record} AS BLOB)) BETWEEN 1 AND ${WorkCountAcquisitionSchema.MAX_RECORD_BYTES}`,
        ),
      )
      .get(),
  )
  if (!row) return yield* failure("COUNT_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(WorkCountAcquisitionSchema.Record), row.record)
  if (hash(columns(record, row.record_mac)) !== hash(row) || invalidRecord(record))
    return yield* failure("COUNT_INVALID_RECORD")
  yield* (yield* authority).verify(record, row.record_mac)
  return record
})

/** A v2 caller must supply the exact canonical turn locator. This never changes legacy
 * get(workID) into a latest-record lookup and performs no acquire/retry/repair. */
export const getTurn = Effect.fn("WorkCountAcquisition.getTurn")(function* (db: Reader, workID: string, turnKey: string) {
  const where = and(eq(WorkCountAcquisitionTable.work_id, workID), eq(WorkCountAcquisitionTable.slot_version, 2),
    eq(WorkCountAcquisitionTable.turn_key, turnKey))
  const size = yield* query(() => db.select({ bytes: sql<number>`length(CAST(${WorkCountAcquisitionTable.record} AS BLOB))` })
    .from(WorkCountAcquisitionTable).where(where).get())
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkCountAcquisitionSchema.MAX_RECORD_BYTES)
    return yield* failure("COUNT_INVALID_RECORD")
  const row = yield* query(() => db.select().from(WorkCountAcquisitionTable).where(and(where,
    sql`length(CAST(${WorkCountAcquisitionTable.record} AS BLOB)) BETWEEN 1 AND ${WorkCountAcquisitionSchema.MAX_RECORD_BYTES}`)).get())
  if (!row) return yield* failure("COUNT_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(WorkCountAcquisitionSchema.ProjectRecord), row.record)
  if (hash(columns(record, row.record_mac)) !== hash(row) || invalidRecord(record)) return yield* failure("COUNT_INVALID_RECORD")
  const current = yield* authority
  if (!current.verifyProject) return yield* failure("COUNT_UNAVAILABLE")
  yield* current.verifyProject(record, row.record_mac)
  return record
})

/** A successor consumes a new disclosure slot only for the actual canonical next turn.
 * Unknown/root-unsettled predecessors are rejected before insert, even with a new ID. */
export const prepareTurn = Effect.fn("WorkCountAcquisition.prepareTurn")(function* (db: Db, input: {
  acquisitionID: string; binding: WorkCountAcquisitionSchema.ProjectBinding;
  ownerToken: string; bootID: string; deadline: number;
}) {
  yield* decode(WorkCountAcquisitionSchema.ProjectBinding, input.binding)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const now = Date.now()
    const prior = yield* getTurn(tx, input.binding.workID, input.binding.turn.key)
    if (prior) {
      if (prior.acquisitionID !== input.acquisitionID || hash(prior.binding) !== hash(input.binding))
        return yield* failure("COUNT_BINDING_CONFLICT")
      if (prior.state === "unknown") return yield* failure("COUNT_UNKNOWN")
      if (prior.state === "failed") return yield* failure("COUNT_REJECTED")
      if (prior.state === "sending") return yield* failure("COUNT_BUSY")
      yield* requireCurrent(tx, prior.binding, now)
      if (prior.state === "settled") {
        if (!prior.result || prior.result.expiresAt <= now) return yield* failure("COUNT_EXPIRED")
        return prior
      }
      if (prior.ownerToken !== input.ownerToken || prior.bootID !== input.bootID) return yield* failure("COUNT_OWNER_CONFLICT")
      if (prior.deadline <= now) return yield* failure("COUNT_EXPIRED")
      return prior
    }
    const current = yield* requireCurrent(tx, input.binding, now)
    const work = yield* WorkAuthority.get(tx, input.binding.workID)
    if (!work) return yield* failure("COUNT_BINDING_CONFLICT")
    yield* WorkDerivedAuthority.requireCountBudget(tx, work, input.binding.providerReceiptID).pipe(Effect.mapError(() => failure("COUNT_REJECTED")))
    if (input.deadline <= now || input.deadline > now + 10_000 || input.deadline > current.deadline)
      return yield* failure("COUNT_EXPIRED")
    const record: WorkCountAcquisitionSchema.ProjectRecord = { version: 2, acquisitionID: input.acquisitionID,
      binding: input.binding, state: "prepared", revision: 1, ownerToken: input.ownerToken, bootID: input.bootID,
      deadline: input.deadline, result: null, errorCode: null, createdAt: now, updatedAt: now, sendingAt: null, terminalAt: null }
    yield* save(tx, record)
    return record
  }), { behavior: "immediate" })
})

export const beginSendingTurn = Effect.fn("WorkCountAcquisition.beginSendingTurn")(function* (db: Db, input: ProjectOwner) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const record = yield* ownedTurn(tx, input)
    const now = Date.now()
    if (record.state !== "prepared") return yield* failure(record.state === "unknown" ? "COUNT_UNKNOWN" : "COUNT_BUSY")
    if (record.deadline <= now) return yield* failure("COUNT_EXPIRED")
    yield* requireCurrent(tx, record.binding, now)
    const work = yield* WorkAuthority.get(tx, record.binding.workID)
    if (!work) return yield* failure("COUNT_BINDING_CONFLICT")
    yield* WorkDerivedAuthority.requireCountBudget(tx, work, record.binding.providerReceiptID).pipe(Effect.mapError(() => failure("COUNT_REJECTED")))
    const next = { ...record, state: "sending" as const, revision: record.revision + 1, sendingAt: now, updatedAt: now }
    yield* save(tx, next, record)
    return next
  }), { behavior: "immediate" })
})

export const settleTurn = Effect.fn("WorkCountAcquisition.settleTurn")(function* (db: Db,
  input: ProjectOwner & { result: WorkCountAcquisitionSchema.Result },
) {
  const result = yield* decode(WorkCountAcquisitionSchema.Result, input.result)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const record = yield* ownedTurn(tx, input)
    const now = Date.now()
    if (record.state !== "sending") return yield* failure("COUNT_OWNER_CONFLICT")
    if (now < record.updatedAt) return yield* failure("COUNT_INVALID_RECORD")
    if (record.deadline <= now) return yield* failure("COUNT_EXPIRED")
    const current = yield* requireCurrent(tx, record.binding, now)
    if (record.sendingAt === null || result.countedAt < record.sendingAt || result.countedAt > now ||
      result.expiresAt <= now || result.expiresAt > current.deadline) return yield* failure("COUNT_INVALID_RESPONSE")
    const next = { ...record, state: "settled" as const, result, revision: record.revision + 1, updatedAt: now, terminalAt: now }
    yield* save(tx, next, record)
    return next
  }), { behavior: "immediate" })
})

export const stopTurn = Effect.fn("WorkCountAcquisition.stopTurn")(function* (db: Db, input: ProjectOwner) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const record = yield* ownedTurn(tx, input)
    if (record.state !== "prepared" && record.state !== "sending") return record
    const now = Date.now()
    const next = { ...record, state: record.state === "prepared" ? "failed" as const : "unknown" as const,
      errorCode: "COUNT_CANCELLED" as const, revision: record.revision + 1, updatedAt: now, terminalAt: now }
    yield* save(tx, next, record)
    return next
  }), { behavior: "immediate" })
})

export const recoverTurn = Effect.fn("WorkCountAcquisition.recoverTurn")(function* (db: Db,
  input: { workID: string; turnKey: string; expectedRevision: number },
) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const record = yield* getTurn(tx, input.workID, input.turnKey)
    if (!record) return yield* failure("COUNT_UNAVAILABLE")
    if (record.revision !== input.expectedRevision) return yield* failure("COUNT_OWNER_CONFLICT")
    const now = Date.now()
    if (record.state !== "sending" || record.deadline > now) return yield* failure("COUNT_BUSY")
    const next = { ...record, state: "unknown" as const, errorCode: "COUNT_OWNER_LOST" as const,
      revision: record.revision + 1, updatedAt: now, terminalAt: now }
    yield* save(tx, next, record)
    return next
  }), { behavior: "immediate" })
})

const ownedTurn = Effect.fn("WorkCountAcquisition.ownedTurn")(function* (tx: Tx, input: ProjectOwner) {
  const record = yield* getTurn(tx, input.workID, input.turnKey)
  if (!record || record.acquisitionID !== input.acquisitionID || record.revision !== input.expectedRevision ||
    record.ownerToken !== input.ownerToken || record.bootID !== input.bootID) return yield* failure("COUNT_OWNER_CONFLICT")
  return record
})

export const prepare = Effect.fn("WorkCountAcquisition.prepare")(function* (
  db: Db,
  input: {
    acquisitionID: string
    binding: WorkCountAcquisitionSchema.Binding
    ownerToken: string
    bootID: string
    deadline: number
    now?: number
  },
) {
  yield* decode(WorkCountAcquisitionSchema.Binding, input.binding)
  const now = input.now ?? Date.now()
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const prior = yield* get(tx, input.binding.workID)
        if (prior) {
          if (prior.acquisitionID !== input.acquisitionID || hash(prior.binding) !== hash(input.binding))
            return yield* failure("COUNT_BINDING_CONFLICT")
          if (prior.state === "unknown") return yield* failure("COUNT_UNKNOWN")
          if (prior.state === "failed") return yield* failure("COUNT_REJECTED")
          if (prior.state === "sending") return yield* failure("COUNT_BUSY")
          yield* requireCurrent(tx, input.binding, now)
          if (prior.state === "settled") {
            if (!prior.result || prior.result.expiresAt <= now) return yield* failure("COUNT_EXPIRED")
            return prior
          }
          if (prior.ownerToken !== input.ownerToken || prior.bootID !== input.bootID)
            return yield* failure("COUNT_OWNER_CONFLICT")
          if (prior.deadline <= now) return yield* failure("COUNT_EXPIRED")
          return prior
        }
        const current = yield* requireCurrent(tx, input.binding, now)
        if (input.deadline <= now || input.deadline > now + 10_000 || input.deadline > current.deadline)
          return yield* failure("COUNT_EXPIRED")
        const record: WorkCountAcquisitionSchema.Record = {
          version: 1,
          acquisitionID: input.acquisitionID,
          binding: input.binding,
          state: "prepared",
          revision: 1,
          ownerToken: input.ownerToken,
          bootID: input.bootID,
          deadline: input.deadline,
          result: null,
          errorCode: null,
          createdAt: now,
          updatedAt: now,
          sendingAt: null,
          terminalAt: null,
        }
        yield* save(tx, record)
        return record
      }),
    { behavior: "immediate" },
  )
})

/** The committed transition consumes the single disclosure opportunity. The caller may send
 * only after this returns; this store never performs network I/O or retries a sending slot. */
export const beginSending = Effect.fn("WorkCountAcquisition.beginSending")(function* (
  db: Db,
  input: Owner & { workID: string; now?: number },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const record = yield* owned(tx, input)
        const now = input.now ?? Date.now()
        if (record.state !== "prepared")
          return yield* failure(record.state === "unknown" ? "COUNT_UNKNOWN" : "COUNT_BUSY")
        if (record.deadline <= now) return yield* failure("COUNT_EXPIRED")
        yield* requireCurrent(tx, record.binding, now)
        const next = {
          ...record,
          state: "sending" as const,
          revision: record.revision + 1,
          sendingAt: now,
          updatedAt: now,
        }
        yield* save(tx, next, record)
        return next
      }),
    { behavior: "immediate" },
  )
})

/** A prepared slot can change its process owner only by exact CAS, never after disclosure. */
export const claimPrepared = Effect.fn("WorkCountAcquisition.claimPrepared")(function* (
  db: Db,
  input: Owner & { workID: string; nextOwnerToken: string; nextBootID: string; now?: number },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const record = yield* owned(tx, input)
        const now = input.now ?? Date.now()
        if (record.state !== "prepared") return yield* failure("COUNT_BUSY")
        if (record.deadline <= now) return yield* failure("COUNT_EXPIRED")
        yield* requireCurrent(tx, record.binding, now)
        const next = {
          ...record,
          ownerToken: input.nextOwnerToken,
          bootID: input.nextBootID,
          revision: record.revision + 1,
          updatedAt: now,
        }
        yield* save(tx, next, record)
        return next
      }),
    { behavior: "immediate" },
  )
})

export const settle = Effect.fn("WorkCountAcquisition.settle")(function* (
  db: Db,
  input: Owner & { workID: string; result: WorkCountAcquisitionSchema.Result; now?: number },
) {
  const result = yield* decode(WorkCountAcquisitionSchema.Result, input.result)
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const record = yield* owned(tx, input)
        const now = input.now ?? Date.now()
        if (record.state !== "sending") return yield* failure("COUNT_OWNER_CONFLICT")
        if (now < record.updatedAt) return yield* failure("COUNT_INVALID_RECORD")
        if (record.deadline <= now) return yield* failure("COUNT_EXPIRED")
        const current = yield* requireCurrent(tx, record.binding, now)
        // The authenticated response can finish before this transaction obtains the writer.
        // Current authority is checked at settlement time, never at the response timestamp.
        if (record.sendingAt === null || result.countedAt < record.sendingAt || result.countedAt > now ||
          result.expiresAt <= now || result.expiresAt > current.deadline)
          return yield* failure("COUNT_INVALID_RESPONSE")
        const next = {
          ...record,
          state: "settled" as const,
          result,
          revision: record.revision + 1,
          updatedAt: now,
          terminalAt: now,
        }
        yield* save(tx, next, record)
        return next
      }),
    { behavior: "immediate" },
  )
})

/** No response or an uncertain send stays unknown. Only a definite non-disclosing prepared
 * cancellation can be failed. A provider rejection after sending is still not retry authority. */
export const stop = Effect.fn("WorkCountAcquisition.stop")(function* (
  db: Db,
  input: Owner & { workID: string; now?: number },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const record = yield* owned(tx, input)
        if (record.state !== "prepared" && record.state !== "sending") return record
        const now = input.now ?? Date.now()
        const next = {
          ...record,
          state: record.state === "prepared" ? ("failed" as const) : ("unknown" as const),
          errorCode: "COUNT_CANCELLED" as const,
          revision: record.revision + 1,
          updatedAt: now,
          terminalAt: now,
        }
        yield* save(tx, next, record)
        return next
      }),
    { behavior: "immediate" },
  )
})

/** Cold recovery records uncertainty only. It never acquires ownership or contacts the counter. */
export const recoverExpired = Effect.fn("WorkCountAcquisition.recoverExpired")(function* (
  db: Db,
  input: { workID: string; expectedRevision: number; now?: number },
) {
  return yield* db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const record = yield* get(tx, input.workID)
        if (!record) return yield* failure("COUNT_UNAVAILABLE")
        if (record.revision !== input.expectedRevision) return yield* failure("COUNT_OWNER_CONFLICT")
        const now = input.now ?? Date.now()
        if (record.state !== "sending" || record.deadline > now) return yield* failure("COUNT_BUSY")
        const next = {
          ...record,
          state: "unknown" as const,
          errorCode: "COUNT_OWNER_LOST" as const,
          revision: record.revision + 1,
          updatedAt: now,
          terminalAt: now,
        }
        yield* save(tx, next, record)
        return next
      }),
    { behavior: "immediate" },
  )
})

const requireCurrent = Effect.fn("WorkCountAcquisition.requireCurrent")(function* (
  tx: Tx,
  binding: WorkCountAcquisitionSchema.Binding | WorkCountAcquisitionSchema.ProjectBinding,
  now: number,
) {
  const installed = yield* authority
  if ("turn" in binding) {
    if (!installed.requireProjectCapture) return yield* failure("COUNT_UNAVAILABLE")
    yield* installed.requireProjectCapture(binding)
  } else yield* installed.requireCapture(binding)
  if (binding.sealedRequestHash !== sealedRequestHash(binding)) return yield* failure("COUNT_BINDING_CONFLICT")
  const work = yield* WorkAuthority.requireRunnable(tx, { sessionID: binding.sessionID, now })
  if (
    !work ||
    work.work_id !== binding.workID ||
    work.input_id !== binding.inputID ||
    work.binding_hash !== binding.bindingHash ||
    work.control_revision !== binding.controlRevision ||
    work.authority_id !== binding.sourceAuthorityID ||
    work.source_revision !== binding.sourceRevision ||
    work.source_record_hash !== binding.sourceRecordHash
  )
    return yield* failure("COUNT_BINDING_CONFLICT")
  if ("turn" in binding && !WorkAuthorityPolicy.checkProviderTurn(work.binding, binding.turn.providerTurnSeq).ok)
    return yield* failure("COUNT_REJECTED")
  const verifier = yield* Effect.serviceOption(WorkAuthority.Verifier)
  if (Option.isNone(verifier)) return yield* failure("COUNT_UNAVAILABLE")
  const child = work.parent_work_id ? yield* WorkDerivedAuthority.get(tx, work.work_id) : undefined
  if (work.parent_work_id) yield* WorkDerivedAuthority.requireCurrent(tx, work).pipe(Effect.mapError(() => failure("COUNT_REJECTED")))
  const sourceBinding = child ? child.rootBinding : work.binding
  const source = yield* verifier.value.authorizeSource(tx, sourceBinding)
  const route = yield* verifier.value.resolveRoute(tx, sourceBinding)
  if (
    source.authorityID !== binding.sourceAuthorityID ||
    source.revision !== binding.sourceRevision ||
    source.recordHash !== binding.sourceRecordHash ||
    route.evidenceID !== binding.approvalID ||
    route.evidenceHash !== binding.approvalEvidenceHash ||
    route.configurationHash !== binding.configurationStamp
  )
    return yield* failure("COUNT_BINDING_CONFLICT")
  const approval = yield* WorkRouteApproval.requireCurrent(tx, binding.approvalID, now)
  if ("turn" in binding && binding.inputProjectionVersion === "deepseek-responses-project-context-bound.v1") {
    if (!("counterSemantics" in approval.evidence) ||
      approval.evidence.counterSemantics !== binding.counterSemantics ||
      approval.evidence.inputUpperBoundTokens !== binding.inputUpperBoundTokens ||
      !WorkAuthorityPolicy.hasContextBoundProfile(work.binding.profile))
      return yield* failure("COUNT_BINDING_CONFLICT")
  } else if ("counterSemantics" in approval.evidence) return yield* failure("COUNT_BINDING_CONFLICT")
  if (
    approval.revision !== binding.approvalRevision ||
    approval.evidenceHash !== binding.approvalEvidenceHash ||
    approval.evidence.configurationStamp !== binding.configurationStamp ||
    approval.evidence.credentialFingerprint !== binding.credentialFingerprint ||
    approval.evidence.nonsecretHeadersHash !== binding.nonsecretHeadersHash ||
    approval.credentialGeneration !== binding.credentialGeneration ||
    approval.evidence.operatorID !== work.binding.scope.actorID ||
    approval.evidence.securityNamespaceID !== work.security_namespace_id ||
    approval.evidence.projectScopeKey !== work.binding.scope.projectScopeKey ||
    approval.evidence.canonicalRoot !== sourceBinding.location.directory ||
    approval.evidence.providerID !== work.binding.provider.providerID ||
    approval.evidence.modelID !== work.binding.provider.modelID ||
    approval.evidence.routeID !== work.binding.provider.routeID ||
    approval.evidence.endpoint !== work.binding.provider.endpoint
  )
    return yield* failure("COUNT_BINDING_CONFLICT")
  const receipt = yield* query(() =>
    tx
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, binding.providerReceiptID))
      .get(),
  )
  const attempt = yield* query(() =>
    tx
      .select()
      .from(SessionProviderAttemptTable)
      .where(eq(SessionProviderAttemptTable.attempt_id, binding.providerAttemptID))
      .get(),
  )
  const owner = yield* query(() =>
    tx
      .select()
      .from(SessionProviderOwnerLeaseTable)
      .where(eq(SessionProviderOwnerLeaseTable.owner_token, binding.providerOwnerToken))
      .get(),
  )
  const session = yield* query(() =>
    tx
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(binding.sessionID)))
      .get(),
  )
  const admitted = yield* query(() =>
    tx
      .select()
      .from(SessionInputTable)
      .where(eq(SessionInputTable.id, SessionMessage.ID.make(binding.inputID)))
      .get(),
  )
  if (
    !receipt ||
    receipt.state !== "preparing" ||
    receipt.session_id !== binding.sessionID ||
    receipt.user_message_id !== binding.inputID ||
    receipt.provider_attempt_id !== binding.providerAttemptID ||
    receipt.owner_token !== binding.providerOwnerToken ||
    receipt.provider_id !== approval.evidence.providerID ||
    receipt.model_id !== approval.evidence.modelID ||
    receipt.protocol !== approval.evidence.protocol ||
    !attempt ||
    attempt.state !== "prepared" ||
    attempt.session_id !== binding.sessionID ||
    attempt.owner_token !== binding.providerOwnerToken ||
    attempt.execution_claim_token !== binding.sessionClaimToken ||
    !session ||
    !session.v2_authority ||
    session.execution_claim_token !== binding.sessionClaimToken ||
    !owner ||
    owner.released_at !== null ||
    owner.lease_expires_at <= now ||
    !admitted ||
    admitted.session_id !== binding.sessionID ||
    admitted.promoted_seq === null ||
    !WorkAuthorityPolicy.checkAuditedText(work.binding, admitted.prompt.text).ok
  )
    return yield* failure("COUNT_BINDING_CONFLICT")
  if ("turn" in binding) {
    if (work.binding.schemaVersion !== "work-execution.v2" || work.root_work_id !== binding.rootWorkID ||
      binding.turn.key !== hash(["work-provider-turn.v1", work.work_id, receipt.session_id, receipt.activity_id, receipt.provider_turn_seq]) ||
      binding.turn.activityID !== receipt.activity_id || binding.turn.providerTurnSeq !== receipt.provider_turn_seq ||
      binding.turn.providerTurnSeq !== attempt.provider_turn_seq || binding.turn.contextSelectionID !== attempt.selection_id ||
      binding.turn.contextProjectionHash !== attempt.projection_hash || binding.turn.historyPromptEpoch !== receipt.history_prompt_epoch ||
      binding.turn.historySourceEndMessageID !== receipt.history_source_end_message_id)
      return yield* failure("COUNT_BINDING_CONFLICT")
    const previous = yield* WorkToolPolicy.previous(tx, work, receipt.receipt_id).pipe(Effect.mapError(() => failure("COUNT_UNKNOWN")))
    if (!previous && binding.predecessor !== null) return yield* failure("COUNT_BINDING_CONFLICT")
    if (previous) {
      const key = hash(["work-provider-turn.v1", work.work_id, previous.receipt.session_id, previous.receipt.activity_id, previous.receipt.provider_turn_seq])
      const count = yield* getTurn(tx, work.work_id, key)
      if (!count || count.state !== "settled" || !count.result || !binding.predecessor ||
        count.acquisitionID !== binding.predecessor.acquisitionID || previous.receipt.receipt_id !== binding.predecessor.receiptID ||
        previous.receipt.outcome_hash !== binding.predecessor.outcomeHash || previous.toolTerminalHash !== binding.predecessor.toolTerminalHash ||
        previous.receipt.provider_turn_seq + 1 !== receipt.provider_turn_seq || previous.receipt.activity_id !== receipt.activity_id)
        return yield* failure("COUNT_BINDING_CONFLICT")
    } else if (receipt.provider_turn_seq !== 1) return yield* failure("COUNT_BINDING_CONFLICT")
  } else if (work.binding.schemaVersion !== "work-execution.v1") return yield* failure("COUNT_BINDING_CONFLICT")
  return { deadline: Math.min(work.binding.deadline, approval.evidence.expiresAt, owner.lease_expires_at) }
})
const owned = Effect.fn("WorkCountAcquisition.owned")(function* (tx: Tx, input: Owner & { workID: string }) {
  const record = yield* get(tx, input.workID)
  if (
    !record ||
    record.acquisitionID !== input.acquisitionID ||
    record.revision !== input.expectedRevision ||
    record.ownerToken !== input.ownerToken ||
    record.bootID !== input.bootID
  )
    return yield* failure("COUNT_OWNER_CONFLICT")
  return record
})
function columns(record: WorkCountAcquisitionSchema.Record | WorkCountAcquisitionSchema.ProjectRecord, mac: string) {
  return {
    acquisition_id: record.acquisitionID,
    slot_version: record.version,
    root_work_id: record.version === 2 ? record.binding.rootWorkID : null,
    activity_id: record.version === 2 ? record.binding.turn.activityID : null,
    provider_turn_seq: record.version === 2 ? record.binding.turn.providerTurnSeq : null,
    turn_key: record.version === 2 ? record.binding.turn.key : null,
    work_id: record.binding.workID,
    input_id: record.binding.inputID,
    session_id: record.binding.sessionID,
    provider_receipt_id: record.binding.providerReceiptID,
    provider_attempt_id: record.binding.providerAttemptID,
    binding_hash: hash(record.binding),
    approval_id: record.binding.approvalID,
    approval_revision: record.binding.approvalRevision,
    state: record.state,
    revision: record.revision,
    owner_token: record.ownerToken,
    boot_id: record.bootID,
    deadline: record.deadline,
    record: CanonicalJson.stringify(record),
    record_hash: hash(record),
    record_mac: mac,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}
function invalidRecord(record: WorkCountAcquisitionSchema.Record | WorkCountAcquisitionSchema.ProjectRecord) {
  return (
    record.binding.sealedRequestHash !== sealedRequestHash(record.binding) ||
    ("counterSemantics" in record.binding && record.result !== null &&
      record.result.inputTokens !== record.binding.inputUpperBoundTokens) ||
    record.updatedAt < record.createdAt ||
    record.deadline <= record.createdAt ||
    record.deadline > record.createdAt + 10_000 ||
    (record.state === "prepared" &&
      (record.sendingAt !== null ||
        record.terminalAt !== null ||
        record.result !== null ||
        record.errorCode !== null)) ||
    (record.state === "sending" &&
      (record.sendingAt === null ||
        record.terminalAt !== null ||
        record.result !== null ||
        record.errorCode !== null)) ||
    ((record.state === "settled" || record.state === "failed" || record.state === "unknown") &&
      record.terminalAt === null) ||
    (record.state === "settled" && (record.sendingAt === null || !record.result || record.errorCode !== null)) ||
    (record.state !== "settled" && record.result !== null) ||
    (record.state === "unknown" && record.sendingAt === null) ||
    (record.sendingAt !== null && (record.sendingAt < record.createdAt || record.sendingAt >= record.deadline)) ||
    (record.terminalAt !== null && record.terminalAt < (record.sendingAt ?? record.createdAt)) ||
    (record.result &&
      (record.sendingAt === null || record.terminalAt === null ||
        record.result.countedAt < record.sendingAt || record.result.countedAt > record.terminalAt ||
        record.result.expiresAt <= record.terminalAt))
  )
}
const save = Effect.fn("WorkCountAcquisition.save")(function* (
  tx: Tx,
  record: WorkCountAcquisitionSchema.Record | WorkCountAcquisitionSchema.ProjectRecord,
  previous?: WorkCountAcquisitionSchema.Record | WorkCountAcquisitionSchema.ProjectRecord,
) {
  if (record.version === 1) yield* decode(WorkCountAcquisitionSchema.Record, record)
  else yield* decode(WorkCountAcquisitionSchema.ProjectRecord, record)
  if (
    invalidRecord(record) ||
    (previous && record.updatedAt < previous.updatedAt) ||
    Buffer.byteLength(CanonicalJson.stringify(record), "utf8") > WorkCountAcquisitionSchema.MAX_RECORD_BYTES
  )
    return yield* failure("COUNT_INVALID_RECORD")
  const installed = yield* authority
  const mac = yield* record.version === 1 ? installed.authenticate(record)
    : installed.authenticateProject ? installed.authenticateProject(record) : Effect.fail(failure("COUNT_UNAVAILABLE"))
  yield* decode(WorkRouteApprovalSchemaDigest, mac)
  if (!previous) {
    yield* query(() => tx.insert(WorkCountAcquisitionTable).values(columns(record, mac)).run())
    return
  }
  const row = yield* query(() =>
    tx
      .update(WorkCountAcquisitionTable)
      .set(columns(record, mac))
      .where(
        and(
          eq(WorkCountAcquisitionTable.acquisition_id, previous.acquisitionID),
          eq(WorkCountAcquisitionTable.revision, previous.revision),
          eq(WorkCountAcquisitionTable.owner_token, previous.ownerToken),
          eq(WorkCountAcquisitionTable.boot_id, previous.bootID),
          eq(WorkCountAcquisitionTable.state, previous.state),
        ),
      )
      .returning()
      .get(),
  )
  if (!row) return yield* failure("COUNT_OWNER_CONFLICT")
})
const WorkRouteApprovalSchemaDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

// Drizzle can throw while preparing a native SQLite statement before returning its Effect.
// Capture both preparation and execution errors at the database boundary only.
function query<A, E, R>(execute: () => Effect.Effect<A, E, R>) {
  return Effect.try({ try: execute, catch: () => failure("COUNT_UNAVAILABLE") }).pipe(
    Effect.flatten,
    Effect.mapError(() => failure("COUNT_UNAVAILABLE")),
    Effect.catchDefect(() => Effect.fail(failure("COUNT_UNAVAILABLE"))),
  )
}
