export * as EventWorkController from "./event-work-controller"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { WorkAuthority } from "../session/work-authority"
import type { WorkAuthoritySchema } from "../session/work-authority.schema"
import { WorkExecutionTable, WorkDispatchReservationTable } from "../session/work-authority.sql"
import { CanonicalJson } from "../util/canonical-json"
import { EventWorkAdmission } from "./event-work-admission"
import { EventWorkControllerTable } from "./event-work-controller.sql"
import { EventWorkDagPolicy } from "./event-work-dag.policy"
import { EventWorkDagSchema } from "./event-work-dag.schema"
import { EventWorkNodeAuthorityTable, EventWorkReceiptTable } from "./event-work-rule.sql"
import { EventWorkRule } from "./event-work-rule"
import { EventWorkSource } from "./event-work-source"
import { EventWorkResult } from "./event-work-result"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
const hash = EventWorkDagPolicy.hash
const failure = EventWorkDagPolicy.failure

export const get = Effect.fn("EventWorkController.get")(function* (tx: Tx, controllerID: string) {
  const row = yield* tx.select().from(EventWorkControllerTable).where(eq(EventWorkControllerTable.controller_id, controllerID)).get()
  if (!row) return undefined
  const controller = yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkDagSchema.Controller), row.record)
  if (hash(controller) !== row.record_hash || row.record_bytes !== Buffer.byteLength(row.record, "utf8") ||
    row.revision !== controller.revision || row.state !== controller.state || row.receipt_id !== controller.receiptID ||
    row.root_work_id !== controller.rootWorkID || controller.controllerID !== controllerID || hash(controller.plan) !== controller.planHash ||
    EventWorkDagPolicy.identities(controller.receiptID).controllerID !== controllerID) return yield* failure()
  const origin = yield* EventWorkAdmission.get(tx, controller.receiptID)
  const root = yield* WorkAuthority.get(tx, controller.rootWorkID)
  const rule = origin && (yield* EventWorkRule.get(tx, origin.receipt.ruleID))
  if (!origin || !root || !rule || !("execution" in rule.origin) || rule.origin.execution.kind !== "dag" ||
    controller.rootSessionID !== root.session_id || controller.rootInputID !== root.input_id || controller.rootWorkID !== origin.receipt.workID ||
    root.parent_work_id !== null || root.execution_role !== "dag_controller" || !EventWorkDagPolicy.profileMatches(root.binding.profile) ||
    root.binding.schemaVersion !== "work-execution.v2" || hash(root.binding) !== root.binding_hash ||
    controller.rootBindingHash !== root.binding_hash || origin.bindingHash !== root.binding_hash ||
    controller.ruleHash !== origin.receipt.ruleHash || controller.epoch !== origin.receipt.epoch ||
    controller.planHash !== hash(rule.origin.execution.plan) || controller.createdAt !== origin.receipt.createdAt ||
    controller.expiresAt !== origin.receipt.deadline) return yield* failure("EVENT_DAG_CONFLICT")
  if (controller.baseline && (controller.baseline.sourceHash !== root.source_record_hash ||
    controller.baseline.scopeHash !== hash(root.binding.toolPolicy.fileScope) ||
    hash(controller.baseline.rootIdentity) !== hash(root.binding.projectScope.rootIdentity) ||
    !controller.plan.nodes.some((node) => node.id === controller.baseline!.nodeID) ||
    controller.baseline.startedAt < controller.createdAt || controller.baseline.state === "sealed" && controller.baseline.sealedAt < controller.baseline.startedAt))
    return yield* failure("EVENT_DAG_CONFLICT")
  if (controller.baseline && ((controller.baseline.gitDirectory === undefined) !== (controller.baseline.gitRootIdentity === undefined) ||
    controller.baseline.state === "sealed" && controller.baseline.settledRetentionAt !== undefined &&
      (!["succeeded", "failed"].includes(controller.state) || controller.baseline.settledRetentionAt < controller.baseline.sealedAt)))
    return yield* failure("EVENT_DAG_CONFLICT")
  return { controller, receipt: origin.receipt, rootBinding: root.binding }
})

export const read = (db: Db, input: { eventID: string }) => db.transaction((tx) => Effect.gen(function* () {
  const row = yield* tx.select({ receiptID: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable)
    .where(eq(EventWorkReceiptTable.event_id, input.eventID)).get()
  return row ? yield* get(tx, EventWorkDagPolicy.identities(row.receiptID).controllerID!) : undefined
}))

export const currentInTransaction = Effect.fn("EventWorkController.currentInTransaction")(function* (tx: Tx, input: { controllerID: string }) {
  const value = yield* get(tx, input.controllerID)
  if (!value) return yield* failure("EVENT_DAG_UNAVAILABLE")
  if (value.controller.state === "unknown") return yield* failure("EVENT_DAG_UNKNOWN")
  if (value.controller.state !== "pending" && value.controller.state !== "running") return yield* failure("EVENT_DAG_NOT_READY")
  const source = yield* EventWorkAdmission.requireSource(tx, value.receipt.receiptID)
  const root = yield* WorkAuthority.get(tx, value.controller.rootWorkID)
  if (!root || root.control_state !== "active" || root.outcome !== "pending" || root.binding.deadline <= Date.now() ||
    source.bindingHash !== root.binding_hash || source.receipt.authorityHash !== root.source_record_hash) return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  // This reuses the real root verifier, but does not permit the controller to execute a model.
  yield* WorkAuthority.requireReservedInTransaction(tx, { workID: root.work_id, expectedRevision: root.control_revision })
  return value
})
export const current = (db: Db, input: { controllerID: string }) => db.transaction((tx) => currentInTransaction(tx, input), { behavior: "immediate" })

/** The trusted original factory invokes this before capturing current parent bytes. An
 * interrupted preparation retains its basis and reservation; it is never recaptured. */
export const beginBaseline = (db: Db, input: { controllerID: string; nodeID: string; expectedRevision: number;
  originalCommit: string; rootIdentity: WorkAuthoritySchema.ProjectBinding["projectScope"]["rootIdentity"];
  gitDirectory?: string; gitRootIdentity?: WorkAuthoritySchema.ProjectBinding["projectScope"]["rootIdentity"] }) => db.transaction((tx) => Effect.gen(function* () {
  const value = yield* currentInTransaction(tx, input)
  if (value.controller.revision !== input.expectedRevision || value.controller.activeNodeID !== input.nodeID ||
    hash(input.rootIdentity) !== hash(value.rootBinding.projectScope.rootIdentity)) return yield* failure("EVENT_DAG_CONFLICT")
  if (value.controller.baseline) return value
  const baseline = yield* EventWorkSource.decode(EventWorkDagSchema.Baseline, { version: 1, state: "preparing",
    originalCommit: input.originalCommit, scopeHash: hash(value.rootBinding.toolPolicy.fileScope),
    sourceHash: value.receipt.authorityHash, rootIdentity: input.rootIdentity,
    ...(input.gitDirectory && input.gitRootIdentity ? { gitDirectory: input.gitDirectory, gitRootIdentity: input.gitRootIdentity } : {}),
    nodeID: input.nodeID, startedAt: Date.now() })
  const next = { ...value.controller, revision: value.controller.revision + 1, baseline }
  yield* updateInTransaction(tx, value.controller, next)
  // The extra immutable baseline consumes custody before either Git objects or leaves exist.
  const { EventWorkNodeAuthority } = yield* Effect.promise(() => import("./event-work-node-authority"))
  yield* EventWorkNodeAuthority.requireWorkspaceCapacity(tx)
  return { ...value, controller: next }
}), { behavior: "immediate" })

export const sealBaseline = (db: Db, input: { controllerID: string; nodeID: string; expectedRevision: number;
  preparingHash: string; commit: string; manifestSha256: string; files: number; bytes: number; allocatedBytes: number }) => db.transaction((tx) => Effect.gen(function* () {
  const value = yield* currentInTransaction(tx, input)
  const prior = value.controller.baseline
  if (value.controller.revision !== input.expectedRevision || value.controller.activeNodeID !== input.nodeID ||
    !prior || prior.state !== "preparing" || hash(prior) !== input.preparingHash || prior.nodeID !== input.nodeID ||
    prior.scopeHash !== hash(value.rootBinding.toolPolicy.fileScope) || prior.sourceHash !== value.receipt.authorityHash ||
    hash(prior.rootIdentity) !== hash(value.rootBinding.projectScope.rootIdentity)) return yield* failure("EVENT_DAG_CONFLICT")
  const baseline = yield* EventWorkSource.decode(EventWorkDagSchema.Baseline, { ...prior, state: "sealed", commit: input.commit,
    manifestSha256: input.manifestSha256, files: input.files, bytes: input.bytes, allocatedBytes: input.allocatedBytes, sealedAt: Date.now() })
  const next = { ...value.controller, revision: value.controller.revision + 1, baseline }
  yield* updateInTransaction(tx, value.controller, next)
  return { ...value, controller: next }
}), { behavior: "immediate" })

export const markBaselineUnknown = (db: Db, input: { controllerID: string; preparingHash: string }) => db.transaction((tx) => Effect.gen(function* () {
  const value = yield* get(tx, input.controllerID)
  if (!value?.controller.baseline || value.controller.baseline.state !== "preparing" || hash(value.controller.baseline) !== input.preparingHash)
    return yield* failure("EVENT_DAG_CONFLICT")
  yield* updateInTransaction(tx, value.controller, { ...value.controller, revision: value.controller.revision + 1,
    state: "unknown", baseline: { ...value.controller.baseline, state: "unknown" } })
}), { behavior: "immediate" })

/** No wake: the root Session/input is a durable trace and escrow, not an extra agent turn. */
export const prepare = Effect.fn("EventWorkController.prepare")(function* (db: Db, input: { eventID: string }) {
  const value = yield* db.transaction((tx) => Effect.gen(function* () {
    const row = yield* tx.select({ id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable)
      .where(eq(EventWorkReceiptTable.event_id, input.eventID)).get()
    if (!row) return yield* failure("EVENT_DAG_UNAVAILABLE")
    const history = yield* get(tx, EventWorkDagPolicy.identities(row.id).controllerID!)
    if (history && (history.controller.state === "succeeded" || history.controller.state === "failed")) return history
    const source = yield* EventWorkAdmission.requireSource(tx, row.id)
    if (!("execution" in source.rule.origin) || source.rule.origin.execution.kind !== "dag") return yield* failure()
    const valid = EventWorkDagPolicy.validatePlan(source.rule.origin.execution.plan, source.rule.target)
    if (!valid.ok) return yield* valid.error
    const ids = EventWorkDagPolicy.identities(source.receipt.receiptID)
    const prior = yield* get(tx, ids.controllerID!)
    if (prior) return prior.controller.state === "succeeded" || prior.controller.state === "failed"
      ? prior : yield* currentInTransaction(tx, { controllerID: prior.controller.controllerID })
    const reserved = yield* EventWorkAdmission.reserveInTransaction(tx, source.receipt.receiptID)
    if (reserved.work.execution_role !== "dag_controller") return yield* failure()
    const controller: EventWorkDagSchema.Controller = { version: 1, controllerID: ids.controllerID!,
      receiptID: source.receipt.receiptID, rootWorkID: source.receipt.workID, rootSessionID: source.receipt.sessionID,
      rootInputID: source.receipt.inputID, rootBindingHash: source.bindingHash, plan: valid.plan, planHash: valid.planHash,
      ruleHash: source.receipt.ruleHash, epoch: source.receipt.epoch, revision: 1, state: "pending", activeNodeID: null,
      createdAt: source.receipt.createdAt, expiresAt: source.receipt.deadline }
    yield* tx.insert(EventWorkControllerTable).values({ controller_id: controller.controllerID, receipt_id: controller.receiptID,
      root_work_id: controller.rootWorkID, revision: controller.revision, state: controller.state,
      record: CanonicalJson.stringify(controller), record_hash: hash(controller), record_bytes: Buffer.byteLength(CanonicalJson.stringify(controller), "utf8") }).run()
    yield* EventWorkRule.requireCapacity(tx)
    return yield* currentInTransaction(tx, { controllerID: controller.controllerID })
  }), { behavior: "immediate" })
  const root = yield* WorkAuthority.get(db, value.controller.rootWorkID)
  if (!root) return yield* failure()
  if (value.controller.state === "succeeded" || value.controller.state === "failed") return value
  // The provider/count registry reads this controller during bootstrap. Loading Session admission
  // only at materialization avoids cycling back into the unfinished V2 provider module.
  const { WorkAdmission } = yield* Effect.promise(() => import("../session/work-admission"))
  yield* WorkAdmission.materializeReserved({ workID: root.work_id, expectedRevision: root.control_revision, auditedText: value.receipt.auditedText })
  return yield* current(db, { controllerID: value.controller.controllerID })
})

/** Internal CAS; every caller owns the immediate transaction and a validated original record. */
export const updateInTransaction = Effect.fn("EventWorkController.updateInTransaction")(function* (tx: Tx, previous: EventWorkDagSchema.Controller,
  next: EventWorkDagSchema.Controller) {
  if (next.revision !== previous.revision + 1) return yield* failure("EVENT_DAG_CONFLICT")
  const changed = yield* tx.update(EventWorkControllerTable).set({ revision: next.revision, state: next.state,
    record: CanonicalJson.stringify(next), record_hash: hash(next), record_bytes: Buffer.byteLength(CanonicalJson.stringify(next), "utf8") })
    .where(and(eq(EventWorkControllerTable.controller_id, previous.controllerID), eq(EventWorkControllerTable.revision, previous.revision),
      eq(EventWorkControllerTable.record_hash, hash(previous)))).returning().get()
  if (!changed) return yield* failure("EVENT_DAG_CONFLICT")
  yield* EventWorkRule.requireCapacity(tx, true)
})

/** Known original physical facts can be reconciled after stop/expiry; never dispatch permission. */
export const recordTerminal = (db: Db, input: { controllerID: string; nodeID: string }) => db.transaction((tx) => Effect.gen(function* () {
  const value = yield* get(tx, input.controllerID)
  const node = value?.controller.plan.nodes.find((item) => item.id === input.nodeID)
  if (!value || !node) return yield* failure()
  const ids = EventWorkDagPolicy.identities(value.controller.receiptID, node.id)
  const observed = yield* EventWorkResult.readTerminal(tx, ids.workID!)
  const stored = yield* tx.select().from(EventWorkNodeAuthorityTable).where(eq(EventWorkNodeAuthorityTable.work_id, ids.workID!)).get()
  if (!stored) return yield* failure()
  const authority = yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkDagSchema.Authority), stored.record)
  if (authority.terminal) return { ...value, terminal: observed.terminal }
  if (value.controller.activeNodeID !== node.id || stored.state !== "bound") return yield* failure("EVENT_DAG_CONFLICT")
  const terminalRecord = { ...authority, terminal: observed.terminal }
  yield* tx.update(EventWorkNodeAuthorityTable).set({ state: "terminal", record: CanonicalJson.stringify(terminalRecord),
    record_hash: hash(terminalRecord), record_bytes: Buffer.byteLength(CanonicalJson.stringify(terminalRecord), "utf8") })
    .where(and(eq(EventWorkNodeAuthorityTable.authority_id, authority.authorityID), eq(EventWorkNodeAuthorityTable.record_hash, stored.record_hash))).run()
  const count = yield* tx.get<{ n: number; failed: number }>(sql`SELECT count(*) n,coalesce(sum(json_extract(record,'$.terminal.outcome')='failed'),0) failed
    FROM event_work_node_authority WHERE receipt_id=${value.controller.receiptID} AND state='terminal'`)
  const state = observed.terminal.outcome === "failed" || count!.failed > 0 ? "failed" : count!.n === value.controller.plan.nodes.length ? "succeeded" : "running"
  const next = { ...value.controller, revision: value.controller.revision + 1, state, activeNodeID: null } as EventWorkDagSchema.Controller
  yield* updateInTransaction(tx, value.controller, next)
  if (state === "failed" || state === "succeeded") {
    const debt = yield* tx.select({ id: WorkDispatchReservationTable.reservation_id }).from(WorkDispatchReservationTable)
      .where(and(eq(WorkDispatchReservationTable.root_work_id, value.controller.rootWorkID), sql`${WorkDispatchReservationTable.state} IN ('unknown','dispatching')`)).get()
    if (debt) return yield* failure("EVENT_DAG_UNKNOWN")
    yield* tx.update(WorkExecutionTable).set({ outcome: state, updated_at: Date.now() }).where(and(
      eq(WorkExecutionTable.work_id, value.controller.rootWorkID), eq(WorkExecutionTable.execution_role, "dag_controller"),
      eq(WorkExecutionTable.outcome, "pending"))).run()
  }
  return { ...value, controller: next, terminal: observed.terminal }
}), { behavior: "immediate" })

export const markUnknown = (db: Db, input: { controllerID: string; nodeID: string }) => db.transaction((tx) => Effect.gen(function* () {
  const value = yield* get(tx, input.controllerID)
  if (!value || value.controller.activeNodeID !== input.nodeID) return yield* failure("EVENT_DAG_CONFLICT")
  const ids = EventWorkDagPolicy.identities(value.controller.receiptID, input.nodeID)
  const debt = yield* tx.get<{ found: number }>(sql`SELECT 1 found FROM work_execution w WHERE w.work_id=${ids.workID!}
    AND (w.outcome='unknown' OR EXISTS(SELECT 1 FROM work_dispatch_reservation r WHERE r.work_id=w.work_id AND r.state IN ('unknown','dispatching'))
      OR EXISTS(SELECT 1 FROM event_work_node_authority n JOIN event_task_workspace p
        ON p.event_id=json_extract(n.record,'$.placement.eventID') AND p.task_id=n.node_id AND p.generation=0
        WHERE n.work_id=w.work_id AND p.error='formal_physical_unknown'))
    LIMIT 1`)
  if (!debt) return value
  if (value.controller.state !== "unknown") yield* updateInTransaction(tx, value.controller,
    { ...value.controller, revision: value.controller.revision + 1, state: "unknown" })
  return yield* get(tx, input.controllerID)
}), { behavior: "immediate" })
