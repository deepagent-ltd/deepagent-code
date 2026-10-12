export * as EventWorkAdmission from "./event-work-admission"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { WorkExecutionTable } from "../session/work-authority.sql"
import { Hash } from "../util/hash"
import { decodeEventWorkEnvelope, eventWorkEnvelopeDigest } from "../contract/event-envelope"
import { EventWorkRule } from "./event-work-rule"
import { EventWorkRuleSchema } from "./event-work-rule.schema"
import { EventWorkReceiptTable } from "./event-work-rule.sql"
import { EventWorkSource } from "./event-work-source"

type Tx = WorkAuthority.Transaction
const hash = (value: unknown) => EventWorkSource.hash(value)
const failure = (code?: EventWorkRuleSchema.Error["code"]) => EventWorkSource.failure(code)
export const get = Effect.fn("EventWorkAdmission.get")(function* (tx: Tx, receiptID: string) {
  const row = yield* tx.select().from(EventWorkReceiptTable).where(eq(EventWorkReceiptTable.receipt_id, receiptID)).get()
  if (!row) return undefined
  const receipt = yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkRuleSchema.Receipt), row.record)
  const ids = EventWorkSource.identities(receipt.ruleID, receipt.source)
  if (hash(receipt) !== row.record_hash || Buffer.byteLength(row.record, "utf8") !== row.record_bytes ||
    row.instance_id !== receipt.instanceID || row.rule_id !== receipt.ruleID || row.occurrence_key !== receipt.occurrenceKey ||
    row.event_id !== receipt.eventID || row.work_id !== receipt.workID || row.session_id !== receipt.sessionID || row.input_id !== receipt.inputID ||
    Object.entries(ids).some(([key, value]) => receipt[key as keyof EventWorkRuleSchema.Receipt] !== value) ||
    receipt.sourceHash !== hash(receipt.source) || receipt.auditedTextHash !== Hash.sha256(receipt.auditedText) ||
    receipt.authorityHash !== hash(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "authorityHash"))))
    return yield* failure("EVENT_WORK_INVALID")
  return { receipt, phase: row.phase, bindingHash: row.binding_hash }
})
export function bindingFor(receipt: EventWorkRuleSchema.Receipt, rule: EventWorkRuleSchema.Rule): WorkAuthoritySchema.ProjectBinding {
  const target = rule.target
  return { schemaVersion: "work-execution.v2", workID: receipt.workID, rootWorkID: receipt.workID,
    attemptKey: `attempt_ev_${receipt.occurrenceKey.slice(0, 40)}`,
    source: { kind: "server_rule", authorityID: receipt.receiptID, authorityRevision: receipt.epoch,
      sourceID: receipt.source.activityID, requestID: receipt.occurrenceKey, requestHash: receipt.authorityHash },
    envelopeHash: eventWorkEnvelopeDigest(envelopeFor(receipt, rule)),
    scope: target.scope, location: target.location, agentID: target.agentID, sessionID: receipt.sessionID, inputID: receipt.inputID,
    profile: target.profile, auditedText: { hash: receipt.auditedTextHash, utf8Bytes: Buffer.byteLength(receipt.auditedText, "utf8"),
      snapshotRef: `event-work:${receipt.receiptID}` }, projectScope: target.projectScope,
    contextPolicy: target.contextPolicy, toolPolicy: target.toolPolicy, childPolicy: target.childPolicy,
    provider: target.provider, budget: target.budget, deadline: receipt.deadline }
}
/** The bounded C5 intent is derived only from the original approved rule/receipt. It carries
 * references, not result bodies; spending still needs the original Work budget/count gates. */
export function envelopeFor(receipt: EventWorkRuleSchema.Receipt, rule: EventWorkRuleSchema.Rule) {
  return decodeEventWorkEnvelope({ schemaVersion: "event-work.v1", eventRef: `event://${receipt.eventID}`,
    eventType: EventWorkRule.EVENT_TYPE, objective: rule.instruction,
    payload: { contentType: "application/json", ref: `event-work:${receipt.receiptID}`, payloadHash: receipt.sourceHash },
    verifiedFacts: [], requestedCapability: "deepagent.project.read",
    actorAndScope: { actorId: rule.target.scope.actorID, workspaceId: rule.target.scope.workspaceID,
      securityNamespaceId: rule.target.scope.securityNamespaceID, projectScopeKey: rule.target.scope.projectScopeKey },
    trust: { level: "verified", sourceRef: `event-work:${receipt.receiptID}` },
    permission: { scopes: ["read"], required: ["deepagent.project.read"], maxAutonomy: "low" },
    egress: { allowedDomains: [new URL(rule.target.provider.endpoint).hostname], allowedSensitivities: ["project"] },
    risk: "low", autonomyCeiling: "low", contextQuery: { intent: "recall", query: rule.instruction },
    budget: { maxTokens: rule.target.budget.maxTotalTokens, maxToolCalls: rule.target.budget.maxToolCalls,
      maxDurationMs: rule.target.durationMs, hourTokensMax: rule.target.budget.hourTokensMax,
      hourWindowMinutes: rule.target.budget.hourWindowMinutes, eventRoot: receipt.workID }, correlationId: receipt.occurrenceKey,
    delivery: { consumerGroupId: "event-work-single", leaseToken: "", leaseExpiresAt: 0, attemptCount: 0,
      dedupeId: receipt.occurrenceKey, exactlyOnceCursor: receipt.eventID, maxAttempts: 1 } })
}
export const requireSource = Effect.fn("EventWorkAdmission.requireSource")(function* (tx: Tx, receiptID: string) {
  const value = yield* get(tx, receiptID)
  if (!value || value.receipt.deadline <= Date.now()) return yield* failure("EVENT_WORK_EXPIRED")
  const rule = yield* EventWorkRule.requireCurrent(tx, value.receipt.ruleID)
  const source = yield* EventWorkSource.read(tx, rule, value.receipt.source.activityID)
  if (value.receipt.epoch !== rule.epoch || value.receipt.ruleHash !== hash(rule) || value.receipt.sourceHash !== hash(source))
    return yield* failure()
  const binding = bindingFor(value.receipt, rule)
  const valid = WorkAuthorityPolicy.validateBinding(binding)
  if (!valid.ok) return yield* valid.error
  const bindingHash = WorkAuthorityPolicy.fingerprint(binding)
  if (value.bindingHash !== null && value.bindingHash !== bindingHash) return yield* failure("EVENT_WORK_CONFLICT")
  return { ...value, rule, binding, bindingHash }
})
/** Exact independent server_rule domain. Missing/dual/invalid origin never falls back to EV or IM. */
export const authorizeSource = Effect.fn("EventWorkAdmission.authorizeSource")(function* (tx: Tx, binding: WorkAuthoritySchema.Binding) {
  const value = yield* requireSource(tx, binding.source.authorityID)
  if (binding.schemaVersion !== "work-execution.v2" || binding.source.kind !== "server_rule" || binding.parentWorkID !== undefined ||
    hash(binding) !== value.bindingHash) return yield* failure("EVENT_WORK_CONFLICT")
  const dual = yield* tx.get<{ found: number }>(sql`SELECT 1 found FROM event_validation_investigation_receipt
    WHERE receipt_id=${binding.source.authorityID} OR work_id=${binding.workID} LIMIT 1`)
  if (dual) return yield* failure("EVENT_WORK_CONFLICT")
  return { authorityID: value.receipt.receiptID, revision: value.receipt.epoch, recordHash: value.receipt.authorityHash }
})
export const reserveInTransaction = Effect.fn("EventWorkAdmission.reserveInTransaction")(function* (tx: Tx, receiptID: string) {
  const value = yield* requireSource(tx, receiptID)
  const work = yield* WorkAuthority.reserveInTransaction(tx, { binding: value.binding })
  if (work.work_id !== value.receipt.workID || work.binding_hash !== value.bindingHash) return yield* failure("EVENT_WORK_CONFLICT")
  if (value.phase === "observed") yield* tx.update(EventWorkReceiptTable).set({ phase: "reserved", binding_hash: value.bindingHash })
    .where(and(eq(EventWorkReceiptTable.receipt_id, receiptID), eq(EventWorkReceiptTable.phase, "observed"))).run()
  yield* EventWorkRule.requireCapacity(tx, true)
  // SQL triggers/concurrent current-state mutation cannot turn the reservation into a
  // successful partial commit after the first authority read.
  yield* requireSource(tx, receiptID)
  return { ...value, work }
})
/** Called from original queue/input-ready commit. It does not mint source or execution authority. */
export const bindReadyInTransaction = Effect.fn("EventWorkAdmission.bindReadyInTransaction")(function* (tx: Tx, work: WorkAuthority.Work) {
  const value = yield* requireSource(tx, work.authority_id)
  const current = yield* tx.select().from(WorkExecutionTable).where(eq(WorkExecutionTable.work_id, work.work_id)).get()
  if (!current || current.admission_state !== "ready" || current.input_id !== value.receipt.inputID ||
    current.session_id !== value.receipt.sessionID || current.binding_hash !== value.bindingHash || value.bindingHash !== work.binding_hash)
    return yield* failure("EVENT_WORK_CONFLICT")
  yield* tx.update(EventWorkReceiptTable).set({ phase: "ready" })
    .where(and(eq(EventWorkReceiptTable.receipt_id, value.receipt.receiptID), eq(EventWorkReceiptTable.binding_hash, work.binding_hash))).run()
  yield* EventWorkRule.requireCapacity(tx, true)
  yield* requireSource(tx, value.receipt.receiptID)
})
