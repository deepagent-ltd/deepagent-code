export * as EventWorkManagement from "./event-work-management"

import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { LocalOperator } from "../im/local-operator"
import { Location } from "../location"
import { SessionSchema } from "../session/schema"
import { SessionTable, EventTaskWorkspaceTable } from "../session/sql"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { WorkExecutionProfile } from "../session/work-execution-profile"
import { WorkExecutionTable, WorkDispatchReservationTable } from "../session/work-authority.sql"
import { EventWorkAdmission } from "./event-work-admission"
import { EventWorkController } from "./event-work-controller"
import { EventWorkDagPolicy } from "./event-work-dag.policy"
import { EventWorkManagementSchema } from "./event-work-management.schema"
import { EventWorkNodeAuthority } from "./event-work-node-authority"
import { EventWorkRule } from "./event-work-rule"
import { EventWorkRuleSchema } from "./event-work-rule.schema"
import { EventWorkReceiptTable, EventWorkRuleTable } from "./event-work-rule.sql"
import { EventWorkSource } from "./event-work-source"
import { EventWorkPlacement } from "./event-work-placement"

type Tx = WorkAuthority.Transaction
const hash = (value: unknown) => EventWorkSource.hash(value)
const failure = (code?: EventWorkRuleSchema.Error["code"]) => EventWorkSource.failure(code)
const mode = (origin: EventWorkRuleSchema.AnyOrigin) => "execution" in origin ? "dag" as const : "single" as const
const ruleSummary = (rule: EventWorkRuleSchema.Rule, executable: boolean): EventWorkManagementSchema.Rule => ({
  ruleID: rule.ruleID, revision: rule.revision, epoch: rule.epoch, originID: rule.origin.id, targetID: rule.origin.targetID,
  mode: mode(rule.origin), state: rule.state, instruction: rule.instruction, expiresAt: rule.expiresAt,
  enabledAfterOrdinal: rule.enabledAfterOrdinal,
  ...("execution" in rule.origin ? { planID: rule.origin.execution.plan.id, planHash: hash(rule.origin.execution.plan) } : {}),
  allowedActions: rule.state === "revoked" ? [] : executable && rule.expiresAt > Date.now() && (rule.state === "disabled" || rule.state === "paused")
    ? ["enable", "revoke"] : rule.state === "enabled" ? ["pause", "revoke"] : ["revoke"],
})

/** Original scoped services and an enrolled operator authorize management. Session hints, event
 * bodies and generic HTTP authentication do not acquire this service's mutation capability. */
export const make = Effect.fn("EventWorkManagement.make")(function* (db: Database.Interface["db"], input: { sourceSessionID: string }) {
  const location = yield* Location.Service
  const authority = Effect.fn("EventWorkManagement.authority")(function* (tx: Tx) {
    const actor = yield* LocalOperator.requireCurrent(tx)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(input.sourceSessionID))).get()
    if (!session || location.workspaceID !== undefined || session.workspace_id !== null || session.parent_id !== null ||
      session.directory !== location.directory || session.project_id !== location.project.id ||
      (yield* WorkAuthority.lookupSession(tx, session.id)).kind !== "ordinary" ||
      actor.policy.version !== 3 && actor.policy.version !== 4) return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    yield* LocalOperator.validatePolicy(tx, actor.policy, actor.operator_id)
    return actor
  })
  const ownedRule = Effect.fn("EventWorkManagement.ownedRule")(function* (tx: Tx, ruleID: string) {
    const actor = yield* authority(tx)
    const rule = yield* EventWorkRule.get(tx, ruleID)
    if (!rule || rule.instanceID !== actor.instance_id || rule.operatorID !== actor.operator_id || rule.origin.sourceSessionID !== input.sourceSessionID ||
      rule.target.location.directory !== location.directory || rule.target.location.workspaceID !== undefined || rule.target.projectScope.projectID !== location.project.id)
      return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    return { actor, rule }
  })
  const rootSummary = Effect.fn("EventWorkManagement.rootSummary")(function* (tx: Tx, receiptID: string) {
    const original = yield* EventWorkAdmission.get(tx, receiptID)
    if (!original) return yield* failure("EVENT_WORK_UNAVAILABLE")
    const { rule } = yield* ownedRule(tx, original.receipt.ruleID)
    const work = yield* WorkAuthority.get(tx, original.receipt.workID)
    if (!work || work.binding_hash !== original.bindingHash || hash(work.binding) !== work.binding_hash || work.binding.schemaVersion !== "work-execution.v2")
      return yield* failure("EVENT_WORK_UNAVAILABLE")
    const controller = mode(rule.origin) === "dag" ? yield* EventWorkController.get(tx, EventWorkDagPolicy.identities(receiptID).controllerID!) : undefined
    if (mode(rule.origin) === "dag" && !controller) return yield* failure("EVENT_WORK_UNAVAILABLE")
    const charges = yield* tx.select().from(WorkDispatchReservationTable).where(eq(WorkDispatchReservationTable.root_work_id, work.work_id)).all()
    if (charges.length > work.binding.budget.maxProviderDispatches) return yield* failure("EVENT_WORK_INVALID")
    const sourceCurrent = yield* EventWorkAdmission.requireSource(tx, receiptID).pipe(Effect.as(true),
      Effect.catchTag("EventWorkRule.Error", () => Effect.succeed(false)), Effect.catchTag("WorkAuthority.Error", () => Effect.succeed(false)))
    const usage = (rows: typeof charges): WorkAuthoritySchema.Usage | undefined => rows.length && rows.every((row) => row.state === "settled" && row.actual_usage)
      ? { inputTokens: rows.reduce((sum, row) => sum + row.actual_usage!.inputTokens, 0),
          completionTokens: rows.reduce((sum, row) => sum + row.actual_usage!.completionTokens, 0) } : undefined
    const planned = controller?.controller.plan.nodes ?? [{ id: "single", agentID: work.agent_id, dependencies: [], requiresWriteIsolation: false }]
    const nodes: EventWorkManagementSchema.Node[] = []
    for (const node of planned) {
      const isolated = controller ? EventWorkDagPolicy.requiresPlacement(controller.controller.plan,
        controller.controller.plan.nodes.find((item) => item.id === node.id)!) : false
      const nodeWorkID = controller ? EventWorkDagPolicy.identities(receiptID, node.id).workID! : work.work_id
      const current = yield* WorkAuthority.get(tx, nodeWorkID)
      const record = controller && current ? yield* EventWorkNodeAuthority.get(tx, nodeWorkID) : undefined
      const workspace = controller && isolated ? yield* tx.select().from(EventTaskWorkspaceTable).where(and(
        eq(EventTaskWorkspaceTable.event_id, controller.receipt.eventID), eq(EventTaskWorkspaceTable.task_id, node.id),
        eq(EventTaskWorkspaceTable.generation, 0))).get() : undefined
      const physicalUnknown = workspace?.error === "formal_physical_unknown"
      const qualified = record?.placement ? yield* EventWorkNodeAuthority.requirePlacementCustody(tx, record).pipe(Effect.as(true),
        Effect.catchTag("EventWorkDag.Error", () => Effect.succeed(false)), Effect.catchTag("WorkAuthority.Error", () => Effect.succeed(false))) : !isolated
      const own = charges.filter((row) => row.work_id === nodeWorkID && row.state !== "released")
      const placed = qualified && current && sourceCurrent && current.admission_state === "ready" && current.outcome !== "unknown" &&
        current.control_state === "active" && work.control_state === "active" && current.binding.deadline > Date.now()
        ? yield* WorkExecutionProfile.requirePlacement(tx, current).pipe(Effect.as(true), Effect.catchTag("WorkAuthority.Error", () => Effect.succeed(false))) : false
      nodes.push({ nodeID: node.id, agentID: node.agentID, dependencies: node.dependencies,
        state: physicalUnknown ? "unknown" : !current ? workspace ? "reserved" : "awaiting_dependencies" : current.outcome !== "pending" ? current.outcome :
          current.control_state !== "active" ? "cancelled" : own.some((row) => row.state === "dispatching") ? "running" :
            current.admission_state === "ready" ? "ready" : "reserved",
        ...(current ? { workID: current.work_id, sessionID: current.session_id, inputID: current.input_id, controlRevision: current.control_revision } : {}),
        reservedTokens: own.filter((row) => row.state === "reserved" || row.state === "dispatching" || row.state === "unknown")
          .reduce((sum, row) => sum + row.charged_tokens, 0), ...(usage(own) ? { actualUsage: usage(own) } : {}),
        ...(record?.terminal ? { resultHash: record.terminal.resultHash, terminalHash: hash(record.terminal) } : {}),
        ...(physicalUnknown ? { reason: "workspace_unknown" } : isolated && !qualified ? { reason: "isolation_unavailable" } : {}), sessionAvailable: placed })
    }
    return { rootID: work.work_id, receiptID, ruleID: rule.ruleID, revision: controller?.controller.revision ?? work.control_revision,
      mode: mode(rule.origin), state: controller?.controller.state ?? work.outcome, controlState: work.control_state,
      expiresAt: original.receipt.deadline, ...(controller ? { planID: controller.controller.plan.id, planHash: controller.controller.planHash } : {}),
      budget: work.binding.budget, reservedTokens: charges.filter((row) => row.state === "reserved" || row.state === "dispatching" || row.state === "unknown")
        .reduce((sum, row) => sum + row.charged_tokens, 0), ...(usage(charges.filter((row) => row.state !== "released")) ? { actualUsage: usage(charges.filter((row) => row.state !== "released")) } : {}),
      providerConcurrency: 1, schedulingConcurrency: controller?.controller.plan.maxConcurrent ?? 1, nodes,
      allowedActions: work.control_state === "active" || work.control_state === "paused" ? ["cancel"] : [] } satisfies EventWorkManagementSchema.Root
  })
  const candidates = () => Effect.gen(function* () {
    const before = yield* db.transaction(authority)
    const placement = yield* Effect.serviceOption(EventWorkPlacement.Service)
    const observed = new Set<string>()
    if (before.policy.version !== 3 && before.policy.version !== 4) return []
    for (const origin of before.policy.eventOrigins.map((value): EventWorkRuleSchema.AnyOrigin => value).filter((value) => value.sourceSessionID === input.sourceSessionID)) {
      const target = before.policy.targets.find((value) => value.id === origin.targetID)?.target
      if (!target || !("version" in target) || target.location.directory !== location.directory) continue
      if (!("execution" in origin) || !origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation)) {
        observed.add(origin.id)
        continue
      }
      if (Option.isSome(placement) && (yield* placement.value.available(target, origin.execution.plan).pipe(
        Effect.catchTag("WorkAuthority.Error", () => Effect.succeed(false))))) observed.add(origin.id)
    }
    return yield* db.transaction((tx) => Effect.gen(function* () {
      const actor = yield* authority(tx)
      if (actor.revision !== before.revision || actor.policy_revision !== before.policy_revision || actor.policy_hash !== before.policy_hash ||
        actor.credential_generation !== before.credential_generation || actor.policy.version !== 3 && actor.policy.version !== 4)
        return yield* failure("EVENT_WORK_SOURCE_CHANGED")
      const now = Date.now()
      return actor.policy.eventOrigins.filter((origin) => origin.sourceSessionID === input.sourceSessionID).flatMap((origin: EventWorkRuleSchema.AnyOrigin) => {
        const target = actor.policy.targets.find((item) => item.id === origin.targetID)?.target
        if (!target || !("version" in target) || target.location.directory !== location.directory) return []
        const isolated = "execution" in origin && origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation)
        const available = observed.has(origin.id) && (!isolated || Option.isSome(placement) &&
          "execution" in origin && placement.value.availableCurrent(target, origin.execution.plan))
        return [{ originID: origin.id, targetID: origin.targetID, sourceSessionID: origin.sourceSessionID, mode: mode(origin),
          profile: target.profile, providerID: target.provider.providerID, modelID: target.provider.modelID, budget: target.budget,
          serverNow: now, maxExpiresAt: now + 7 * 86400000, available,
          ...(!available ? { reason: "isolation_unavailable" } : {}),
          ...("execution" in origin ? { plan: origin.execution.plan, planHash: hash(origin.execution.plan) } : {}) } satisfies EventWorkManagementSchema.Candidate]
      })
    }))
  })
  const rules = (page: typeof EventWorkManagementSchema.Page.Type = {}) => Effect.gen(function* () {
    const available = yield* candidates()
    return yield* db.transaction((tx) => Effect.gen(function* () {
    yield* authority(tx)
    const rows = yield* tx.select({ id: EventWorkRuleTable.rule_id }).from(EventWorkRuleTable)
      .where(and(eq(EventWorkRuleTable.source_session_id, input.sourceSessionID), page.after ? gt(EventWorkRuleTable.rule_id, page.after) : undefined))
      .orderBy(asc(EventWorkRuleTable.rule_id)).limit((page.limit ?? 32) + 1)
    const items: EventWorkManagementSchema.Rule[] = []
    for (const row of rows.slice(0, page.limit ?? 32)) {
      const { rule } = yield* ownedRule(tx, row.id)
      const executable = yield* EventWorkRule.requireCurrent(tx, row.id).pipe(Effect.as(true), Effect.catchTag("EventWorkRule.Error", () => Effect.succeed(false)))
      items.push(ruleSummary(rule, (executable || rule.state === "disabled" || rule.state === "paused") &&
        available.some((candidate) => candidate.originID === rule.origin.id && candidate.available)))
    }
    return { items, nextCursor: rows.length > (page.limit ?? 32) ? items.at(-1)?.ruleID ?? null : null }
    }))
  })
  const roots = (page: typeof EventWorkManagementSchema.Page.Type & { ruleID?: string } = {}) => Effect.gen(function* () {
    const placements = yield* db.transaction((tx) => Effect.gen(function* () {
      const actor = yield* authority(tx)
      if (page.ruleID) yield* ownedRule(tx, page.ruleID)
      return yield* tx.all<{ work_id: string }>(sql`SELECT n.work_id FROM event_work_node_authority n
        WHERE json_type(n.record,'$.placement')='object' AND n.receipt_id IN (
          SELECT r.receipt_id FROM event_work_receipt r JOIN event_work_rule q ON q.rule_id=r.rule_id
          WHERE q.source_session_id=${input.sourceSessionID} AND q.instance_id=${actor.instance_id} AND q.operator_id=${actor.operator_id}
            ${page.ruleID ? sql`AND q.rule_id=${page.ruleID}` : sql``}
            ${page.after ? sql`AND r.receipt_id>${page.after}` : sql``}
          ORDER BY r.receipt_id LIMIT ${page.limit ?? 32}) ORDER BY n.work_id LIMIT 65`)
    }))
    if (placements.length > EventWorkPlacement.MAX_WORKSPACES) return yield* failure("EVENT_WORK_QUOTA")
    for (const placement of placements) yield* EventWorkNodeAuthority.preparePlacement(db, { workID: placement.work_id }).pipe(
      Effect.catchTag("EventWorkDag.Error", () => Effect.void), Effect.catchTag("WorkAuthority.Error", () => Effect.void))
    return yield* db.transaction((tx) => Effect.gen(function* () {
    yield* authority(tx)
    if (page.ruleID) yield* ownedRule(tx, page.ruleID)
    const rows = yield* tx.select({ id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable)
      .innerJoin(EventWorkRuleTable, eq(EventWorkRuleTable.rule_id, EventWorkReceiptTable.rule_id))
      .innerJoin(WorkExecutionTable, eq(WorkExecutionTable.work_id, EventWorkReceiptTable.work_id))
      .where(and(eq(EventWorkRuleTable.source_session_id, input.sourceSessionID), page.ruleID ? eq(EventWorkRuleTable.rule_id, page.ruleID) : undefined,
        page.after ? gt(EventWorkReceiptTable.receipt_id, page.after) : undefined))
      .orderBy(asc(EventWorkReceiptTable.receipt_id)).limit((page.limit ?? 32) + 1)
    const items: EventWorkManagementSchema.Root[] = []
    for (const row of rows.slice(0, page.limit ?? 32)) items.push(yield* rootSummary(tx, row.id))
    return { items, nextCursor: rows.length > (page.limit ?? 32) ? items.at(-1)?.receiptID ?? null : null }
    }))
  })
  const ruleControl = Effect.fn("EventWorkManagement.ruleControl")(function* (command: typeof EventWorkManagementSchema.RuleCommand.Type) {
    yield* db.transaction((tx) => Effect.gen(function* () {
      const actor = yield* authority(tx)
      if (command.action !== "create") return yield* ownedRule(tx, command.ruleID)
      if (actor.policy.version !== 3 && actor.policy.version !== 4 ||
        !actor.policy.eventOrigins.some((origin) => origin.id === command.originID && origin.sourceSessionID === input.sourceSessionID))
        return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    }))
    const result = yield* EventWorkRule.command(db, command)
    const placement = yield* Effect.serviceOption(EventWorkPlacement.Service)
    const qualified = !("execution" in result.rule.origin) || !result.rule.origin.execution.plan.nodes.some((node) => node.requiresWriteIsolation) ||
      Option.isSome(placement) && placement.value.availableCurrent(result.rule.target, result.rule.origin.execution.plan)
    return { requestID: command.requestID, expectedRevision: command.expectedRevision, action: command.action,
      replayed: result.replayed, rule: ruleSummary(result.rule, qualified), interruptedSessionIDs: result.interruptedSessionIDs }
  })
  const rootControl = (command: typeof EventWorkManagementSchema.RootCommand.Type) => db.transaction((tx) => Effect.gen(function* () {
    const actor = yield* authority(tx)
    const mutation = yield* LocalOperator.requireMutation(tx)
    if (mutation.revision !== actor.revision) return yield* failure("EVENT_WORK_AUTH_REQUIRED")
    const row = yield* tx.select({ id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable).where(eq(EventWorkReceiptTable.work_id, command.rootID)).get()
    if (!row) return yield* failure("EVENT_WORK_UNAVAILABLE")
    const before = yield* rootSummary(tx, row.id)
    const work = yield* WorkAuthority.get(tx, command.rootID)
    const prior = work!.control_receipts.find((receipt) => receipt.requestID === `event-root:${command.requestID}`)
    if (prior) {
      if (prior.expectedRevision !== command.expectedRevision || prior.action !== "event_root_cancel") return yield* failure("EVENT_WORK_CONFLICT")
      return { requestID: command.requestID, expectedRevision: command.expectedRevision, action: command.action, replayed: true, root: before, interruptedSessionIDs: [] as string[] }
    }
    if (before.revision !== command.expectedRevision || !before.allowedActions.includes("cancel") || work!.control_receipts.length >= 128)
      return yield* failure("EVENT_WORK_CONFLICT")
    const receipt = { requestID: `event-root:${command.requestID}`, action: "event_root_cancel", expectedRevision: command.expectedRevision,
      revision: work!.control_revision + 1, state: "cancelled" as const }
    yield* tx.update(WorkExecutionTable).set({ control_state: "cancelled", control_revision: receipt.revision,
      control_receipts: [...work!.control_receipts, receipt], updated_at: Date.now() }).where(and(
        eq(WorkExecutionTable.work_id, command.rootID), eq(WorkExecutionTable.control_revision, work!.control_revision))).run()
    if (before.mode === "dag") {
      const value = yield* EventWorkController.get(tx, EventWorkDagPolicy.identities(row.id).controllerID!)
      if (!value) return yield* failure()
      yield* EventWorkController.updateInTransaction(tx, value.controller, { ...value.controller, revision: value.controller.revision + 1 })
    }
    const affected = yield* tx.all<{ session_id: string }>(sql`SELECT session_id FROM work_execution
      WHERE root_work_id=${command.rootID} AND outcome='pending' LIMIT 33`)
    yield* LocalOperator.requireMutation(tx)
    return { requestID: command.requestID, expectedRevision: command.expectedRevision, action: command.action, replayed: false,
      root: yield* rootSummary(tx, row.id), interruptedSessionIDs: affected.map((item) => item.session_id) }
  }), { behavior: "immediate" })
  const session = (query: { rootID: string; nodeID: string }) => Effect.gen(function* () {
    const child = yield* db.transaction((tx) => Effect.gen(function* () {
      const row = yield* tx.select({ id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable).where(eq(EventWorkReceiptTable.work_id, query.rootID)).get()
      if (!row) return yield* failure("EVENT_WORK_UNAVAILABLE")
      const original = yield* EventWorkAdmission.requireSource(tx, row.id)
      yield* ownedRule(tx, original.rule.ruleID)
      return mode(original.rule.origin) === "dag" ? EventWorkDagPolicy.identities(row.id, query.nodeID).workID : undefined
    }))
    if (child) yield* EventWorkNodeAuthority.preparePlacement(db, { workID: child })
    return yield* db.transaction((tx) => Effect.gen(function* () {
    const row = yield* tx.select({ id: EventWorkReceiptTable.receipt_id }).from(EventWorkReceiptTable).where(eq(EventWorkReceiptTable.work_id, query.rootID)).get()
    if (!row) return yield* failure("EVENT_WORK_UNAVAILABLE")
    const original = yield* EventWorkAdmission.requireSource(tx, row.id)
    yield* ownedRule(tx, original.rule.ruleID)
    const controller = mode(original.rule.origin) === "dag" ? yield* EventWorkController.get(tx, EventWorkDagPolicy.identities(row.id).controllerID!) : undefined
    const authority = controller ? yield* EventWorkNodeAuthority.get(tx, EventWorkDagPolicy.identities(row.id, query.nodeID).workID!) : undefined
    if (controller ? !authority || authority.controllerID !== controller.controller.controllerID : query.nodeID !== "single") return yield* failure("EVENT_WORK_UNAVAILABLE")
    const work = yield* WorkAuthority.get(tx, authority?.childWorkID ?? original.receipt.workID)
    const root = yield* WorkAuthority.get(tx, original.receipt.workID)
    if (!work || !root || root.control_state !== "active" || work.control_state !== "active" || work.admission_state !== "ready" ||
      work.binding.deadline <= Date.now() || work.outcome === "unknown" || original.bindingHash !== root.binding_hash)
      return yield* failure("EVENT_WORK_UNAVAILABLE")
    yield* WorkExecutionProfile.requirePlacement(tx, work)
    if (authority?.placement) yield* EventWorkNodeAuthority.requirePlacementCustody(tx, authority)
    const placed = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id))).get()
    if (!placed || work.binding.schemaVersion !== "work-execution.v2") return yield* failure("EVENT_WORK_UNAVAILABLE")
    yield* EventWorkAdmission.requireSource(tx, row.id)
    if (work.binding.deadline <= Date.now()) return yield* failure("EVENT_WORK_EXPIRED")
    return { version: 1, rootID: root.work_id, nodeID: query.nodeID, workID: work.work_id, sessionID: work.session_id, inputID: work.input_id,
      rootRevision: controller?.controller.revision ?? root.control_revision, controlRevision: work.control_revision, bindingHash: work.binding_hash,
      placement: { directory: placed.directory, workspaceID: placed.workspace_id, projectID: placed.project_id,
        securityNamespaceID: work.security_namespace_id, namespaceBindingHash: work.binding.projectScope.namespaceBindingHash },
      expiresAt: work.binding.deadline } satisfies EventWorkManagementSchema.SessionPointer
    }), { behavior: "immediate" })
  })
  return { candidates, rules, roots, ruleControl, rootControl, session }
})
