export * as EventInvestigation from "./event-investigation"

import { Context, Effect, Option, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { LocalOperator } from "../im/local-operator"
import { LocalAuthoritySchema } from "../session/local-authority.schema"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { WorkExecutionTable } from "../session/work-authority.sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventInvestigationAuthoritySchema } from "./event-investigation-authority.schema"
import { EventInvestigationPolicy } from "./event-investigation-policy"
import { EventInvestigationSchema } from "./event-investigation.schema"
import { EventValidationSchema } from "./event-validation.schema"
import { EventValidation } from "./event-validation"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
type Reader = Pick<Db, "get" | "all">
type Rule = EventValidationSchema.RuleRecord
const hash = EventInvestigationPolicy.hash
const failure = (code: EventInvestigationSchema.Error["code"] = "INVESTIGATION_UNAVAILABLE") =>
  new EventInvestigationSchema.Error({ code, message: "Investigation authority or immutable failure evidence is unavailable or changed" })
function checked<A>(schema: Schema.Decoder<A>, input: unknown) {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(input)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure("INVESTIGATION_INVALID"))
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => Effect.fail(error instanceof EventInvestigationSchema.Error ? error : failure())))
}
const native = Effect.gen(function* () {
  const installed = yield* Effect.serviceOption(Native)
  if (Option.isNone(installed)) return yield* failure()
  return installed.value
})
const captures = new WeakMap<GrantCapture, { db: Db; native: Native["Service"]; input: GrantApprovalInput; used: boolean;
  epoch: number; operatorRevision: number; credentialGeneration: number; policyRevision: number; policyHash: string }>()

declare const grantCapture: unique symbol
declare const failureCapture: unique symbol
export interface GrantCapture { readonly [grantCapture]: true }
export interface FailureCapture { readonly [failureCapture]: true }
export type GrantApprovalInput = {
  readonly rule: EventValidationSchema.RuleRecord
  readonly targetID: string
  readonly target: typeof LocalAuthoritySchema.ProjectTarget.Type
  readonly principal: LocalAuthoritySchema.Principal
  readonly expiresAt: number
}
export type FailureObservationInput = {
  readonly rule: EventValidationSchema.RuleRecord
  readonly run: EventValidationSchema.RunRecord
  readonly grant: EventInvestigationAuthoritySchema.Grant
}
export type FailureEvidence = {
  readonly evidence: EventInvestigationSchema.Evidence
  readonly auditedText: string
  readonly auditedTextHash: string
  readonly auditedTextBytes: number
}

/** Installed same-Root native authority only. No default layer or JSON proof constructor. */
export class Native extends Context.Service<Native, {
  readonly approveGrant: (input: GrantApprovalInput) => Effect.Effect<GrantCapture, EventInvestigationSchema.Error>
  readonly approvedGrant: (capture: GrantCapture, input: GrantApprovalInput) => boolean
  readonly observeFailure: (input: FailureObservationInput) => Effect.Effect<FailureCapture, EventInvestigationSchema.Error>
  readonly failure: (capture: FailureCapture) => FailureEvidence | undefined
}>()("@deepagent-code/EventInvestigation/Native") {}

export const expectedFile = EventInvestigationPolicy.expectedFile

/** Approved policy data only. Availability still requires a fresh installed Native capture. */
export const candidates = Effect.fn("EventInvestigation.candidates")(function* (db: Db, ruleID: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, ruleID, actor)
    const available = yield* Effect.forEach(actor.policy.targets, (entry) => requireTarget(actor, rule, entry.id).pipe(
      Effect.map((target) => ({ targetID: entry.id, profile: target.profile,
        provider: { providerID: target.provider.providerID, modelID: target.provider.modelID, routeID: target.provider.routeID },
        read: target.toolPolicy.fileScope.read.map((file) => file.path), budget: target.budget, durationMs: target.durationMs })),
      Effect.orElseSucceed(() => undefined)))
    return yield* checked(EventInvestigationSchema.Candidates, { ruleID: rule.ruleID, ruleRevision: rule.revision,
      operatorRevision: actor.revision, epoch: rule.investigationAuthority?.epoch ?? 0, maxExpiresAt: rule.configuration.expiresAt,
      targets: available.filter((target) => target !== undefined) })
  }), { behavior: "immediate" })
}, preserve)

/** Nonsecret status projection. Historical authority epochs remain visible to the current
 * authenticated owner; no audited text, grant, log, capture or execution is returned. */
export const reports = Effect.fn("EventInvestigation.reports")(function* (db: Db, ruleID: string) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, ruleID, actor)
    const rows = yield* tx.all<{ receipt_id: string }>(sql`SELECT receipt_id FROM event_validation_investigation_receipt
      WHERE rule_id=${rule.ruleID} AND instance_id=${actor.instance_id} ORDER BY created_at DESC,receipt_id DESC LIMIT 32`)
    return yield* checked(EventInvestigationSchema.Reports, yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
      const receipt = yield* get(tx, row.receipt_id)
      if (!receipt || receipt.grant.principal.actorID !== actor.operator_id || receipt.grant.principal.instanceID !== actor.instance_id ||
        receipt.grant.scopeHash !== hash(rule.configuration.scope) || receipt.grant.target.scope.securityNamespaceID !== rule.configuration.scope.securityNamespaceID ||
        receipt.grant.target.scope.projectScopeKey !== rule.configuration.scope.projectScopeKey)
        return yield* failure("INVESTIGATION_AUTH_REQUIRED")
      const work = yield* WorkAuthority.get(tx, receipt.workID)
      if (!work || work.work_id !== receipt.workID || work.session_id !== receipt.sessionID || work.input_id !== receipt.inputID ||
        work.binding_hash !== receipt.bindingHash || work.source_record_hash !== receipt.authorityHash ||
        WorkAuthorityPolicy.fingerprint(work.binding) !== receipt.bindingHash)
        return yield* failure("INVESTIGATION_INVALID")
      return { receiptID: receipt.receiptID, failureKey: receipt.failureKey, runID: receipt.runID,
        contentRevision: receipt.contentRevision, contentHash: receipt.contentHash, sessionID: receipt.sessionID,
        grantEpoch: receipt.grantEpoch, createdAt: receipt.createdAt, deadline: receipt.deadline,
        work: { admissionState: work.admission_state, controlState: work.control_state,
          controlRevision: work.control_revision, outcome: work.outcome } }
    })))
  }), { behavior: "immediate" })
}, preserve)

export const captureGrant = Effect.fn("EventInvestigation.captureGrant")(function* (db: Db,
  input: { ruleID: string; targetID: string; expiresAt: number }) {
  const approval = yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, input.ruleID, actor)
    const target = yield* requireTarget(actor, rule, input.targetID)
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > rule.configuration.expiresAt)
      return yield* failure("INVESTIGATION_EXPIRED")
    return { input: { rule, targetID: input.targetID, target, principal: principal(actor), expiresAt: input.expiresAt },
      epoch: rule.investigationAuthority?.epoch ?? 0, operatorRevision: actor.revision,
      credentialGeneration: actor.credential_generation, policyRevision: actor.policy_revision, policyHash: actor.policy_hash }
  }), { behavior: "immediate" })
  const installed = yield* native
  const capture = yield* installed.approveGrant(approval.input)
  if (!installed.approvedGrant(capture, approval.input)) return yield* failure()
  captures.set(capture, { db, native: installed, ...structuredClone(approval), used: false })
  return capture
}, preserve)

/** Explicit operator CAS, with original exact command retry checked before fresh capture. */
export const enableAuthority = Effect.fn("EventInvestigation.enableAuthority")(function* (db: Db,
  value: EventInvestigationSchema.GrantCommand, capture?: GrantCapture) {
  const input = yield* checked(EventInvestigationSchema.GrantCommand, value)
  const requestHash = hash({ version: "event-investigation-authority-command.v1", ...input })
  const result = yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, input.ruleID, actor)
    const prior = yield* readCommand(tx, actor.instance_id, input.requestID, requestHash)
    if (prior) return { receipt: prior, replayed: true, interruptedSessionIDs: [] as string[] }
    if (rule.state === "revoked") return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    if (actor.revision !== input.expectedOperatorRevision || (rule.investigationAuthority?.epoch ?? 0) !== input.expectedEpoch)
      return yield* failure("INVESTIGATION_CONFLICT")
    const now = Date.now()
    const epoch = input.expectedEpoch + 1
    const authority = input.operation === "disable"
      ? { version: 1 as const, epoch, state: "disabled" as const, grant: null, updatedAt: now }
      : yield* Effect.gen(function* () {
        const entry = capture ? captures.get(capture) : undefined
        const installed = yield* native
        if (!capture || !entry || entry.db !== db || entry.native !== installed || entry.used ||
          entry.epoch !== input.expectedEpoch || entry.epoch !== (rule.investigationAuthority?.epoch ?? 0) ||
          entry.operatorRevision !== actor.revision || entry.credentialGeneration !== actor.credential_generation ||
          entry.policyRevision !== actor.policy_revision || entry.policyHash !== actor.policy_hash ||
          entry.input.rule.ruleID !== rule.ruleID || entry.input.rule.revision !== rule.revision ||
          entry.input.rule.configHash !== rule.configHash || hash(entry.input.principal) !== hash(principal(actor)) ||
          entry.input.targetID !== input.targetID || entry.input.expiresAt !== input.expiresAt ||
          !installed.approvedGrant(capture, entry.input)) return yield* failure()
        const target = yield* requireTarget(actor, rule, entry.input.targetID)
        if (hash(target) !== hash(entry.input.target) || input.expiresAt === null || input.expiresAt <= now)
          return yield* failure("INVESTIGATION_SOURCE_CHANGED")
        const grant = yield* checked(EventInvestigationAuthoritySchema.Grant, { version: 1,
          grantID: `grant_evinv_${hash([rule.instanceID, input.requestID]).slice(0, 40)}`, epoch, ruleID: rule.ruleID,
          principal: principal(actor), credentialGeneration: actor.credential_generation,
          policyRevision: actor.policy_revision, policyHash: actor.policy_hash,
          targetID: entry.input.targetID, target, scopeHash: hash(rule.configuration.scope), createdAt: now, expiresAt: input.expiresAt })
        return { version: 1 as const, epoch, state: "enabled" as const, grant, updatedAt: now }
      })
    const next = { ...rule, investigationAuthority: authority, updatedAt: now }
    if (Buffer.byteLength(CanonicalJson.stringify(next)) > EventValidationSchema.MAX_RULE_BYTES)
      return yield* failure("INVESTIGATION_CAPACITY")
    yield* checked(EventValidationSchema.RuleRecord, next)
    const sessions = yield* invalidateRuleInTransaction(tx, rule.ruleID, input.expectedEpoch)
    yield* writeAuthority(tx, next, rule)
    const receipt = yield* saveCommand(tx, next, input, requestHash)
    return { receipt, replayed: false, interruptedSessionIDs: sessions }
  }), { behavior: "immediate" })
  if (!result.replayed && input.operation === "enable" && capture) {
    const entry = captures.get(capture)
    if (entry) entry.used = true
  }
  return result
}, preserve)

export const get = Effect.fn("EventInvestigation.get")(function* (db: Reader, receiptID: string) {
  const size = yield* db.get<{ bytes: number }>(sql`SELECT record_bytes bytes FROM event_validation_investigation_receipt WHERE receipt_id=${receiptID}`)
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 2 || size.bytes > EventInvestigationSchema.MAX_RECEIPT_BYTES)
    return yield* failure("INVESTIGATION_INVALID")
  const row = yield* db.get<ReturnType<typeof columns>>(sql`SELECT * FROM event_validation_investigation_receipt
    WHERE receipt_id=${receiptID} AND record_bytes<=${EventInvestigationSchema.MAX_RECEIPT_BYTES}`)
  if (!row) return yield* failure("INVESTIGATION_INVALID")
  const receipt = yield* checked(Schema.fromJsonString(EventInvestigationSchema.Receipt), row.record)
  if (!EventInvestigationPolicy.validReceipt(receipt) || hash(columns(receipt)) !== hash(row))
    return yield* failure("INVESTIGATION_INVALID")
  return receipt
}, preserve)

/** Only a live completion callback invokes this. Durable receipt and Work reserve commit
 * together; Session admission and advisory wake remain the existing host Work path. */
export const acceptFailureAndReserve = Effect.fn("EventInvestigation.acceptFailureAndReserve")(function* (db: Db,
  input: { ruleID: string; runID: string }) {
  const snapshot = yield* db.transaction((tx) => failureSnapshot(tx, input), { behavior: "immediate" })
  const key = EventInvestigationPolicy.failureKey(snapshot.run)
  const ids = EventInvestigationPolicy.identities(key)
  const prior = yield* get(db, ids.receiptID)
  if (prior) return yield* db.transaction((tx) => Effect.gen(function* () {
    const binding = EventInvestigationPolicy.bindingFor(prior)
    yield* currentSource(tx, binding)
    const work = yield* WorkAuthority.reserveInTransaction(tx, { binding })
    return { receipt: prior, binding, work, replayed: true }
  }), { behavior: "immediate" })
  const installed = yield* native
  const capture = yield* installed.observeFailure(snapshot)
  const observed = installed.failure(capture)
  if (!observed || !Schema.is(EventInvestigationSchema.Evidence)(observed.evidence) ||
    !EventInvestigationPolicy.currentFailure(snapshot.rule, snapshot.run, observed.evidence) ||
    observed.auditedTextBytes !== Buffer.byteLength(observed.auditedText) || observed.auditedTextHash !== Hash.sha256(observed.auditedText) ||
    observed.auditedTextBytes > EventInvestigationSchema.MAX_AUDITED_TEXT_BYTES)
    return yield* failure("INVESTIGATION_SOURCE_CHANGED")
  const expectedText = CanonicalJson.stringify({ version: "event-investigation-audited.v1", failure: observed.evidence,
    logs: { stdout: snapshot.run.result!.stdout.excerpt, stderr: snapshot.run.result!.stderr.excerpt },
    approvedRead: snapshot.grant.target.toolPolicy.fileScope.read.map((rule) => expectedFile({ evidence: observed.evidence }, rule.path)) })
  if (observed.auditedText !== expectedText || snapshot.grant.target.toolPolicy.fileScope.read.some((rule) => !expectedFile({ evidence: observed.evidence }, rule.path)))
    return yield* failure("INVESTIGATION_SOURCE_CHANGED")
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const current = yield* failureSnapshot(tx, input)
    if (hash(current.grant) !== hash(snapshot.grant) || !EventInvestigationPolicy.currentFailure(current.rule, current.run, observed.evidence))
      return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    const existing = yield* get(tx, ids.receiptID)
    if (existing) {
      const binding = EventInvestigationPolicy.bindingFor(existing)
      yield* currentSource(tx, binding)
      return { receipt: existing, binding, work: yield* WorkAuthority.reserveInTransaction(tx, { binding }), replayed: true }
    }
    const now = Date.now()
    const base = { version: 1 as const, ...ids, rootWorkID: ids.workID,
      instanceID: current.rule.instanceID, ruleID: current.rule.ruleID, projectKey: current.rule.projectKey,
      securityNamespaceID: current.rule.configuration.scope.securityNamespaceID,
      contentRevision: current.run.contentRevision, contentHash: current.run.contentHash, recipeHash: current.run.recipeHash,
      failureKey: key, runID: current.run.runID, grantEpoch: current.grant.epoch,
      sourceRequestID: key, deadline: Math.min(now + current.grant.target.durationMs, current.grant.expiresAt, current.rule.configuration.expiresAt),
      createdAt: now, grant: current.grant, grantHash: hash(current.grant), evidence: observed.evidence,
      evidenceHash: hash(observed.evidence), auditedText: observed.auditedText,
      auditedTextHash: observed.auditedTextHash, auditedTextBytes: observed.auditedTextBytes }
    // attemptKey belongs to the binding, not the strict business receipt.
    const { attemptKey, ...record } = base
    const authorized = { ...record, authorityHash: EventInvestigationPolicy.authorityHash(record) }
    const binding = EventInvestigationPolicy.bindingFor(authorized)
    const receipt = yield* checked(EventInvestigationSchema.Receipt, { ...authorized, bindingHash: WorkAuthorityPolicy.fingerprint(binding) })
    if (!EventInvestigationPolicy.validReceipt(receipt)) return yield* failure("INVESTIGATION_INVALID")
    yield* projectBarrier(tx, receipt)
    const encoded = columns(receipt)
    const totals = yield* tx.get<{ count: number; bytes: number }>(sql`SELECT count(*) count,coalesce(sum(record_bytes),0) bytes
      FROM event_validation_investigation_receipt WHERE instance_id=${receipt.instanceID}`)
    if (!totals || !Number.isSafeInteger(totals.count) || !Number.isSafeInteger(totals.bytes) ||
      totals.count >= EventInvestigationSchema.MAX_RECEIPTS || totals.bytes + encoded.record_bytes > EventInvestigationSchema.MAX_INSTANCE_BYTES)
      return yield* failure("INVESTIGATION_CAPACITY")
    yield* tx.run(sql`INSERT INTO event_validation_investigation_receipt (${sql.join(Object.keys(encoded).map(sql.identifier), sql`,`)})
      VALUES (${sql.join(Object.values(encoded).map((value) => sql`${value}`), sql`,`)})`)
    const work = yield* WorkAuthority.reserveInTransaction(tx, { binding })
    return { receipt, binding, work, replayed: false }
  }), { behavior: "immediate" })
}, preserve)

export const authorizeWorkSource = Effect.fn("EventInvestigation.authorizeWorkSource")(function* (tx: Tx,
  binding: WorkAuthoritySchema.Binding) {
  const receipt = yield* currentSource(tx, binding).pipe(Effect.mapError((error) => new WorkAuthoritySchema.Error({
    code: error instanceof EventInvestigationSchema.Error && error.code === "INVESTIGATION_RECOVERY_REQUIRED" ? "WORK_RECOVERY_REQUIRED" :
      error instanceof EventInvestigationSchema.Error && error.code === "INVESTIGATION_EXPIRED" ? "WORK_EXPIRED" : "WORK_REVOKED",
    message: "The current investigation source is unavailable or changed" })))
  return { authorityID: receipt.receiptID, revision: receipt.grantEpoch, recordHash: receipt.authorityHash }
})

/** One transaction binds a tool read to the same current source and Work control. */
export const readManifest = Effect.fn("EventInvestigation.readManifest")(function* (tx: Tx,
  binding: WorkAuthoritySchema.Binding, controlRevision: number) {
  const receipt = yield* currentSource(tx, binding)
  const work = yield* WorkAuthority.requireRunnable(tx, { sessionID: receipt.sessionID }).pipe(Effect.mapError(() => failure("INVESTIGATION_SOURCE_CHANGED")))
  if (!work || work.binding_hash !== receipt.bindingHash || work.control_revision !== controlRevision)
    return yield* failure("INVESTIGATION_SOURCE_CHANGED")
  return receipt
}, preserve)

/** Reading candidates never admits a historical failure or starts a provider. */
export type ReconcileCandidate = { readonly kind: "receipt"; readonly receipt: EventInvestigationSchema.Receipt } |
  { readonly kind: "failure"; readonly ruleID: string; readonly runID: string }
export const readReconcileCandidates = Effect.fn("EventInvestigation.readReconcileCandidates")(function* (db: Db) {
  const actor = yield* db.transaction((tx) => LocalOperator.requireCurrent(tx))
  const rows = yield* db.all<{ receipt_id: string }>(sql`SELECT r.receipt_id FROM event_validation_investigation_receipt r
    JOIN work_execution w ON w.work_id=r.work_id JOIN event_validation_rule v ON v.rule_id=r.rule_id AND v.instance_id=r.instance_id
    LEFT JOIN session s ON s.id=w.session_id
    LEFT JOIN session_input i ON i.id=w.input_id WHERE r.instance_id=${actor.instance_id} AND r.deadline>${Date.now()}
      AND w.admission_state IN ('reserved','ready') AND w.control_state='active' AND w.outcome='pending'
      AND v.state='enabled' AND v.current_run_id=r.run_id AND v.investigation_epoch=r.grant_epoch
      AND json_extract(v.record,'$.investigationAuthority.state')='enabled'
      AND json_extract(v.record,'$.investigationAuthority.grant') IS json_extract(r.record,'$.grant')
      AND json_extract(v.record,'$.investigationAuthority.grant.principal.identityHash')=${actor.identity_hash}
      AND json_extract(v.record,'$.investigationAuthority.grant.policyHash')=${actor.policy_hash}
      AND (s.id IS NULL OR (s.execution_claim_token IS NULL AND s.directory=json_extract(w.binding,'$.location.directory')
        AND s.agent=json_extract(w.binding,'$.agentID') AND json_extract(s.model,'$.id')=json_extract(w.binding,'$.provider.modelID')
        AND json_extract(s.model,'$.providerID')=json_extract(w.binding,'$.provider.providerID')))
      AND (i.id IS NULL OR (i.session_id=w.session_id AND i.delivery='queue' AND i.promoted_seq IS NULL))
      AND (w.admission_state<>'ready' OR (s.id IS NOT NULL AND i.id IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM session_provider_attempt WHERE session_id=w.session_id)
      AND NOT EXISTS(SELECT 1 FROM session_activity WHERE session_id=w.session_id)
      AND NOT EXISTS(SELECT 1 FROM work_count_acquisition WHERE work_id=w.work_id)
      AND NOT EXISTS(SELECT 1 FROM work_dispatch_reservation WHERE root_work_id=w.root_work_id)
    ORDER BY r.created_at,r.receipt_id LIMIT 32`)
  const receipts = (yield* Effect.forEach(rows, (row) => get(db, row.receipt_id)))
    .filter((receipt): receipt is EventInvestigationSchema.Receipt => receipt !== undefined)
    .map((receipt): ReconcileCandidate => ({ kind: "receipt", receipt }))
  if (receipts.length === 32) return receipts
  const failures = yield* db.all<{ rule_id: string; run_id: string }>(sql`SELECT v.rule_id,r.run_id FROM event_validation_rule v
    JOIN event_validation_run r ON r.run_id=v.current_run_id
    WHERE v.instance_id=${actor.instance_id} AND v.operator_id=${actor.operator_id} AND v.state='enabled'
      AND json_extract(v.record,'$.configuration.expiresAt')>${Date.now()}
      AND json_extract(v.record,'$.investigationAuthority.state')='enabled'
      AND json_extract(v.record,'$.investigationAuthority.grant.expiresAt')>${Date.now()}
      AND json_extract(v.record,'$.investigationAuthority.grant.principal.identityHash')=${actor.identity_hash}
      AND json_extract(v.record,'$.investigationAuthority.grant.policyHash')=${actor.policy_hash}
      AND r.state='settled' AND r.outcome='failed' AND r.cancel_requested=0 AND r.released_at IS NOT NULL AND r.retained_bytes=0
      AND r.rule_revision=v.revision AND r.content_revision=v.content_revision AND r.content_hash=v.content_hash
      AND json_extract(r.record,'$.resultCurrent')=1 AND json_extract(r.record,'$.result.stopConfirmed')=1
      AND json_extract(r.record,'$.result.stdout.complete')=1 AND json_extract(r.record,'$.result.stderr.complete')=1
      AND NOT EXISTS(SELECT 1 FROM event_validation_investigation_receipt i WHERE i.instance_id=v.instance_id AND i.rule_id=v.rule_id
        AND i.content_revision=r.content_revision AND i.content_hash=r.content_hash AND i.recipe_hash=r.recipe_hash)
    ORDER BY r.terminal_at,r.run_id LIMIT ${32 - receipts.length}`)
  return [...receipts, ...failures.map((row): ReconcileCandidate => ({ kind: "failure", ruleID: row.rule_id, runID: row.run_id }))]
}, preserve)

/** Revocation is already durable. This bounded authenticated read only supplies exact
 * old Session identities to the existing process-global interruption service. */
export const readRevokedSessionPage = Effect.fn("EventInvestigation.readRevokedSessionPage")(function* (db: Db,
  input: { ruleID: string; afterReceiptID?: string }) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, input.ruleID, actor)
    const rows = yield* tx.all<{ receipt_id: string }>(sql`SELECT r.receipt_id FROM event_validation_investigation_receipt r
      JOIN work_execution w ON w.work_id=r.work_id AND w.session_id=r.session_id AND w.input_id=r.input_id AND w.binding_hash=r.binding_hash
      WHERE r.rule_id=${rule.ruleID} AND r.instance_id=${actor.instance_id} AND w.control_state='revoked'
        AND (${input.afterReceiptID ?? null} IS NULL OR r.receipt_id>${input.afterReceiptID ?? null})
      ORDER BY r.receipt_id LIMIT 32`)
    const receipts = yield* Effect.forEach(rows, (row) => get(tx, row.receipt_id))
    if (receipts.some((receipt) => !receipt)) return yield* failure("INVESTIGATION_INVALID")
    return { sessionIDs: receipts.flatMap((receipt) => receipt ? [receipt.sessionID] : []),
      nextReceiptID: rows.length === 32 ? rows[31]!.receipt_id : null }
  }), { behavior: "immediate" })
}, preserve)

export const requireColdWake = Effect.fn("EventInvestigation.requireColdWake")(function* (tx: Tx,
  binding: WorkAuthoritySchema.Binding) {
  const receipt = yield* currentSource(tx, binding)
  const work = yield* WorkAuthority.get(tx, receipt.workID)
  if (!work || work.binding_hash !== receipt.bindingHash || work.control_state !== "active" || work.outcome !== "pending" ||
    !["reserved", "ready"].includes(work.admission_state)) return yield* failure("INVESTIGATION_SOURCE_CHANGED")
  const session = yield* tx.get<{ id: string; directory: string; agent: string; model: string; execution_claim_token: number | null }>(sql`
    SELECT id,directory,agent,model,execution_claim_token FROM session WHERE id=${receipt.sessionID}`)
  const input = yield* tx.get<{ id: string; session_id: string; delivery: string; promoted_seq: number | null; prompt: string }>(sql`
    SELECT id,session_id,delivery,promoted_seq,prompt FROM session_input WHERE id=${receipt.inputID}`)
  const model = session ? Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: Schema.String, providerID: Schema.String })),
    { onExcessProperty: "error" })(session.model) : Option.none()
  if (session && (session.execution_claim_token !== null || session.directory !== work.binding.location.directory ||
    session.agent !== work.binding.agentID || Option.isNone(model) || model.value.id !== work.binding.provider.modelID ||
    model.value.providerID !== work.binding.provider.providerID)) return yield* failure("INVESTIGATION_RECOVERY_REQUIRED")
  if (work.admission_state === "ready" && (!session || !input)) return yield* failure("INVESTIGATION_SOURCE_CHANGED")
  if (input) {
    const prompt = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ text: Schema.String })), { onExcessProperty: "error" })(input.prompt)
    if (input.session_id !== receipt.sessionID || input.delivery !== "queue" || input.promoted_seq !== null || Option.isNone(prompt) ||
      !WorkAuthorityPolicy.checkAuditedText(work.binding, prompt.value.text).ok) return yield* failure("INVESTIGATION_RECOVERY_REQUIRED")
  }
  const touched = yield* tx.get<{ count: number }>(sql`SELECT (
    (SELECT count(*) FROM session_provider_attempt WHERE session_id=${receipt.sessionID})+
    (SELECT count(*) FROM session_activity WHERE session_id=${receipt.sessionID})+
    (SELECT count(*) FROM work_count_acquisition WHERE work_id=${receipt.workID})+
    (SELECT count(*) FROM work_dispatch_reservation WHERE root_work_id=${receipt.rootWorkID})+
    (SELECT count(*) FROM session_input WHERE id=${receipt.inputID} AND promoted_seq IS NOT NULL)) count`)
  if (!touched || touched.count !== 0) return yield* failure("INVESTIGATION_RECOVERY_REQUIRED")
  return { receipt, binding: EventInvestigationPolicy.bindingFor(receipt), work }
}, preserve)

export const sourceChanged = Effect.fn("EventInvestigation.sourceChanged")(function* (db: Db,
  binding: WorkAuthoritySchema.Binding, expectedEpoch: number) {
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const receipt = yield* get(tx, binding.source.authorityID)
    if (!receipt || receipt.grantEpoch !== expectedEpoch || receipt.bindingHash !== WorkAuthorityPolicy.fingerprint(binding))
      return [] as string[]
    return yield* invalidateWork(tx, receipt.workID)
  }), { behavior: "immediate" })
}, preserve)

/** Same-transaction control fence for Rule changes; never touches a newer epoch's Work. */
export const invalidateRuleInTransaction = Effect.fn("EventInvestigation.invalidateRuleInTransaction")(function* (
  tx: Tx, ruleID: string, throughEpoch: number,
) {
  const rows = yield* tx.all<{ work_id: string }>(sql`SELECT work_id FROM event_validation_investigation_receipt
    WHERE rule_id=${ruleID} AND grant_epoch<=${throughEpoch} ORDER BY created_at,receipt_id LIMIT 10001`)
  if (rows.length > EventInvestigationSchema.MAX_RECEIPTS) return yield* failure("INVESTIGATION_CAPACITY")
  return (yield* Effect.forEach(rows, (row) => invalidateWork(tx, row.work_id))).flat()
}, preserve)

function principal(actor: LocalOperator.Record): LocalAuthoritySchema.Principal {
  return { instanceID: actor.instance_id, actorID: actor.operator_id, revision: actor.revision, identityHash: actor.identity_hash }
}
function requireRule(tx: Tx, ruleID: string, actor: LocalOperator.Record) {
  return Effect.gen(function* () {
    const rule = yield* EventValidation.getRule(tx, ruleID).pipe(Effect.mapError(() => failure("INVESTIGATION_INVALID")))
    if (!rule || rule.instanceID !== actor.instance_id || rule.operatorID !== actor.operator_id)
      return yield* failure("INVESTIGATION_AUTH_REQUIRED")
    yield* EventValidation.requireScope(tx, rule.configuration.scope, actor.instance_id).pipe(Effect.mapError(() => failure("INVESTIGATION_SOURCE_CHANGED")))
    return rule
  })
}
function requireTarget(actor: LocalOperator.Record, rule: Rule, targetID: string):
  Effect.Effect<typeof LocalAuthoritySchema.ProjectTarget.Type, EventInvestigationSchema.Error> {
  const entry = actor.policy.targets.find((target) => target.id === targetID)
  if (!entry || !("version" in entry.target) || entry.target.profile.id !== WorkAuthorityPolicy.EVENT_INVESTIGATE_PROFILE.id ||
    !WorkAuthorityPolicy.profileFor(entry.target.profile) || !WorkAuthorityPolicy.checkInvestigationPolicy(entry.target).ok ||
    entry.target.scope.actorID !== actor.operator_id || entry.target.scope.securityNamespaceID !== rule.configuration.scope.securityNamespaceID ||
    entry.target.scope.projectScopeKey !== rule.configuration.scope.projectScopeKey || entry.target.location.workspaceID !== undefined ||
    entry.target.location.directory !== rule.configuration.scope.canonicalRoot || entry.locationKey !== rule.configuration.scope.locationKey ||
    entry.namespaceBindingHash !== rule.configuration.scope.namespaceBindingHash ||
    entry.target.projectScope.projectID !== rule.configuration.scope.projectID ||
    entry.target.projectScope.helperHash !== rule.configuration.helperHash ||
    hash(entry.target.projectScope.rootIdentity) !== hash(rule.configuration.scope.rootIdentity) ||
    entry.target.toolPolicy.fileScope.read.some((path) => !rule.configuration.watch.includes(path.path)))
    return Effect.fail(failure("INVESTIGATION_SOURCE_CHANGED"))
  return Effect.succeed(entry.target)
}
function failureSnapshot(tx: Tx, input: { ruleID: string; runID: string }) {
  return Effect.gen(function* () {
    const actor = yield* LocalOperator.requireCurrent(tx).pipe(Effect.mapError(() => failure("INVESTIGATION_AUTH_REQUIRED")))
    const rule = yield* requireRule(tx, input.ruleID, actor)
    const authority = rule.investigationAuthority
    if (!authority || authority.state !== "enabled" || rule.state !== "enabled" || rule.configuration.expiresAt <= Date.now())
      return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    const grant = authority.grant
    const target = yield* requireTarget(actor, rule, grant.targetID)
    if (hash(principal(actor)) !== hash(grant.principal) || actor.credential_generation !== grant.credentialGeneration ||
      actor.policy_revision !== grant.policyRevision || actor.policy_hash !== grant.policyHash || hash(target) !== hash(grant.target) ||
      grant.scopeHash !== hash(rule.configuration.scope) || grant.expiresAt <= Date.now())
      return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    const run = yield* EventValidation.getRun(tx, input.runID).pipe(Effect.mapError(() => failure("INVESTIGATION_INVALID")))
    if (!run || run.ruleID !== rule.ruleID || run.instanceID !== rule.instanceID || run.projectKey !== rule.projectKey ||
      run.state !== "settled" || run.outcome !== "failed" || !run.resultCurrent || run.cancelRequested || !run.result ||
      run.releasedAt === null || run.retainedBytes !== 0 ||
      !run.result.stopConfirmed || !run.result.stdout.complete || !run.result.stderr.complete || !run.snapshotHash || !run.processIncarnation ||
      run.terminalAt === null || run.result.endedAt > run.terminalAt || rule.currentRunID !== run.runID ||
      rule.revision !== run.ruleRevision || rule.contentRevision !== run.contentRevision || rule.contentHash !== run.contentHash ||
      rule.configHash !== run.configHash || hash(rule.configuration.recipe) !== run.recipeHash)
      return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    return { rule, run, grant }
  })
}
function currentSource(tx: Tx, binding: WorkAuthoritySchema.Binding) {
  return Effect.gen(function* () {
    const valid = WorkAuthorityPolicy.validateBinding(binding)
    if (!valid.ok || binding.schemaVersion !== "work-execution.v2" || binding.profile.id !== "event_investigate_v1" || binding.source.kind !== "server_rule")
      return yield* failure("INVESTIGATION_INVALID")
    const receipt = yield* get(tx, binding.source.authorityID)
    if (!receipt || receipt.bindingHash !== WorkAuthorityPolicy.fingerprint(binding) || receipt.authorityHash !== binding.source.requestHash)
      return yield* failure("INVESTIGATION_INVALID")
    const snapshot = yield* failureSnapshot(tx, { ruleID: receipt.ruleID, runID: receipt.runID })
    if (receipt.deadline <= Date.now()) return yield* failure("INVESTIGATION_EXPIRED")
    if (snapshot.grant.epoch !== receipt.grantEpoch || hash(snapshot.grant) !== receipt.grantHash ||
      !EventInvestigationPolicy.currentFailure(snapshot.rule, snapshot.run, receipt.evidence))
      return yield* failure("INVESTIGATION_SOURCE_CHANGED")
    yield* projectBarrier(tx, receipt)
    return receipt
  })
}
function projectBarrier(tx: Tx, receipt: EventInvestigationSchema.Receipt) {
  return Effect.gen(function* () {
    const blocked = yield* tx.get<{ found: number }>(sql`SELECT 1 found FROM work_execution w
      WHERE w.security_namespace_id=${receipt.securityNamespaceID} AND json_extract(w.binding,'$.scope.projectScopeKey')=${receipt.grant.target.scope.projectScopeKey}
        AND w.work_id<>${receipt.workID} AND (w.outcome='unknown' OR EXISTS(SELECT 1 FROM work_dispatch_reservation d
          WHERE d.root_work_id=w.root_work_id AND d.state IN ('dispatching','unknown')) OR EXISTS(SELECT 1 FROM work_count_acquisition c
          WHERE c.work_id=w.work_id AND c.state IN ('sending','unknown','failed'))) LIMIT 1`)
    const validation = yield* tx.get<{ found: number }>(sql`SELECT 1 found FROM event_validation_project p JOIN event_validation_run r
      ON r.run_id=p.active_run_id WHERE p.project_key=${receipt.projectKey} AND r.state='unknown' LIMIT 1`)
    if (blocked || validation) return yield* failure("INVESTIGATION_RECOVERY_REQUIRED")
  })
}
function invalidateWork(tx: Tx, workID: string) {
  return Effect.gen(function* () {
    const work = yield* WorkAuthority.get(tx, workID)
    if (!work || ["revoked", "cancelled", "expired"].includes(work.control_state)) return [] as string[]
    const updated = yield* tx.update(WorkExecutionTable).set({ control_state: "revoked", control_revision: work.control_revision + 1,
      updated_at: Date.now() }).where(and(eq(WorkExecutionTable.work_id, workID), eq(WorkExecutionTable.control_revision, work.control_revision)))
      .returning({ sessionID: WorkExecutionTable.session_id }).get()
    if (!updated) return yield* failure("INVESTIGATION_CONFLICT")
    return [updated.sessionID]
  })
}
function writeAuthority(tx: Tx, next: Rule, previous: Rule) {
  return Effect.gen(function* () {
    const changed = yield* tx.all(sql`UPDATE event_validation_rule SET investigation_epoch=${next.investigationAuthority!.epoch},
      record=${CanonicalJson.stringify(next)},record_hash=${hash(next)},updated_at=${next.updatedAt}
      WHERE rule_id=${previous.ruleID} AND investigation_epoch=${previous.investigationAuthority?.epoch ?? 0} AND record_hash=${hash(previous)} RETURNING rule_id`)
    if (changed.length !== 1) return yield* failure("INVESTIGATION_CONFLICT")
  })
}
function readCommand(tx: Tx, instanceID: string, requestID: string, requestHash: string) {
  return Effect.gen(function* () {
    const row = yield* tx.get<{ request_hash: string; receipt: string }>(sql`SELECT request_hash,receipt FROM event_validation_command
      WHERE instance_id=${instanceID} AND request_id=${requestID} AND length(CAST(receipt AS BLOB))<=${EventValidationSchema.MAX_COMMAND_BYTES}`)
    if (!row) return undefined
    if (row.request_hash !== requestHash) return yield* failure("INVESTIGATION_CONFLICT")
    const receipt = yield* checked(Schema.fromJsonString(EventValidationSchema.CommandReceipt), row.receipt)
    if (!receipt.investigation || receipt.action !== "update") return yield* failure("INVESTIGATION_CONFLICT")
    return receipt
  })
}
function saveCommand(tx: Tx, rule: Rule, input: EventInvestigationSchema.GrantCommand, requestHash: string) {
  return Effect.gen(function* () {
    const total = yield* tx.get<{ count: number }>(sql`SELECT count(*) count FROM event_validation_command WHERE instance_id=${rule.instanceID}`)
    if (!total || total.count >= EventValidationSchema.MAX_COMMANDS - (input.operation === "enable" ? 768 : 0))
      return yield* failure("INVESTIGATION_CAPACITY")
    const receipt = yield* checked(EventValidationSchema.CommandReceipt, { version: 1, instanceID: rule.instanceID,
      requestID: input.requestID, ruleID: rule.ruleID, action: "update", ruleRevision: rule.revision, runID: null, createdAt: Date.now(),
      investigation: { version: 1, operation: input.operation, epoch: rule.investigationAuthority!.epoch } })
    yield* tx.run(sql`INSERT INTO event_validation_command(instance_id,request_id,rule_id,action,request_hash,receipt,created_at)
      VALUES(${receipt.instanceID},${receipt.requestID},${receipt.ruleID},'update',${requestHash},${CanonicalJson.stringify(receipt)},${receipt.createdAt})`)
    return receipt
  })
}
function columns(receipt: EventInvestigationSchema.Receipt) {
  const record = CanonicalJson.stringify(receipt)
  return { receipt_id: receipt.receiptID, instance_id: receipt.instanceID, rule_id: receipt.ruleID, project_key: receipt.projectKey,
    security_namespace_id: receipt.securityNamespaceID, content_revision: receipt.contentRevision, content_hash: receipt.contentHash,
    recipe_hash: receipt.recipeHash, failure_key: receipt.failureKey, run_id: receipt.runID, grant_epoch: receipt.grantEpoch,
    authority_hash: receipt.authorityHash, work_id: receipt.workID, root_work_id: receipt.rootWorkID, session_id: receipt.sessionID,
    input_id: receipt.inputID, source_request_id: receipt.sourceRequestID, binding_hash: receipt.bindingHash,
    deadline: receipt.deadline, created_at: receipt.createdAt, record, record_hash: hash(receipt), record_bytes: Buffer.byteLength(record) }
}
