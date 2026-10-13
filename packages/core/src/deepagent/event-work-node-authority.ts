export * as EventWorkNodeAuthority from "./event-work-node-authority"

import { and, eq, or, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { EventTaskWorkspaceTable, SessionTable } from "../session/sql"
import { LocationIdentityTable, ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"
import { WorkAuthority } from "../session/work-authority"
import { WorkAuthorityPolicy } from "../session/work-authority-policy"
import { TaskWorkspace } from "../session/task-workspace"
import { WorkCommandSchema } from "../session/work-command.schema"
import { WorkWriteStageSchema } from "../session/work-write-stage.schema"
import { WorkExecutionProfile } from "../session/work-execution-profile"
import { WorkExecutionTable, WorkDispatchReservationTable } from "../session/work-authority.sql"
import { CanonicalJson } from "../util/canonical-json"
import { EventWorkController } from "./event-work-controller"
import { EventWorkDagPolicy } from "./event-work-dag.policy"
import { EventWorkDagSchema } from "./event-work-dag.schema"
import { EventWorkNodeAuthorityTable } from "./event-work-rule.sql"
import { EventWorkRule } from "./event-work-rule"
import { EventWorkSource } from "./event-work-source"
import { EventWorkResult } from "./event-work-result"
import { EventWorkPlacement } from "./event-work-placement"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
const hash = EventWorkDagPolicy.hash
const failure = EventWorkDagPolicy.failure

/** State/continuation are mutable custody facts; the original preparation identity is not. */
export const workspaceIdentityHash = (row: typeof EventTaskWorkspaceTable.$inferSelect) => hash({
  eventID: row.event_id, nodeID: row.task_id, generation: row.generation, operationKey: row.operation_key,
  repositoryRoot: row.repository_root, baseCommit: row.base_commit, branch: row.branch, directory: row.directory,
  createdAt: row.time_created,
})

/** Every reserved frontier is charged before filesystem work. An existing physical row counts
 * once, even before its node Work exists; unknown and retained artifacts never age out here. */
export const requireWorkspaceCapacity = Effect.fn("EventWorkNodeAuthority.requireWorkspaceCapacity")(function* (tx: Tx) {
  const external = yield* tx.get<{ commands: number; stages: number }>(sql`SELECT
    (SELECT coalesce(sum(retained_bytes),0) FROM work_command_meter) commands,
    (SELECT coalesce(sum(retained_bytes),0) FROM work_write_stage_meter) stages`)
  if (!external || !Number.isSafeInteger(external.commands) || external.commands < 0 || external.commands > WorkCommandSchema.MAX_CUSTODY_BYTES ||
    !Number.isSafeInteger(external.stages) || external.stages < 0 || external.stages > WorkWriteStageSchema.MAX_RETAINED_BYTES)
    return yield* failure("EVENT_DAG_CAPACITY")
  const value = yield* tx.get<{ n: number; baseline_bytes: number; retained_bytes: number }>(sql`SELECT count(*) n,
    (SELECT coalesce(sum(CASE WHEN state IN ('succeeded','failed') AND json_extract(record,'$.baseline.state')='sealed'
      AND json_type(record,'$.baseline.settledRetentionAt')='integer' AND json_type(record,'$.baseline.allocatedBytes')='integer'
      AND json_extract(record,'$.baseline.allocatedBytes') BETWEEN 0 AND ${EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES}
      THEN json_extract(record,'$.baseline.allocatedBytes') ELSE ${EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES} END),0)
      FROM event_work_controller WHERE json_type(record,'$.baseline')='object') baseline_bytes,
    (SELECT coalesce(sum(CASE WHEN json_extract(a.record,'$.artifactCustody.cleanup.state')='collected'
      AND json_type(a.record,'$.artifactCustody.worktreeAllocatedBytes')='integer'
      AND json_type(a.record,'$.artifactCustody.gitAllocatedBytes')='integer'
      AND json_type(a.record,'$.artifactCustody.indexAllocatedBytes')='integer'
      AND json_extract(a.record,'$.artifactCustody.worktreeAllocatedBytes')>=0
      AND json_extract(a.record,'$.artifactCustody.gitAllocatedBytes')>=0
      AND json_extract(a.record,'$.artifactCustody.indexAllocatedBytes')>=0
      AND json_extract(a.record,'$.artifactCustody.worktreeAllocatedBytes')+json_extract(a.record,'$.artifactCustody.gitAllocatedBytes')+
        json_extract(a.record,'$.artifactCustody.indexAllocatedBytes')<=${EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES}
      THEN json_extract(a.record,'$.artifactCustody.worktreeAllocatedBytes')+json_extract(a.record,'$.artifactCustody.gitAllocatedBytes')+
        json_extract(a.record,'$.artifactCustody.indexAllocatedBytes') ELSE ${EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES} END),0)
      FROM event_task_workspace w JOIN event_work_receipt r ON r.event_id=w.event_id
      JOIN event_work_controller c ON c.receipt_id=r.receipt_id
      JOIN event_work_node_authority a ON a.receipt_id=r.receipt_id AND a.node_id=w.task_id
      WHERE w.generation=0 AND w.state='reclaimed') retained_bytes FROM (
    SELECT w.event_id,w.task_id FROM event_task_workspace w
      JOIN event_work_receipt r ON r.event_id=w.event_id JOIN event_work_controller c ON c.receipt_id=r.receipt_id
      WHERE w.generation=0 AND w.state<>'reclaimed'
    UNION
    SELECT r.event_id,json_extract(c.record,'$.activeNodeID') FROM event_work_controller c
      JOIN event_work_receipt r ON r.receipt_id=c.receipt_id
      WHERE json_extract(c.record,'$.activeNodeID') IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(c.record,'$.plan.nodes') n WHERE json_extract(n.value,'$.requiresWriteIsolation')=1)
  )`)
  if (!value || !Number.isSafeInteger(value.n) || value.n < 0 || value.n > EventWorkPlacement.MAX_WORKSPACES ||
    !Number.isSafeInteger(value.baseline_bytes) || value.baseline_bytes < 0 || !Number.isSafeInteger(value.retained_bytes) || value.retained_bytes < 0 ||
    value.n * EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES + value.baseline_bytes + value.retained_bytes +
      WorkCommandSchema.MAX_CUSTODY_BYTES + WorkWriteStageSchema.MAX_RETAINED_BYTES > EventWorkPlacement.MAX_CUSTODY_BYTES)
    return yield* failure("EVENT_DAG_CAPACITY")
  return { workspaces: value.n, reservedBytes: value.n * EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES + value.baseline_bytes + value.retained_bytes }
})

/** Data plus an actual installation observation are both necessary. Neither JSON nor a
 * registered directory alone supplies the current child authorization. No I/O occurs here. */
export const requirePlacementCustody = Effect.fn("EventWorkNodeAuthority.requirePlacementCustody")(function* (tx: Tx,
  authority: EventWorkDagSchema.Authority) {
  if (!authority.placement) return yield* failure("EVENT_DAG_UNAVAILABLE")
  const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
  const direct = yield* EventWorkPlacement.Current
  const witness = Option.isSome(service) ? direct ?? service.value.forWork(authority.childWorkID) : undefined
  if (Option.isNone(service) || !witness) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* service.value.current(witness)
  const description = service.value.describe(witness)
  if (!description || hash(description) !== hash(authority.placement) || description.expiresAt <= Date.now() ||
    description.observedAt > Date.now() || description.controllerID !== authority.controllerID ||
    description.receiptID !== authority.receiptID || description.eventID !== (yield* EventWorkController.get(tx, authority.controllerID))?.receipt.eventID ||
    description.nodeID !== authority.nodeID || description.rootWorkID !== authority.rootWorkID ||
    description.childWorkID !== authority.childWorkID || description.childSessionID !== authority.childSessionID ||
    description.childInputID !== authority.childInputID || description.rootBindingHash !== authority.rootBindingHash ||
    description.planHash !== authority.planHash || description.rootRevision !== authority.rootRevision ||
    description.workspace.operationKey !== `${description.eventID}:${authority.nodeID}` ||
    description.workspace.repositoryRoot !== authority.rootBinding.location.directory ||
    description.projectID !== authority.rootBinding.projectScope.projectID ||
    description.namespaceBindingHash !== authority.rootBinding.projectScope.namespaceBindingHash ||
    description.helperHash !== authority.rootBinding.projectScope.helperHash ||
    hash(description.parentRootIdentity) !== hash(authority.rootBinding.projectScope.rootIdentity) ||
    description.childConfiguredTargetStamp !== description.configuredTargetStamp ||
    description.expiresAt > authority.expiresAt ||
    authority.childBinding.location.directory !== description.workspace.directory ||
    authority.childBinding.projectScope.locationKey !== description.locationKey ||
    hash(authority.childBinding.projectScope.rootIdentity) !== hash(description.childRootIdentity))
    return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  const row = yield* tx.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, description.eventID),
    eq(EventTaskWorkspaceTable.task_id, authority.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
  if (!row || row.error !== null || row.state !== "ready" && row.state !== "retained" || workspaceIdentityHash(row) !== description.workspace.immutableRowHash ||
    row.directory !== description.workspace.directory || row.repository_root !== description.workspace.repositoryRoot ||
    row.base_commit !== description.workspace.baseCommit || row.branch !== description.workspace.branch)
    return yield* failure("EVENT_DAG_CONFLICT")
  const controller = yield* EventWorkController.get(tx, authority.controllerID)
  if (!controller?.controller.baseline || controller.controller.baseline.state !== "sealed" ||
    controller.controller.baseline.commit !== description.workspace.baseCommit ||
    controller.controller.baseline.scopeHash !== hash(authority.rootBinding.toolPolicy.fileScope) ||
    controller.controller.baseline.sourceHash !== controller.receipt.authorityHash)
    return yield* failure("EVENT_DAG_CONFLICT")
  const identity = yield* tx.select({ namespace: SecurityNamespaceTable, project: ProjectScopeIdentityTable, location: LocationIdentityTable })
    .from(LocationIdentityTable).innerJoin(SecurityNamespaceTable, eq(SecurityNamespaceTable.id, LocationIdentityTable.security_namespace_id))
    .innerJoin(ProjectScopeIdentityTable, and(eq(ProjectScopeIdentityTable.security_namespace_id, LocationIdentityTable.security_namespace_id),
      eq(ProjectScopeIdentityTable.project_scope_key, LocationIdentityTable.project_scope_key)))
    .where(and(eq(LocationIdentityTable.security_namespace_id, authority.rootBinding.scope.securityNamespaceID),
      eq(LocationIdentityTable.location_key, description.locationKey))).get()
  if (!identity || identity.namespace.kind !== "implicit_local" || identity.namespace.binding_hash !== description.namespaceBindingHash ||
    identity.namespace.retired_at !== null || identity.project.retired_at !== null || identity.location.retired_at !== null ||
    identity.location.workspace_binding !== null || identity.location.canonical_root !== row.directory ||
    identity.location.project_scope_key !== authority.rootBinding.scope.projectScopeKey ||
    identity.location.observed_project_id !== description.projectID || identity.project.observed_project_id !== description.projectID)
    return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  yield* service.value.current(witness)
  return description
})

/** Explicit cold observation of the original physical placement, never a new preparation or
 * grant. restore must refuse unknown/missing worktrees rather than recreating their contents. */
export const preparePlacement = Effect.fn("EventWorkNodeAuthority.preparePlacement")(function* (db: Db, input: { workID: string }) {
  const authority = yield* get(db, input.workID)
  if (!authority?.placement) return
  const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
  if (Option.isNone(service)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  const prior = service.value.forWork(input.workID)
  if (prior) {
    yield* service.value.current(prior)
    if (hash(service.value.describe(prior)) !== hash(authority.placement)) return yield* failure("EVENT_DAG_SOURCE_CHANGED")
    return prior
  }
  const value = yield* service.value.restore(authority.placement)
  yield* service.value.current(value)
  if (hash(service.value.describe(value)) !== hash(authority.placement)) return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  return value
})

/** The first immediate CAS precedes all Git/Native preparation and gives it durable custody.
 * Predicates are rechecked after historical proof authentication outside the SQL transaction. */
export const readPreparation = Effect.fn("EventWorkNodeAuthority.readPreparation")(function* (db: Db,
  input: { controllerID: string; nodeID: string; expectedRevision: number }) {
  const before = yield* EventWorkController.current(db, { controllerID: input.controllerID })
  const selected = before.controller.plan.nodes.find((node) => node.id === input.nodeID)
  if (!selected) return yield* failure()
  for (const dependency of selected.dependencies)
    yield* EventWorkResult.prepareTerminal(db, EventWorkDagPolicy.identities(before.controller.receiptID, dependency).workID!)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const value = yield* EventWorkController.currentInTransaction(tx, { controllerID: input.controllerID })
    if (value.controller.activeNodeID !== null && value.controller.activeNodeID !== input.nodeID ||
      value.controller.revision !== input.expectedRevision) return yield* failure("EVENT_DAG_NOT_READY")
    const node = value.controller.plan.nodes.find((item) => item.id === input.nodeID)
    const rootWork = yield* WorkAuthority.get(tx, value.controller.rootWorkID)
    if (!node || !rootWork || rootWork.admission_state !== "ready" || rootWork.binding.schemaVersion !== "work-execution.v2")
      return yield* failure("EVENT_DAG_NOT_READY")
    const predecessors: { terminal: EventWorkDagSchema.Terminal; text: string }[] = []
    for (const dependency of node.dependencies) {
      const original = yield* get(tx, EventWorkDagPolicy.identities(value.controller.receiptID, dependency).workID!)
      if (!original?.terminal || original.controllerID !== value.controller.controllerID) return yield* failure("EVENT_DAG_NOT_READY")
      const result = yield* EventWorkResult.readTerminal(tx, original.childWorkID)
      if (result.terminal.outcome !== "succeeded") return yield* failure("EVENT_DAG_NOT_READY")
      predecessors.push(result)
    }
    const controller = value.controller.activeNodeID === node.id ? value.controller :
      { ...value.controller, revision: value.controller.revision + 1, state: "running" as const, activeNodeID: node.id }
    if (controller !== value.controller) yield* EventWorkController.updateInTransaction(tx, value.controller, controller)
    yield* requireWorkspaceCapacity(tx)
    yield* EventWorkController.currentInTransaction(tx, { controllerID: controller.controllerID })
    return { ...value, controller, rootWork, node, identities: EventWorkDagPolicy.identities(controller.receiptID, node.id), predecessors }
  }), { behavior: "immediate" })
})

/** Data-only historical lookup. The current source gate is deliberately a separate operation. */
export const get = Effect.fn("EventWorkNodeAuthority.get")(function* (tx: Pick<Tx, "select">, workID: string) {
  const row = yield* tx.select().from(EventWorkNodeAuthorityTable).where(eq(EventWorkNodeAuthorityTable.work_id, workID)).get()
  if (!row) return undefined
  const record = yield* EventWorkSource.decode(Schema.fromJsonString(EventWorkDagSchema.Authority), row.record)
  const ids = EventWorkDagPolicy.identities(record.receiptID, record.nodeID)
  if (record.authorityID !== ids.authorityID || record.childWorkID !== ids.workID || record.childSessionID !== ids.sessionID ||
    record.childInputID !== ids.inputID || record.childWorkID !== row.work_id || record.authorityID !== row.authority_id ||
    record.receiptID !== row.receipt_id || record.nodeID !== row.node_id || hash(record) !== row.record_hash ||
    row.record_bytes !== Buffer.byteLength(row.record, "utf8") || hash(record.rootBinding) !== record.rootBindingHash ||
    hash(record.childBinding) !== record.childBindingHash || (row.state === "terminal") !== (record.terminal !== undefined)) return yield* failure()
  return record
})

/** Accounting consumes an installation-owned held observation. The stored artifact cannot
 * mint a provider/tool witness and does not depend on an elapsed dispatch TTL. */
export const sealArtifact = Effect.fn("EventWorkNodeAuthority.sealArtifact")(function* (tx: Tx,
  input: { workID: string; witness: EventWorkPlacement.Witness }) {
  const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
  if (Option.isNone(service)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* service.value.accountingCurrent(input.witness)
  const placement = service.value.describe(input.witness)
  const artifact = service.value.artifact(input.witness)
  const authority = yield* get(tx, input.workID)
  const work = yield* WorkAuthority.get(tx, input.workID)
  if (!placement || !artifact || !authority?.placement || !work || placement.childWorkID !== input.workID ||
    hash(placement) !== hash(authority.placement) || work.binding_hash !== authority.childBindingHash ||
    work.outcome !== "succeeded" && work.outcome !== "failed" || artifact.sealedAt > Date.now()) return yield* failure("EVENT_DAG_CONFLICT")
  yield* EventWorkResult.requireKnownExecution(tx, input.workID)
  const parsed = yield* EventWorkSource.decode(EventWorkDagSchema.ArtifactCustody, artifact)
  const row = yield* tx.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, placement.eventID),
    eq(EventTaskWorkspaceTable.task_id, authority.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
  if (!row || row.error !== null || row.state !== "ready" && row.state !== "retained" ||
    workspaceIdentityHash(row) !== placement.workspace.immutableRowHash || row.state === "retained" && row.continuation_ref !== parsed.commit)
    return yield* failure("EVENT_DAG_CONFLICT")
  if (authority.artifactCustody) {
    if (hash(authority.artifactCustody) !== hash(parsed)) return yield* failure("EVENT_DAG_CONFLICT")
    return authority
  }
  if (authority.terminal) return yield* failure("EVENT_DAG_CONFLICT")
  const next = { ...authority, artifactCustody: parsed }
  const updated = yield* tx.update(EventWorkNodeAuthorityTable).set({ record: CanonicalJson.stringify(next), record_hash: hash(next),
    record_bytes: Buffer.byteLength(CanonicalJson.stringify(next), "utf8") }).where(and(
      eq(EventWorkNodeAuthorityTable.authority_id, authority.authorityID), eq(EventWorkNodeAuthorityTable.record_hash, hash(authority))))
    .returning().get()
  if (!updated) return yield* failure("EVENT_DAG_CONFLICT")
  yield* service.value.accountingCurrent(input.witness)
  yield* EventWorkRule.requireCapacity(tx, true)
  return next
})

/** The original installation has re-observed the already published immutable ref. This
 * clears only a lost workspace-accounting receipt, never an unknown provider/tool effect. */
export const reconcileArtifact = Effect.fn("EventWorkNodeAuthority.reconcileArtifact")(function* (tx: Tx,
  input: { workID: string; witness: EventWorkPlacement.Witness }) {
  const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
  if (Option.isNone(service)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* service.value.accountingCurrent(input.witness)
  const authority = yield* get(tx, input.workID)
  const placement = service.value.describe(input.witness)
  const artifact = service.value.artifact(input.witness)
  if (!authority?.placement || !authority.artifactCustody || !placement || !artifact || placement.childWorkID !== input.workID ||
    hash(placement) !== hash(authority.placement) || hash(artifact) !== hash(authority.artifactCustody)) return yield* failure("EVENT_DAG_CONFLICT")
  yield* EventWorkResult.requireKnownExecution(tx, input.workID)
  const row = yield* tx.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, placement.eventID),
    eq(EventTaskWorkspaceTable.task_id, authority.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
  if (!row || workspaceIdentityHash(row) !== placement.workspace.immutableRowHash || row.state !== "ready" && row.state !== "retained" &&
    !(row.state === "reclaimed" && artifact.cleanup?.state === "collected") ||
    row.error !== null && row.error !== "formal_physical_unknown" || row.state !== "ready" && row.continuation_ref !== artifact.commit)
    return yield* failure("EVENT_DAG_CONFLICT")
  if ((row.state === "retained" || row.state === "reclaimed") && row.error === null) return
  const changed = yield* tx.update(EventTaskWorkspaceTable).set({ state: "retained", error: null,
    continuation_ref: artifact.commit, time_settled: artifact.sealedAt }).where(and(
      eq(EventTaskWorkspaceTable.event_id, placement.eventID), eq(EventTaskWorkspaceTable.task_id, authority.nodeID),
      eq(EventTaskWorkspaceTable.generation, 0), eq(EventTaskWorkspaceTable.state, row.state),
      sql`${EventTaskWorkspaceTable.error} IS ${row.error}`, sql`${EventTaskWorkspaceTable.continuation_ref} IS ${row.continuation_ref}`))
    .returning().get()
  if (!changed) return yield* failure("EVENT_DAG_CONFLICT")
  yield* service.value.accountingCurrent(input.witness)
})

/** Only the original known whole graph can collect a private view after its existing grace.
 * Preparing/unknown cleanup keeps the full obligation; no provider/tool debt is reconciled. */
export const transitionCleanup = Effect.fn("EventWorkNodeAuthority.transitionCleanup")(function* (tx: Tx,
  input: { workID: string; witness: EventWorkPlacement.Witness; action: "prepare" | "collected" | "unknown" }) {
  const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
  if (Option.isNone(service)) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* service.value.accountingCurrent(input.witness)
  const placement = service.value.describe(input.witness)
  const observed = service.value.artifact(input.witness)
  const authority = yield* get(tx, input.workID)
  const prior = authority?.artifactCustody
  if (!placement || !observed || !authority?.placement || !prior || !authority.terminal ||
    hash(placement) !== hash(authority.placement) || placement.childWorkID !== input.workID) return yield* failure("EVENT_DAG_CONFLICT")
  const controller = yield* EventWorkController.get(tx, authority.controllerID)
  const unsettled = yield* tx.get<{ n: number }>(sql`SELECT count(*) n FROM event_work_node_authority
    WHERE receipt_id=${authority.receiptID} AND state<>'terminal'`)
  const work = yield* WorkAuthority.get(tx, input.workID)
  if (!controller || controller.controller.activeNodeID !== null || !["succeeded","failed"].includes(controller.controller.state) ||
    !work || !["succeeded","failed"].includes(work.outcome) || unsettled?.n !== 0 ||
    authority.terminal.settledAt > Date.now() - TaskWorkspace.worktreeRetentionMs()) return yield* failure("EVENT_DAG_NOT_READY")
  yield* EventWorkResult.requireKnownExecution(tx, input.workID)
  const row = yield* tx.select().from(EventTaskWorkspaceTable).where(and(eq(EventTaskWorkspaceTable.event_id, placement.eventID),
    eq(EventTaskWorkspaceTable.task_id, authority.nodeID), eq(EventTaskWorkspaceTable.generation, 0))).get()
  if (!row || workspaceIdentityHash(row) !== placement.workspace.immutableRowHash || row.state !== "retained" ||
    row.error !== null || row.continuation_ref !== prior.commit) return yield* failure("EVENT_DAG_CONFLICT")
  const facts = (value: EventWorkDagSchema.ArtifactCustody) => ({ ...value, cleanup: undefined, worktreeAllocatedBytes: undefined })
  if (hash(facts(prior)) !== hash(facts(observed))) return yield* failure("EVENT_DAG_CONFLICT")
  if (input.action === "prepare" ? prior.cleanup !== undefined || hash(observed) !== hash(prior)
    : prior.cleanup?.state !== "preparing" || observed.cleanup?.startedAt !== prior.cleanup.startedAt) return yield* failure("EVENT_DAG_CONFLICT")
  const cleanup = input.action === "prepare" ? { state: "preparing" as const, startedAt: Date.now() }
    : input.action === "unknown" ? { ...prior.cleanup!, state: "unknown" as const }
    : { ...prior.cleanup!, state: "collected" as const, completedAt: Date.now() }
  const artifact = yield* EventWorkSource.decode(EventWorkDagSchema.ArtifactCustody, { ...observed, cleanup })
  if (input.action !== "collected" && artifact.worktreeAllocatedBytes !== prior.worktreeAllocatedBytes ||
    input.action === "collected" && artifact.worktreeAllocatedBytes > prior.worktreeAllocatedBytes) return yield* failure("EVENT_DAG_CONFLICT")
  const next = { ...authority, artifactCustody: artifact }
  const updated = yield* tx.update(EventWorkNodeAuthorityTable).set({ record: CanonicalJson.stringify(next), record_hash: hash(next),
    record_bytes: Buffer.byteLength(CanonicalJson.stringify(next), "utf8") }).where(and(eq(EventWorkNodeAuthorityTable.authority_id, authority.authorityID),
      eq(EventWorkNodeAuthorityTable.record_hash, hash(authority)))).returning().get()
  if (!updated) return yield* failure("EVENT_DAG_CONFLICT")
  if (input.action === "collected") {
    const reclaimed = yield* tx.update(EventTaskWorkspaceTable).set({ state: "reclaimed" }).where(and(
      eq(EventTaskWorkspaceTable.event_id, placement.eventID), eq(EventTaskWorkspaceTable.task_id, authority.nodeID),
      eq(EventTaskWorkspaceTable.generation, 0), eq(EventTaskWorkspaceTable.state, "retained"),
      sql`${EventTaskWorkspaceTable.error} IS NULL`, eq(EventTaskWorkspaceTable.continuation_ref, prior.commit))).returning().get()
    if (!reclaimed) return yield* failure("EVENT_DAG_CONFLICT")
    const baseline = controller.controller.baseline
    if (baseline?.state === "sealed" && baseline.allocatedBytes !== undefined && baseline.settledRetentionAt === undefined)
      yield* EventWorkController.updateInTransaction(tx, controller.controller, { ...controller.controller,
        revision: controller.controller.revision + 1, baseline: { ...baseline, settledRetentionAt: Date.now() } })
  }
  yield* service.value.accountingCurrent(input.witness)
  yield* EventWorkRule.requireCapacity(tx, true)
  return artifact
})

export const requireCurrent = Effect.fn("EventWorkNodeAuthority.requireCurrent")(function* (tx: Tx, child: WorkAuthority.Work) {
  const authority = yield* get(tx, child.work_id)
  if (!authority || authority.terminal || authority.expiresAt <= Date.now() || child.execution_role !== "agent" ||
    child.parent_work_id !== authority.rootWorkID || child.root_work_id !== authority.rootWorkID ||
    child.binding_hash !== authority.childBindingHash || hash(child.binding) !== child.binding_hash ||
    child.session_id !== authority.childSessionID || child.input_id !== authority.childInputID ||
    child.binding.source.authorityID !== authority.rootBinding.source.authorityID) return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  const value = yield* EventWorkController.currentInTransaction(tx, { controllerID: authority.controllerID })
  const root = yield* WorkAuthority.get(tx, authority.rootWorkID)
  const node = value.controller.plan.nodes.find((item) => item.id === authority.nodeID)
  if (!root || !node || value.controller.activeNodeID !== authority.nodeID || value.controller.planHash !== authority.planHash ||
    root.binding_hash !== authority.rootBindingHash || root.control_revision !== authority.rootRevision || root.admission_state !== "ready" ||
    child.source_record_hash !== root.source_record_hash || child.route_evidence_hash !== root.route_evidence_hash ||
    node.agentID !== child.agent_id || EventWorkDagPolicy.requiresPlacement(value.controller.plan, node) !== (authority.placement !== undefined)) return yield* failure("EVENT_DAG_SOURCE_CHANGED")
  const placement = authority.placement ? yield* requirePlacementCustody(tx, authority) : undefined
  const valid = WorkAuthorityPolicy.checkChild(root.binding, child.binding, placement ? { eventPlacement: placement } : undefined)
  if (!valid.ok) return yield* valid.error
  yield* WorkExecutionProfile.requirePlacement(tx, root)
  if (authority.predecessorRefs.length !== node.dependencies.length) return yield* failure()
  for (const [index, reference] of authority.predecessorRefs.entries()) {
    const observed = yield* EventWorkResult.readTerminal(tx, reference.workID)
    if (reference.nodeID !== node.dependencies[index] || reference.outcome !== "succeeded" || hash(reference) !== hash(observed.terminal))
      return yield* failure("EVENT_DAG_CONFLICT")
  }
  return { authorityID: root.authority_id, revision: root.source_revision, recordHash: root.source_record_hash }
})
export const current = (db: Db, input: { workID: string }) => db.transaction((tx) => Effect.gen(function* () {
  const work = yield* WorkAuthority.get(tx, input.workID)
  if (!work) return yield* failure("EVENT_DAG_UNAVAILABLE")
  yield* requireCurrent(tx, work)
  return work
}), { behavior: "immediate" })

/** The fixed operator graph, original result rows and active-root CAS derive the complete child.
 * Host scheduling IDs, generation, metadata and completion events cannot change this origin. */
export const reserve = (db: Db, input: { controllerID: string; nodeID: string; expectedRevision: number }) =>
  db.transaction((tx) => Effect.gen(function* () {
    const value = yield* EventWorkController.currentInTransaction(tx, { controllerID: input.controllerID })
    if (value.controller.activeNodeID !== null && value.controller.activeNodeID !== input.nodeID) return yield* failure("EVENT_DAG_NOT_READY")
    if (value.controller.revision !== input.expectedRevision) return yield* failure("EVENT_DAG_NOT_READY")
    const node = value.controller.plan.nodes.find((item) => item.id === input.nodeID)
    if (!node) return yield* failure()
    if (value.controller.activeNodeID !== null && value.controller.activeNodeID !== node.id) return yield* failure("EVENT_DAG_NOT_READY")
    const root = yield* WorkAuthority.get(tx, value.controller.rootWorkID)
    if (!root || root.admission_state !== "ready" || root.binding.schemaVersion !== "work-execution.v2") return yield* failure("EVENT_DAG_NOT_READY")
    const ids = EventWorkDagPolicy.identities(value.controller.receiptID, node.id)
    const prior = yield* get(tx, ids.workID!)
    if (prior) {
      const work = yield* WorkAuthority.get(tx, ids.workID!)
      if (!work || prior.controllerID !== value.controller.controllerID || prior.planHash !== value.controller.planHash) return yield* failure()
      yield* requireCurrent(tx, work)
      return { work, auditedText: prior.inputText, parentSessionID: prior.parentSessionID }
    }
    const predecessors: { terminal: EventWorkDagSchema.Terminal; text: string }[] = []
    for (const dependency of node.dependencies) {
      const original = yield* get(tx, EventWorkDagPolicy.identities(value.controller.receiptID, dependency).workID!)
      if (!original?.terminal || original.controllerID !== value.controller.controllerID) return yield* failure("EVENT_DAG_NOT_READY")
      predecessors.push(yield* EventWorkResult.readTerminal(tx, original.childWorkID))
    }
    const text = EventWorkDagPolicy.inputText(node, value.receipt.auditedText, predecessors)
    if (!text.ok) return yield* text.error
    const service = yield* Effect.serviceOption(EventWorkPlacement.Service)
    const direct = yield* EventWorkPlacement.Current
    const witness = Option.isSome(service) ? direct ?? service.value.forWork(ids.workID!) : undefined
    const isolated = EventWorkDagPolicy.requiresPlacement(value.controller.plan, node)
    const placement = isolated && witness && Option.isSome(service) ? service.value.describe(witness) : undefined
    if (isolated && (!placement || placement.controllerRevision !== value.controller.revision))
      return yield* failure("EVENT_DAG_UNAVAILABLE")
    if (placement && value.controller.activeNodeID !== node.id) return yield* failure("EVENT_DAG_NOT_READY")
    const childBinding = { ...root.binding, workID: ids.workID!, rootWorkID: root.work_id, parentWorkID: root.work_id,
      sessionID: ids.sessionID!, inputID: ids.inputID!, attemptKey: `attempt_evn_${ids.requestID!.slice(0, 40)}`,
      source: { ...root.binding.source, requestID: ids.requestID!, requestHash: hash([value.controller.planHash, node.id, text.hash]) },
      agentID: node.agentID, auditedText: { hash: text.hash, utf8Bytes: Buffer.byteLength(text.text, "utf8"), snapshotRef: `event-node:${ids.authorityID}` },
      toolPolicy: { ...root.binding.toolPolicy, capabilities: root.binding.toolPolicy.capabilities.filter((item) => node.toolIDs.includes(item.toolID)) },
      ...(placement ? { location: { directory: placement.workspace.directory }, projectScope: { ...root.binding.projectScope,
        locationKey: placement.locationKey, canonicalRoot: placement.workspace.directory, rootIdentity: placement.childRootIdentity } } : {}),
      childPolicy: "deny_all" as const, budget: node.budget }
    const valid = WorkAuthorityPolicy.validateBinding(childBinding)
    const subset = WorkAuthorityPolicy.checkChild(root.binding, childBinding, placement ? { eventPlacement: placement } : undefined)
    if (!valid.ok) return yield* valid.error
    if (!subset.ok) return yield* subset.error
    const conflict = yield* tx.select({ id: WorkExecutionTable.work_id }).from(WorkExecutionTable)
      .where(or(eq(WorkExecutionTable.work_id, childBinding.workID), eq(WorkExecutionTable.session_id, childBinding.sessionID),
        eq(WorkExecutionTable.input_id, childBinding.inputID))).get()
    const session = yield* tx.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(childBinding.sessionID))).get()
    const count = yield* tx.get<{ n: number }>(sql`SELECT count(*) n FROM work_execution WHERE parent_work_id=${root.work_id}`)
    const debt = yield* tx.select({ id: WorkDispatchReservationTable.reservation_id }).from(WorkDispatchReservationTable)
      .where(and(eq(WorkDispatchReservationTable.root_work_id, root.work_id), sql`${WorkDispatchReservationTable.state} IN ('unknown','dispatching')`)).get()
    if (conflict || session || !count || count.n >= root.binding.budget.maxChildren || debt) return yield* failure("EVENT_DAG_CONFLICT")
    const authority: EventWorkDagSchema.Authority = { version: 1, kind: "event_dag_node_v1", authorityID: ids.authorityID!,
      controllerID: value.controller.controllerID, receiptID: value.controller.receiptID, nodeID: node.id, planHash: value.controller.planHash,
      rootWorkID: root.work_id, parentWorkID: root.work_id, rootSessionID: root.session_id, parentSessionID: root.session_id,
      childWorkID: childBinding.workID, childSessionID: childBinding.sessionID, childInputID: childBinding.inputID,
      rootBinding: root.binding, rootBindingHash: root.binding_hash, rootRevision: root.control_revision,
      childBinding, childBindingHash: hash(childBinding), inputText: text.text, predecessorRefs: text.predecessorRefs,
      ...(placement ? { placement } : {}), createdAt: Date.now(), expiresAt: root.binding.deadline }
    if (placement) yield* requirePlacementCustody(tx, authority)
    yield* requireWorkspaceCapacity(tx)
    yield* tx.insert(EventWorkNodeAuthorityTable).values({ authority_id: authority.authorityID, receipt_id: authority.receiptID,
      node_id: authority.nodeID, work_id: authority.childWorkID, state: "pending", record: CanonicalJson.stringify(authority),
      record_hash: hash(authority), record_bytes: Buffer.byteLength(CanonicalJson.stringify(authority), "utf8") }).run()
    const work = yield* tx.insert(WorkExecutionTable).values({ ...root, execution_role: "agent", work_id: childBinding.workID,
      parent_work_id: root.work_id, session_id: childBinding.sessionID, input_id: childBinding.inputID, agent_id: node.agentID,
      authority_id: root.authority_id, source_request_id: childBinding.source.requestID, binding: childBinding,
      binding_hash: authority.childBindingHash, admission_state: "reserved", admitted_seq: null, control_revision: 1,
      control_receipts: [], outcome: "pending", created_at: authority.createdAt, updated_at: authority.createdAt }).returning().get()
    if (!work) return yield* failure()
    yield* EventWorkController.updateInTransaction(tx, value.controller, { ...value.controller, revision: value.controller.revision + 1,
      state: "running", activeNodeID: node.id })
    yield* EventWorkRule.requireCapacity(tx)
    yield* requireCurrent(tx, work)
    return { work, auditedText: text.text, parentSessionID: root.session_id }
  }), { behavior: "immediate" })

/** Original SessionInput ready-commit owns this transition. No caller may mark a node ready. */
export const bindReadyInTransaction = Effect.fn("EventWorkNodeAuthority.bindReadyInTransaction")(function* (tx: Tx, work: WorkAuthority.Work) {
  const authority = yield* get(tx, work.work_id)
  yield* requireCurrent(tx, work)
  const current = yield* WorkAuthority.get(tx, work.work_id)
  if (!authority || current?.admission_state !== "ready" || current.binding_hash !== authority.childBindingHash) return yield* failure()
  yield* tx.update(EventWorkNodeAuthorityTable).set({ state: "bound" }).where(and(
    eq(EventWorkNodeAuthorityTable.authority_id, authority.authorityID), eq(EventWorkNodeAuthorityTable.state, "pending"),
    eq(EventWorkNodeAuthorityTable.record_hash, hash(authority)))).run()
  yield* EventWorkRule.requireCapacity(tx)
})
