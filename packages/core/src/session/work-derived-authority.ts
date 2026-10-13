export * as WorkDerivedAuthority from "./work-derived-authority"

import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { EventWorkNodeAuthority } from "../deepagent/event-work-node-authority"
import { EventWorkNodeAuthorityTable } from "../deepagent/event-work-rule.sql"
import { WorkAuthority } from "./work-authority"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkChildAuthority } from "./work-child-authority"
import { WorkChildAuthorityTable } from "./work-child-authority.sql"
import { WorkDispatchReservationTable } from "./work-authority.sql"
import { EventWorkController } from "../deepagent/event-work-controller"
import { EventWorkDagPolicy } from "../deepagent/event-work-dag.policy"

const failure = () => new WorkAuthoritySchema.Error({ code: "WORK_RECOVERY_REQUIRED", message: "Original derived Work custody is missing, ambiguous or changed" })
/** Only original durable domains choose the adapter. Profile names/parent metadata cannot. */
export const get = Effect.fn("WorkDerivedAuthority.get")(function* (tx: Pick<WorkAuthority.Transaction, "select">, workID: string) {
  const task = yield* tx.select({ id: WorkChildAuthorityTable.child_work_id }).from(WorkChildAuthorityTable)
    .where(eq(WorkChildAuthorityTable.child_work_id, workID)).get()
  const event = yield* tx.select({ id: EventWorkNodeAuthorityTable.work_id }).from(EventWorkNodeAuthorityTable)
    .where(eq(EventWorkNodeAuthorityTable.work_id, workID)).get()
  if (Boolean(task) === Boolean(event)) return yield* failure()
  if (task) return yield* WorkChildAuthority.get(tx, workID)
  return yield* EventWorkNodeAuthority.get(tx, workID).pipe(Effect.mapError(() => failure()))
})
export const requireCurrent = Effect.fn("WorkDerivedAuthority.requireCurrent")(function* (tx: WorkAuthority.Transaction, work: WorkAuthority.Work) {
  const record = yield* get(tx, work.work_id)
  if (!record) return yield* failure()
  return "kind" in record && record.kind === "event_dag_node_v1"
    ? yield* EventWorkNodeAuthority.requireCurrent(tx, work).pipe(Effect.mapError(() => failure()))
    : yield* WorkChildAuthority.requireCurrent(tx, work)
})

/** Original known child facts only: does not revive current source or authorize another turn. */
export const requireTerminalProofControl = Effect.fn("WorkDerivedAuthority.requireTerminalProofControl")(function* (tx: WorkAuthority.Transaction,
  input: { workID: string; expectedRevision: number }) {
  const original = yield* get(tx, input.workID)
  if (!original) return yield* failure()
  if (!("kind" in original)) return yield* WorkChildAuthority.requireTerminalProofControl(tx, input)
  const child = yield* WorkAuthority.get(tx, input.workID)
  const root = yield* WorkAuthority.get(tx, original.rootWorkID)
  if (!child || !root || child.control_revision !== input.expectedRevision || child.admission_state !== "ready" ||
    child.outcome !== "succeeded" && child.outcome !== "failed" || child.binding_hash !== original.childBindingHash ||
    root.binding_hash !== original.rootBindingHash || child.root_work_id !== root.work_id || child.parent_work_id !== root.work_id ||
    child.session_id !== original.childSessionID || child.input_id !== original.childInputID ||
    child.source_record_hash !== root.source_record_hash || child.route_evidence_hash !== root.route_evidence_hash)
    return yield* failure()
  return child
})

/** Original settled event receipt is an accounting witness, not source/control permission. The
 * observed revision must be the real original dispatch revision, even after a later stop. */
export const requireEventTerminalProofControl = Effect.fn("WorkDerivedAuthority.requireEventTerminalProofControl")(function* (
  tx: WorkAuthority.Transaction, input: { workID: string; bindingHash: string; receiptID: string; observedRevision: number }) {
  const original = yield* get(tx, input.workID)
  if (!original || !("kind" in original) || original.kind !== "event_dag_node_v1") return yield* failure()
  const child = yield* WorkAuthority.get(tx, input.workID)
  const root = yield* WorkAuthority.get(tx, original.rootWorkID)
  const controller = yield* EventWorkController.get(tx, original.controllerID).pipe(Effect.mapError(() => failure()))
  const charge = yield* tx.select().from(WorkDispatchReservationTable).where(eq(WorkDispatchReservationTable.receipt_id, input.receiptID)).get()
  if (!child || !root || !controller || child.admission_state !== "ready" || child.outcome !== "succeeded" && child.outcome !== "failed" ||
    child.binding_hash !== input.bindingHash || child.binding_hash !== original.childBindingHash ||
    WorkAuthorityPolicy.fingerprint(child.binding) !== child.binding_hash || root.binding_hash !== original.rootBindingHash ||
    WorkAuthorityPolicy.fingerprint(root.binding) !== root.binding_hash || root.execution_role !== "dag_controller" ||
    !EventWorkDagPolicy.profileMatches(root.binding.profile) || controller.controller.rootWorkID !== root.work_id ||
    controller.controller.receiptID !== original.receiptID || controller.controller.planHash !== original.planHash ||
    child.root_work_id !== root.work_id || child.parent_work_id !== root.work_id || child.session_id !== original.childSessionID ||
    child.input_id !== original.childInputID || child.source_record_hash !== root.source_record_hash ||
    child.route_evidence_hash !== root.route_evidence_hash || !charge || charge.work_id !== child.work_id ||
    charge.root_work_id !== root.work_id || charge.state !== "settled" || charge.actual_usage === null ||
    charge.control_revision !== input.observedRevision || !WorkAuthorityPolicy.usageTotal(charge.actual_usage).ok)
    return yield* failure()
  return child
})
export const requireCountBudget = Effect.fn("WorkDerivedAuthority.requireCountBudget")(function* (tx: WorkAuthority.Transaction,
  work: WorkAuthority.Work, receiptID: string) {
  if (!WorkAuthorityPolicy.hasSharedRootProfile(work.binding.profile)) return
  const root = work.parent_work_id ? yield* WorkAuthority.get(tx, work.root_work_id) : work
  if (!root) return yield* failure()
  if (work.parent_work_id) yield* requireCurrent(tx, work)
  const slots = yield* tx.all<{ work_id: string }>(sql`SELECT c.work_id FROM work_count_acquisition c
    JOIN work_execution w ON w.work_id=c.work_id WHERE w.root_work_id=${work.root_work_id} AND c.provider_receipt_id<>${receiptID}`)
  const charges = yield* tx.select().from(WorkDispatchReservationTable).where(eq(WorkDispatchReservationTable.root_work_id, root.work_id)).all()
  const spent = charges.filter((item) => item.state !== "released")
  if (slots.length >= root.binding.budget.maxProviderDispatches || slots.filter((item) => item.work_id === work.work_id).length >= work.binding.budget.maxProviderDispatches ||
    spent.reduce((sum, item) => sum + item.charged_tokens, 0) >= root.binding.budget.maxTotalTokens ||
    spent.filter((item) => item.work_id === work.work_id).reduce((sum, item) => sum + item.charged_tokens, 0) >= work.binding.budget.maxTotalTokens)
    return yield* new WorkAuthoritySchema.Error({ code: "WORK_BUDGET_EXHAUSTED", message: "Original shared-root count or token budget is exhausted" })
})
