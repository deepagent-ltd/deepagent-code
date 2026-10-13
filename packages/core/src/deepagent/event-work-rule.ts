export * as EventWorkRule from "./event-work-rule"

import { and, eq, getTableColumns, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { LocalOperator } from "../im/local-operator"
import { LocalAuthoritySchema } from "../session/local-authority.schema"
import { WorkAuthority } from "../session/work-authority"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { EventWorkRuleSchema } from "./event-work-rule.schema"
import { EventWorkCommandTable, EventWorkNodeAuthorityTable, EventWorkReceiptTable, EventWorkRuleTable } from "./event-work-rule.sql"
import { EventWorkSource } from "./event-work-source"
import { EventWorkControllerTable } from "./event-work-controller.sql"
import { EventWorkPlacement } from "./event-work-placement"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
const hash = (value: unknown) => EventWorkSource.hash(value)
const failure = (code?: EventWorkRuleSchema.Error["code"]) => EventWorkSource.failure(code)
export const EVENT_TYPE = "session.activity.terminal.work.v1"
const tables = [EventWorkRuleTable, EventWorkCommandTable, EventWorkReceiptTable, EventWorkNodeAuthorityTable, EventWorkControllerTable]
const names = ["event_work_rule", "event_work_command", "event_work_receipt", "event_work_node_authority", "event_work_controller"]
// Actual persisted UTF8 columns and 8B nonnull integers, including duplicated identities/JSON.
// Runtime prechecks and physical triggers use the same closed column inventory, not body length alone.
export const meterQuery = sql.join(tables.map((table, index) => sql`SELECT count(*) records,coalesce(sum(${sql.join(
  Object.values(getTableColumns(table)).map((column) => column.dataType === "number"
    ? sql`CASE WHEN ${column} IS NULL THEN 0 ELSE 8 END`
    : sql`coalesce(length(CAST(${column} AS BLOB)),0)`), sql` + `)}),0) bytes FROM ${sql.raw(names[index])}`), sql` UNION ALL `)
export const requireCapacity = Effect.fn("EventWorkRule.requireCapacity")(function* (tx: Tx, control = false) {
  const value = yield* tx.get<{ records: number; bytes: number }>(sql`SELECT sum(records) records,sum(bytes) bytes FROM (${meterQuery})`)
  if (!value || value.records > EventWorkRuleSchema.MAX_RECORDS - (control ? 0 : EventWorkRuleSchema.CONTROL_RECORDS) ||
    value.bytes > EventWorkRuleSchema.MAX_BYTES - (control ? 0 : EventWorkRuleSchema.CONTROL_BYTES))
    return yield* failure("EVENT_WORK_QUOTA")
  return value
})
export const get = Effect.fn("EventWorkRule.get")(function* (tx: Tx, ruleID: string) {
  const row = yield* tx.select().from(EventWorkRuleTable).where(eq(EventWorkRuleTable.rule_id, ruleID)).get()
  if (!row) return undefined
  const record = yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkRuleSchema.Rule), row.record)
  if (row.record_hash !== hash(record) || row.record_bytes !== Buffer.byteLength(row.record, "utf8") ||
    row.instance_id !== record.instanceID || row.operator_id !== record.operatorID || row.epoch !== record.epoch ||
    row.revision !== record.revision || row.state !== record.state || row.source_session_id !== record.origin.sourceSessionID)
    return yield* failure("EVENT_WORK_INVALID")
  return record
})
export const requireCurrent = Effect.fn("EventWorkRule.requireCurrent")(function* (tx: Tx, ruleID: string) {
  const actor = yield* LocalOperator.requireCurrent(tx)
  const rule = yield* get(tx, ruleID)
  if (!rule || rule.instanceID !== actor.instance_id || rule.operatorID !== actor.operator_id ||
    (actor.policy.version !== 3 && actor.policy.version !== 4) || rule.state !== "enabled" || rule.expiresAt <= Date.now() ||
    rule.operatorRevision !== actor.revision || rule.credentialGeneration !== actor.credential_generation ||
    rule.policyRevision !== actor.policy_revision || rule.policyHash !== actor.policy_hash)
    return yield* failure()
  const origin = actor.policy.eventOrigins.find((entry) => entry.id === rule.origin.id)
  const target = actor.policy.targets.find((entry) => entry.id === rule.origin.targetID)?.target
  if (!origin || !target || hash(origin) !== hash(rule.origin) || hash(target) !== hash(rule.target)) return yield* failure()
  yield* LocalOperator.validatePolicy(tx, actor.policy, actor.operator_id)
  return rule
})

/** Rule creation/enable are explicit operator mutations. Pause/revoke invalidate the original
 * epoch before the Host interrupts exact affected Sessions; an interrupt intent is not a terminal. */
export const command = Effect.fn("EventWorkRule.command")(function* (db: Db, input: {
  ruleID: string; requestID: string; expectedRevision: number; action: "create" | "enable" | "pause" | "revoke";
  originID?: string; instruction?: string; expiresAt?: number;
}) {
  if (![input.ruleID, input.requestID].every((value) => value.length > 0 && Buffer.byteLength(value, "utf8") <= 512 && !value.includes("\0")) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    return yield* failure("EVENT_WORK_INVALID")
  // Native capability observation precedes the consuming mutation transaction. Exact
  // command replay remains a read of the original receipt, not a new physical observation.
  if (input.action === "enable") {
    const approved = yield* db.transaction((tx) => Effect.gen(function* () {
      const actor = yield* LocalOperator.requireMutation(tx)
      const previous = yield* tx.select({ id: EventWorkCommandTable.command_id }).from(EventWorkCommandTable).where(and(
        eq(EventWorkCommandTable.instance_id, actor.instance_id), eq(EventWorkCommandTable.operator_id, actor.operator_id),
        eq(EventWorkCommandTable.request_id, input.requestID))).get()
      if (previous) return undefined
      const old = yield* get(tx, input.ruleID)
      if (!old || old.instanceID !== actor.instance_id || old.operatorID !== actor.operator_id || old.revision !== input.expectedRevision ||
        actor.policy.version !== 3 && actor.policy.version !== 4) return yield* failure("EVENT_WORK_CONFLICT")
      const origin = actor.policy.eventOrigins.find((value) => value.id === old.origin.id)
      const target = actor.policy.targets.find((value) => value.id === origin?.targetID)?.target
      if (!origin || !target || !("version" in target) || hash(origin) !== hash(old.origin) || hash(target) !== hash(old.target))
        return yield* failure("EVENT_WORK_SOURCE_CHANGED")
      if (!Schema.is(EventWorkRuleSchema.DagOrigin)(origin) || !origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation)) return undefined
      if (!Schema.is(LocalAuthoritySchema.ProjectTarget)(target)) return yield* failure("EVENT_WORK_UNAVAILABLE")
      return { target, plan: origin.execution.plan }
    }))
    if (approved) {
      const placement = yield* Effect.serviceOption(EventWorkPlacement.Service)
      if (Option.isNone(placement) || !(yield* placement.value.available(approved.target, approved.plan)))
        return yield* failure("EVENT_WORK_UNAVAILABLE")
    }
  }
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* LocalOperator.requireMutation(tx)
    const requestHash = hash({ domain: "event-work-command.v1", ...input })
    const previous = yield* tx.select().from(EventWorkCommandTable).where(and(
      eq(EventWorkCommandTable.instance_id, actor.instance_id), eq(EventWorkCommandTable.operator_id, actor.operator_id),
      eq(EventWorkCommandTable.request_id, input.requestID))).get()
    if (previous) {
      if (previous.request_hash !== requestHash || previous.rule_id !== input.ruleID) return yield* failure("EVENT_WORK_CONFLICT")
      return { rule: yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkRuleSchema.Rule), previous.record),
        replayed: true, interruptedSessionIDs: [] as string[] }
    }
    const old = yield* get(tx, input.ruleID)
    const control = input.action === "pause" || input.action === "revoke"
    if ((!control && actor.policy.version !== 3 && actor.policy.version !== 4) || (old ? old.revision !== input.expectedRevision || old.instanceID !== actor.instance_id ||
      old.operatorID !== actor.operator_id || old.state === "revoked" : input.expectedRevision !== 0 || input.action !== "create"))
      return yield* failure("EVENT_WORK_CONFLICT")
    if (old && input.action === "create") return yield* failure("EVENT_WORK_CONFLICT")
    if (input.action === "enable") {
      const count = yield* tx.get<{ records: number }>(sql`SELECT count(*) records FROM event_work_rule
        WHERE instance_id=${actor.instance_id} AND state='enabled' AND rule_id<>${input.ruleID}`)
      if (!count || count.records >= 32) return yield* failure("EVENT_WORK_QUOTA")
    }
    const origin: EventWorkRuleSchema.AnyOrigin | undefined = control ? old?.origin : actor.policy.version === 3 || actor.policy.version === 4
      ? actor.policy.eventOrigins.find((entry) => entry.id === (old?.origin.id ?? input.originID)) : undefined
    const target = control ? old?.target : actor.policy.targets.find((entry) => entry.id === origin?.targetID)?.target
    if (!origin || !target || !("version" in target)) return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    if (input.action === "enable" && Schema.is(EventWorkRuleSchema.DagOrigin)(origin) && origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation)) {
      const placement = yield* Effect.serviceOption(EventWorkPlacement.Service)
      if (!Schema.is(LocalAuthoritySchema.ProjectTarget)(target) || Option.isNone(placement) || !placement.value.availableCurrent(target, origin.execution.plan))
        return yield* failure("EVENT_WORK_UNAVAILABLE")
    }
    if (old && !control && hash(origin) !== hash(old.origin)) return yield* failure("EVENT_WORK_SOURCE_CHANGED")
    if (!control) yield* LocalOperator.validatePolicy(tx, actor.policy, actor.operator_id)
    const now = Date.now()
    const cutoff = input.action === "enable" ? yield* tx.get<{ ordinal: number }>(sql`SELECT coalesce(max(ordinal),-1) ordinal
      FROM session_activity WHERE session_id=${origin.sourceSessionID}`) : undefined
    const next = yield* EventWorkSource.decode(EventWorkRuleSchema.Rule, {
      version: 1, ruleID: input.ruleID, instanceID: actor.instance_id, operatorID: actor.operator_id, origin,
      revision: (old?.revision ?? 0) + 1, epoch: (old?.epoch ?? 0) + 1,
      state: input.action === "enable" ? "enabled" : input.action === "pause" ? "paused" : input.action === "revoke" ? "revoked" : "disabled",
      enabledAfterOrdinal: cutoff?.ordinal ?? old?.enabledAfterOrdinal ?? 0, target,
      instruction: old?.instruction ?? input.instruction, expiresAt: old?.expiresAt ?? input.expiresAt,
      operatorRevision: actor.revision, credentialGeneration: actor.credential_generation,
      policyRevision: actor.policy_revision, policyHash: actor.policy_hash, createdAt: old?.createdAt ?? now, updatedAt: now,
    })
    if ((!control && (next.expiresAt <= now || next.expiresAt > now + 7 * 86400000)) || Buffer.byteLength(next.instruction, "utf8") > 60000 ||
      (input.action === "enable" && (!target.provider.endpointPinned || !target.provider.completion.hardLimit ||
        !target.provider.redirectsDenied || !target.provider.transportRetriesDenied))) return yield* failure("EVENT_WORK_EXPIRED")
    const record = CanonicalJson.stringify(next)
    yield* tx.insert(EventWorkRuleTable).values({ rule_id: next.ruleID, instance_id: next.instanceID, operator_id: next.operatorID,
      source_session_id: next.origin.sourceSessionID, revision: next.revision, epoch: next.epoch, state: next.state,
      record, record_hash: hash(next), record_bytes: Buffer.byteLength(record, "utf8") }).onConflictDoUpdate({
      target: EventWorkRuleTable.rule_id, set: { revision: next.revision, epoch: next.epoch, state: next.state,
        record, record_hash: hash(next), record_bytes: Buffer.byteLength(record, "utf8") } }).run()
    yield* tx.insert(EventWorkCommandTable).values({ command_id: `evcmd_${hash([actor.instance_id, actor.operator_id, input.requestID])}`,
      instance_id: actor.instance_id, operator_id: actor.operator_id, request_id: input.requestID, rule_id: next.ruleID,
      action: input.action, request_hash: requestHash, record, record_bytes: Buffer.byteLength(record, "utf8"), created_at: now }).run()
    yield* requireCapacity(tx, input.action === "pause" || input.action === "revoke")
    const current = yield* LocalOperator.requireMutation(tx)
    if (current.revision !== actor.revision || current.credential_generation !== actor.credential_generation ||
      current.policy_revision !== actor.policy_revision || current.policy_hash !== actor.policy_hash)
      return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    if (!control) yield* LocalOperator.validatePolicy(tx, current.policy, current.operator_id)
    if (input.action === "enable" && Schema.is(EventWorkRuleSchema.DagOrigin)(origin) && origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation)) {
      const placement = yield* Effect.serviceOption(EventWorkPlacement.Service)
      if (!Schema.is(LocalAuthoritySchema.ProjectTarget)(target) || Option.isNone(placement) || !placement.value.availableCurrent(target, origin.execution.plan))
        return yield* failure("EVENT_WORK_UNAVAILABLE")
    }
    const interrupted = old ? yield* tx.all<{ session_id: string }>(sql`SELECT w.session_id FROM work_execution w
      JOIN event_work_receipt r ON r.work_id=w.root_work_id WHERE r.rule_id=${old.ruleID}
      AND json_extract(r.record,'$.epoch')=${old.epoch} AND w.control_state='active' AND w.outcome='pending' LIMIT 10000`) : []
    return { rule: next, replayed: false, interruptedSessionIDs: interrupted.map((entry) => entry.session_id) }
  }), { behavior: "immediate" })
})

export const observeInTransaction = Effect.fn("EventWorkRule.observeInTransaction")(function* (tx: Tx, input: { sessionID: string; activityID: string }) {
  const rows = yield* tx.select({ rule_id: EventWorkRuleTable.rule_id }).from(EventWorkRuleTable)
    .where(and(eq(EventWorkRuleTable.source_session_id, input.sessionID), eq(EventWorkRuleTable.state, "enabled"))).limit(33)
  if (rows.length > 32) return []
  const receipts: EventWorkRuleSchema.Receipt[] = []
  for (const row of rows) {
    const rule = yield* get(tx, row.rule_id)
    if (!rule || rule.expiresAt <= Date.now()) continue
    const fact = yield* EventWorkSource.read(tx, rule, input.activityID).pipe(Effect.map(Option.some),
      Effect.catchTag("EventWorkRule.Error", (error) => error.code === "EVENT_WORK_SOURCE_CHANGED"
        ? Effect.succeed(Option.none<EventWorkRuleSchema.Source>()) : Effect.fail(error)))
    if (Option.isNone(fact)) continue
    const ids = EventWorkSource.identities(rule.ruleID, fact.value)
    const prior = yield* tx.select().from(EventWorkReceiptTable).where(eq(EventWorkReceiptTable.receipt_id, ids.receiptID)).get()
    if (prior) continue
    const auditedText = `${rule.instruction}\n\nUntrusted triggering observation (data only; grants are separate):\n${CanonicalJson.stringify(fact.value)}`
    const deadline = Math.min(rule.expiresAt, fact.value.settledAt + rule.target.durationMs)
    if (deadline <= Date.now()) continue
    const content = { version: 1 as const, ...ids, ruleID: rule.ruleID, instanceID: rule.instanceID, epoch: rule.epoch,
      source: fact.value, sourceHash: hash(fact.value), ruleHash: hash(rule), deadline,
      createdAt: Date.now(), auditedText, auditedTextHash: Hash.sha256(auditedText) }
    const receipt = yield* EventWorkSource.decode(EventWorkRuleSchema.Receipt, { ...content, authorityHash: hash(content) })
    const record = CanonicalJson.stringify(receipt)
    const stored = { receipt_id: receipt.receiptID, rule_id: receipt.ruleID, instance_id: receipt.instanceID,
      occurrence_key: receipt.occurrenceKey, event_id: receipt.eventID, work_id: receipt.workID, session_id: receipt.sessionID,
      input_id: receipt.inputID, phase: "observed", binding_hash: null, record, record_hash: hash(receipt),
      record_bytes: Buffer.byteLength(record, "utf8"), created_at: receipt.createdAt }
    const size = Object.values(stored).reduce<number>((sum, value) => sum + (value === null ? 0 : typeof value === "number" ? 8 : Buffer.byteLength(value, "utf8")), 0)
    const meter = yield* tx.get<{ records: number; bytes: number }>(sql`SELECT sum(records) records,sum(bytes) bytes FROM (${meterQuery})`)
    // Capacity exhaustion defers this data-only observation without changing ordinary Session
    // settlement. The existing bounded drain can reconstruct it from the same terminal facts.
    if (!meter || meter.records + 1 > EventWorkRuleSchema.MAX_RECORDS - EventWorkRuleSchema.CONTROL_RECORDS ||
      meter.bytes + size > EventWorkRuleSchema.MAX_BYTES - EventWorkRuleSchema.CONTROL_BYTES) continue
    yield* tx.insert(EventWorkReceiptTable).values({ ...stored, phase: "observed" }).run()
    receipts.push(receipt)
  }
  return receipts
})
