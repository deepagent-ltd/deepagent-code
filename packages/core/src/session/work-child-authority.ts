export * as WorkChildAuthority from "./work-child-authority"

import { and, desc, eq, sql } from "drizzle-orm"
import { ToolCall } from "@deepagent-code/llm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import type { Location } from "../location"
import type { Tool } from "../tool/tool"
import type { ToolRegistry } from "../tool/registry"
import { SessionActivityTable, SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { TaskRunAuthority } from "./task-run"
import { SessionInputTable, SessionMessageTable, SessionTable, SessionV2TaskCallAdmissionTable, TaskAdmissionTable, TaskRunTable } from "./sql"
import { WorkAuthority } from "./work-authority"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkAuthoritySchema } from "./work-authority.schema"
import { WorkExecutionProfile } from "./work-execution-profile"
import { WorkExecutionTable, WorkDispatchReservationTable } from "./work-authority.sql"
import { WorkChildAuthoritySchema } from "./work-child-authority.schema"
import { WorkChildAuthorityTable } from "./work-child-authority.sql"
import { WorkTaskKnownProof } from "./work-task-known-proof"
import { WorkTaskKnownProofSchema } from "./work-task-known-proof.schema"
import { WorkCountAcquisition } from "./work-count-acquisition"
import { WorkCountAcquisitionTable } from "./work-count-acquisition.sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"
import { V2TaskRunReceiptTable } from "./runner/v2-task-run-receipt.sql"
import type { V2ToolEffect } from "./runner/v2-tool-effect"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
const digest = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const denied = (code: WorkAuthoritySchema.ErrorCode = "WORK_RECOVERY_REQUIRED") =>
  new WorkAuthoritySchema.Error({ code, message: "Derived child authority is unavailable, changed or requires explicit recovery" })
type Entry = { active: boolean; binding: WorkAuthoritySchema.ProjectBinding; controlRevision: number;
  admission: V2ToolEffect.ToolEffectAdmission; context: Tool.Context; location: Location.Interface;
  materialization: ToolRegistry.Materialization; input: unknown; definitionHash: string; registrationGeneration: string;
  output?: { taskRunID: string; hash: string; consumed: boolean } }
const entries = new WeakMap<object, Entry>()
const Current = Context.Reference<object | undefined>("@deepagent-code/WorkChildAuthority/Current", { defaultValue: () => undefined })

/** Restricted runner-only scope. Neither JSON nor a Session parent relation can mint it. */
export function withAdmission<A, E, R>(input: Omit<Entry, "active" | "definitionHash" | "registrationGeneration" | "output">, body: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(Effect.gen(function* () {
    const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
    const { TaskTool } = yield* Effect.promise(() => import("../tool/task"))
    const registered = ToolRegistry.inspect(input.materialization, "task")
    const capability = input.binding.toolPolicy.capabilities.find((item) => item.toolID === "task")
    if (!registered || !TaskTool.isNativeTask(registered.tool) || input.admission.toolName !== "task" || input.admission.effectKind !== "mutating" ||
      input.binding.profile.id !== WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id ||
      input.binding.parentWorkID !== undefined || input.binding.childPolicy === "deny_all" ||
      input.binding.childPolicy.kind !== "shared_root_v1" || !capability?.operations.includes("delegate") ||
      capability.definitionHash !== digest(registered.definition)) return yield* denied("PROFILE_UNAVAILABLE")
    const handle = Object.freeze({})
    entries.set(handle, { ...input, output: undefined, active: true, definitionHash: digest(registered.definition), registrationGeneration: registered.generation })
    return handle
  }), (handle) => body.pipe(Effect.provideService(Current, handle)), (handle) => Effect.sync(() => {
    const entry = entries.get(handle)
    if (entry) entry.active = false
    entries.delete(handle)
  }))
}

/** Returns ordinary immediately. A restricted task must be fresh foreground/shared/direct. */
export const requireTaskMode = Effect.fn("WorkChildAuthority.requireTaskMode")(function* (db: Db, sessionID: string,
  input: { task_id?: string; background?: boolean; workspace: string; outputSchema?: unknown }) {
  const found = yield* WorkAuthority.lookupSession(db, sessionID)
  if (found.kind === "ordinary") return false
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (found.kind !== "bound" || !entry?.active || entry.binding.workID !== found.work.work_id ||
    input.task_id !== undefined || input.background === true || input.workspace !== "shared" || input.outputSchema !== undefined)
    return yield* denied("PROFILE_UNAVAILABLE")
  return true
})

/** Permission assertions use the same opaque native Task scope before and after approval. */
export const requireTaskCurrent = Effect.fn("WorkChildAuthority.requireTaskCurrent")(function* (db: Db, sessionID: string,
  input?: { action: string; resources: readonly string[] }): Effect.fn.Return<boolean, WorkAuthoritySchema.Error> {
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (!entry?.active) return false
  const call = Schema.decodeUnknownOption(Schema.Struct({ subagent_type: Schema.String }))(entry.input)
  if (!input || input.action !== "task" || input.resources.length !== 1 || Option.isNone(call) ||
    input.resources[0] !== call.value.subagent_type) return yield* denied()
  if (entry.context.sessionID !== sessionID || entry.context.agent !== entry.binding.agentID) return yield* denied()
  const work = yield* WorkAuthority.get(db, entry.binding.workID)
  if (!work) return yield* denied()
  yield* WorkExecutionProfile.prepareSource(work, { fresh: true })
  yield* db.transaction((tx) => Effect.gen(function* () {
    const current = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: entry.binding.workID, expectedRevision: entry.controlRevision })
    if (!entry.active || current.binding_hash !== digest(entry.binding)) return yield* denied()
    yield* WorkExecutionProfile.requirePlacement(tx, current)
    const original = yield* parentEvidence(tx, { admissionID: entry.admission.admissionId, parentSessionID: sessionID,
      parentMessageID: entry.context.assistantMessageID, toolCallID: entry.context.toolCallID, toolInputHash: digest(entry.input) }, false)
    if (!matchesSession(original.session, entry.binding)) return yield* denied()
    const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
    const { TaskTool } = yield* Effect.promise(() => import("../tool/task"))
    const registered = ToolRegistry.inspect(entry.materialization, "task")
    if (!registered || !TaskTool.isNativeTask(registered.tool) || registered.generation !== entry.registrationGeneration ||
      digest(registered.definition) !== entry.definitionHash) return yield* denied()
  }), { behavior: "immediate" }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
  return true
})

/** Only the original native task frame may resume its exact currently claimed child. */
export const requireTaskResume = Effect.fn("WorkChildAuthority.requireTaskResume")(function* (db: Db, input: {
  readonly sessionID: SessionSchema.ID; readonly runID: string; readonly ownerToken: string; readonly claimGeneration: number
}): Effect.fn.Return<void, WorkAuthoritySchema.Error> {
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (!entry?.active) return yield* denied()
  const found = yield* WorkAuthority.lookupSession(db, input.sessionID)
  if (found.kind !== "bound" || !found.work.parent_work_id || found.work.outcome !== "pending") return yield* denied()
  const grant = yield* get(db, found.work.work_id).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die))
  if (!grant || grant.taskRunID !== input.runID || grant.admissionID !== entry.admission.admissionId ||
    grant.parentWorkID !== entry.binding.workID || grant.childSessionID !== input.sessionID) return yield* denied()
  if (!(yield* requireTaskCurrent(db, grant.parentSessionID, { action: "task", resources: [found.work.agent_id] })))
    return yield* denied()
  yield* WorkExecutionProfile.prepareSource(found.work, { fresh: true })
  yield* db.transaction((tx) => Effect.gen(function* () {
    const child = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: grant.childWorkID, expectedRevision: 1 })
    yield* requireCurrent(tx, child)
    const run = yield* tx.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, input.runID)).get()
    const admitted = yield* tx.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make(grant.childInputID))).get()
    if (!entry.active || !run || run.state !== "running" || run.execution_runtime !== "v2" || run.input_state !== "ready" ||
      run.execution_owner !== input.ownerToken || run.claim_generation !== input.claimGeneration || !run.lease_expires_at ||
      run.lease_expires_at <= Date.now() || run.child_session_id !== input.sessionID || child.admission_state !== "ready" ||
      !admitted || admitted.session_id !== input.sessionID || admitted.delivery !== "queue") return yield* denied()
  }), { behavior: "immediate" }).pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
})

/** The original native Task executor supplies a one-use witness, never caller JSON. */
export const captureTaskOutput = Effect.fn("WorkChildAuthority.captureTaskOutput")(function* (db: Db, witness: object) {
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  const { TaskTool } = yield* Effect.promise(() => import("../tool/task"))
  const observed = TaskTool.takeCompletedOutput(witness)
  const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
  const registered = entry && ToolRegistry.inspect(entry.materialization, "task")
  if (!entry?.active || entry.output || !observed || !registered || observed.tool !== registered.tool ||
    !TaskTool.isNativeTask(registered.tool) || registered.generation !== entry.registrationGeneration ||
    digest(registered.definition) !== entry.definitionHash || observed.inputHash !== digest(entry.input) ||
    observed.context.sessionID !== entry.context.sessionID || observed.context.assistantMessageID !== entry.context.assistantMessageID ||
    observed.context.toolCallID !== entry.context.toolCallID || observed.context.agent !== entry.context.agent) return yield* denied()
  yield* prepareTerminal(db, entry.admission.admissionId)
  const work = yield* WorkAuthority.get(db, entry.binding.workID)
  if (!work || work.binding_hash !== digest(entry.binding)) return yield* denied()
  yield* WorkExecutionProfile.prepareSource(work, { fresh: true })
  yield* db.transaction((tx) => Effect.gen(function* () {
    const parent = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
      workID: entry.binding.workID, expectedRevision: entry.controlRevision,
    })
    const record = yield* requireTerminal(tx, parent, { admissionID: entry.admission.admissionId, inputHash: observed.inputHash })
    const child = yield* WorkAuthority.get(tx, record.childWorkID)
    if (!entry.active || record.taskRunID !== observed.runID || child?.outcome !== "succeeded") return yield* denied()
  }), { behavior: "immediate" })
  entry.output = { taskRunID: observed.runID, hash: observed.outcomeHash, consumed: false }
})

const settlements = new WeakMap<object, { entry: Entry; output: NonNullable<Entry["output"]> }>()
/** Original effect insertion consumes the exact sealed Task output after its commit succeeds. */
export const requireTaskSettlement = Effect.fn("WorkChildAuthority.requireTaskSettlement")(function* (tx: Tx,
  input: { admissionID: string; sessionID: string; receiptID: string; attemptID: string; toolCallID: string; ownerToken: string; outcomeHash: string }) {
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  const { ToolRegistry } = yield* Effect.promise(() => import("../tool/registry"))
  const { TaskTool } = yield* Effect.promise(() => import("../tool/task"))
  const registered = entry && ToolRegistry.inspect(entry.materialization, "task")
  if (!entry?.active || !entry.output || entry.output.consumed || entry.output.hash !== input.outcomeHash ||
    entry.admission.admissionId !== input.admissionID || entry.admission.sessionId !== input.sessionID ||
    entry.admission.receiptId !== input.receiptID || entry.admission.providerAttemptId !== input.attemptID ||
    entry.admission.toolCallId !== input.toolCallID || entry.admission.ownerToken !== input.ownerToken ||
    !registered || !TaskTool.isNativeTask(registered.tool) || registered.generation !== entry.registrationGeneration ||
    digest(registered.definition) !== entry.definitionHash) return yield* denied()
  const parent = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
    workID: entry.binding.workID, expectedRevision: entry.controlRevision,
  })
  if (parent.binding_hash !== digest(entry.binding)) return yield* denied()
  yield* WorkExecutionProfile.requirePlacement(tx, parent)
  const original = yield* parentEvidence(tx, { admissionID: entry.admission.admissionId,
    parentSessionID: entry.context.sessionID, parentMessageID: entry.context.assistantMessageID,
    toolCallID: entry.context.toolCallID, toolInputHash: digest(entry.input) })
  if (!matchesSession(original.session, entry.binding)) return yield* denied()
  const record = yield* requireTerminal(tx, parent, { admissionID: entry.admission.admissionId, inputHash: digest(entry.input) })
  const child = yield* WorkAuthority.get(tx, record.childWorkID)
  if (record.taskRunID !== entry.output.taskRunID || child?.outcome !== "succeeded") return yield* denied()
  const token = Object.freeze({}) as WorkTaskKnownProof.Settlement
  settlements.set(token, { entry, output: entry.output })
  return token
})

export function consumeTaskSettlement(token: object) {
  const value = settlements.get(token)
  settlements.delete(token)
  if (value?.entry.active && value.entry.output === value.output) value.output.consumed = true
}

/** Runs inside TaskRun's original IMMEDIATE admission transaction, before any child side effect. */
export const deriveInTransaction = Effect.fn("WorkChildAuthority.deriveInTransaction")(function* (tx: Tx, spec: TaskRunAuthority.SubmitSpec,
  identity: { runID: string; childSessionID: string; childInputID: string }) {
  const found = yield* WorkAuthority.lookupSession(tx, spec.parentSessionID)
  if (found.kind === "ordinary") return undefined
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  const offered = entry && Schema.decodeUnknownOption(Schema.Struct({ prompt: Schema.String, subagent_type: Schema.String,
    task_id: Schema.optional(Schema.String), background: Schema.optional(Schema.Boolean), output_schema: Schema.optional(Schema.Unknown) }))(entry.input)
  if (found.kind !== "bound" || !entry?.active || entry.binding.workID !== found.work.work_id ||
    !offered || Option.isNone(offered) || offered.value.prompt !== spec.prompt.text || offered.value.subagent_type !== spec.agent ||
    offered.value.task_id !== undefined || offered.value.background === true || offered.value.output_schema !== undefined ||
    entry.context.agent !== entry.binding.agentID || entry.context.sessionID !== entry.binding.sessionID ||
    entry.context.sessionID !== spec.parentSessionID || entry.context.assistantMessageID !== spec.parentMessageID ||
    entry.context.toolCallID !== spec.toolCallID || spec.deliveryMode !== "foreground" || spec.outputSchema !== undefined ||
    spec.child.workspace !== undefined || spec.prompt.metadata !== undefined || spec.child.location.directory !== entry.location.directory ||
    spec.child.location.workspaceID !== entry.location.workspaceID) return yield* denied("PROFILE_UNAVAILABLE")
  const parent = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: found.work.work_id, expectedRevision: entry.controlRevision })
  if (parent.binding.schemaVersion !== "work-execution.v2" || parent.binding_hash !== digest(entry.binding) ||
    parent.outcome !== "pending" || parent.parent_work_id !== null || parent.root_work_id !== parent.work_id ||
    parent.binding.childPolicy === "deny_all" || parent.binding.childPolicy.kind !== "shared_root_v1" ||
    !parent.binding.childPolicy.agents.includes(spec.agent)) return yield* denied("WORK_REVOKED")
  yield* WorkExecutionProfile.requirePlacement(tx, parent)
  const original = yield* parentEvidence(tx, { admissionID: entry.admission.admissionId, parentSessionID: spec.parentSessionID,
    parentMessageID: spec.parentMessageID, toolCallID: spec.toolCallID, toolInputHash: digest(entry.input) })
  if (original.admission.receipt_id !== entry.admission.receiptId || original.admission.provider_attempt_id !== entry.admission.providerAttemptId ||
    original.admission.owner_token !== entry.admission.ownerToken || original.session.directory !== entry.location.directory ||
    original.session.project_id !== entry.location.project.id || original.session.workspace_id !== (entry.location.workspaceID ?? null) ||
    !matchesSession(original.session, parent.binding)) return yield* denied()
  const terminal = yield* tx.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
    .where(and(eq(V2ToolEffectTable.receipt_id, entry.admission.receiptId), eq(V2ToolEffectTable.tool_call_id, spec.toolCallID))).get()
  if (terminal) return yield* denied()
  const [children] = yield* tx.all<{ count: number; active: number }>(sql`SELECT count(*) count,
    coalesce(sum(CASE WHEN outcome IN ('pending','unknown') THEN 1 ELSE 0 END),0) active FROM work_execution
    WHERE root_work_id=${parent.root_work_id} AND parent_work_id IS NOT NULL`)
  if (!children || children.count >= parent.binding.budget.maxChildren || children.active >= parent.binding.childPolicy.maxConcurrent)
    return yield* denied("WORK_BUDGET_EXHAUSTED")
  const childWorkID = `wch_${digest([parent.work_id, identity.childSessionID, entry.admission.admissionId])}`
  const binding = { ...parent.binding, workID: childWorkID, rootWorkID: parent.root_work_id, parentWorkID: parent.work_id,
    attemptKey: `child_${digest([parent.binding.attemptKey, identity.runID])}`,
    source: { ...parent.binding.source, requestID: `child_${digest([parent.binding.source.requestID, identity.childInputID])}` },
    envelopeHash: digest([parent.binding.envelopeHash, digest(entry.input)]), sessionID: identity.childSessionID, inputID: identity.childInputID,
    agentID: spec.agent, auditedText: { hash: Hash.sha256(spec.prompt.text), utf8Bytes: Buffer.byteLength(spec.prompt.text),
      snapshotRef: `child://${identity.runID}` }, childPolicy: "deny_all" as const,
    toolPolicy: { ...parent.binding.toolPolicy, capabilities: parent.binding.toolPolicy.capabilities.filter((item) =>
      parent.binding.schemaVersion === "work-execution.v2" && parent.binding.childPolicy !== "deny_all" &&
      parent.binding.childPolicy.kind === "shared_root_v1" && parent.binding.childPolicy.toolIDs.includes(item.toolID)) },
    budget: parent.binding.childPolicy.budget,
    deadline: Math.min(parent.binding.deadline, Date.now() + parent.binding.childPolicy.budget.maxDurationMs),
  } satisfies WorkAuthoritySchema.ProjectBinding
  const valid = WorkAuthorityPolicy.validateBinding(binding, { allowLoopbackHTTP: parent.loopback_http })
  const child = WorkAuthorityPolicy.checkChild(parent.binding, binding)
  if (!valid.ok) return yield* valid.error
  if (!child.ok) return yield* child.error
  const record = { version: 1, childWorkID, rootWorkID: parent.root_work_id, parentWorkID: parent.work_id, taskRunID: identity.runID,
    childSessionID: identity.childSessionID, childInputID: identity.childInputID, childBindingHash: digest(binding),
    parentBinding: parent.binding, rootBinding: parent.binding, parentBindingHash: parent.binding_hash, rootBindingHash: parent.binding_hash,
    parentRevision: parent.control_revision, rootRevision: parent.control_revision, parentSessionID: spec.parentSessionID,
    parentMessageID: spec.parentMessageID, toolCallID: spec.toolCallID, admissionID: entry.admission.admissionId,
    receiptID: original.receipt.receipt_id, attemptID: original.attempt.attempt_id, ownerToken: original.owner.owner_token,
    sessionClaimToken: original.session.execution_claim_token!, activityID: original.activity.activity_id,
    activityOrdinal: original.activity.ordinal, triggerInputID: original.activity.trigger_input_id,
    expectedInputSeq: original.latest.admitted_seq, toolInputHash: digest(entry.input), definitionHash: entry.definitionHash,
    registrationGeneration: entry.registrationGeneration, expiresAt: binding.deadline, createdAt: Date.now(),
  } satisfies WorkChildAuthoritySchema.Record
  yield* tx.insert(WorkExecutionTable).values({ ...parent, work_id: childWorkID, root_work_id: parent.root_work_id,
    parent_work_id: parent.work_id, session_id: binding.sessionID, input_id: binding.inputID, agent_id: binding.agentID,
    source_request_id: binding.source.requestID, binding, binding_hash: digest(binding), admission_state: "reserved",
    outcome: "pending", control_revision: 1, control_receipts: [], admitted_seq: null, created_at: record.createdAt, updated_at: record.createdAt }).run()
  yield* tx.insert(WorkChildAuthorityTable).values({ child_work_id: childWorkID, root_work_id: record.rootWorkID,
    parent_work_id: record.parentWorkID, task_run_id: record.taskRunID, admission_id: record.admissionID,
    child_session_id: record.childSessionID, child_input_id: record.childInputID, child_binding_hash: record.childBindingHash,
    parent_binding_hash: record.parentBindingHash, root_binding_hash: record.rootBindingHash, parent_revision: record.parentRevision,
    root_revision: record.rootRevision, record, record_hash: digest(record), expires_at: record.expiresAt, created_at: record.createdAt }).run()
  yield* WorkTaskKnownProof.reserve(tx, record)
  return record
})

/** Only the original settlement's WeakMap token can produce a first NativeTask proof.
 * The host signer calls this inside the same original ToolEffect INSERT transaction. */
export const inspectSettlementProof = Effect.fn("WorkChildAuthority.inspectSettlementProof")(function* (
  tx: Tx, token: WorkTaskKnownProof.Settlement, effectID: string, instanceID: string,
) {
  const sealed = settlements.get(token)
  const handle = yield* Current
  const entry = handle && entries.get(handle)
  if (!sealed || !entry?.active || sealed.entry !== entry || entry.output !== sealed.output || sealed.output.consumed ||
    !Schema.is(WorkTaskKnownProofSchema.Text)(effectID) || !Schema.is(WorkTaskKnownProofSchema.Text)(instanceID)) return yield* denied()
  const parent = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
    workID: entry.binding.workID, expectedRevision: entry.controlRevision,
  })
  const grant = yield* requireTerminal(tx, parent, { admissionID: entry.admission.admissionId, inputHash: digest(entry.input) })
  const child = yield* WorkAuthority.get(tx, grant.childWorkID)
  if (!child || child.outcome !== "succeeded" || child.binding.schemaVersion !== "work-execution.v2" ||
    child.binding.toolPolicy.capabilities.some((item) => item.toolID !== "read") || sealed.output.taskRunID !== grant.taskRunID)
    return yield* denied()
  const original = yield* parentEvidence(tx, grant)
  if (original.receipt.receipt_id !== entry.admission.receiptId || original.attempt.attempt_id !== entry.admission.providerAttemptId ||
    original.owner.owner_token !== entry.admission.ownerToken) return yield* denied()
  const evidence = yield* terminalEvidence(tx, child)
  const terminal = evidence.task.receipt
  const message = yield* tx.select().from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, SessionMessage.ID.make(evidence.task.run.raw_result_message_id!))).get()
  if (!message) return yield* denied()
  const providers = yield* terminalProviders(tx, child)
  const { WorkToolPolicy } = yield* Effect.promise(() => import("./work-tool-policy"))
  const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
  if (evidence.tools.length && Option.isNone(proof)) return yield* denied()
  const tools: Array<typeof WorkTaskKnownProofSchema.Tool.Type> = []
  for (const item of evidence.tools) {
    if (item.admission.tool_name !== "read" || item.admission.effect_kind !== "read_only" || !item.effect.known_read_proof ||
      Buffer.byteLength(item.effect.known_read_proof) > 16_384) return yield* denied()
    const known = Option.isSome(proof) ? yield* proof.value.requireVerified(item.effect.effect_id) : undefined
    if (!known || known.toolID !== "read" || known.workID !== child.work_id || known.bindingHash !== child.binding_hash ||
      known.admissionID !== item.admission.admission_id || known.outcomeHash !== item.effect.outcome_hash) return yield* denied()
    tools.push({ effectID: item.effect.effect_id, admissionID: item.admission.admission_id, receiptID: item.effect.receipt_id,
      attemptID: item.effect.provider_attempt_id, toolCallID: item.effect.tool_call_id, admissionHash: digest(item.admission),
      effectHash: digest(WorkTaskKnownProof.publicEffect(item.effect)), outcomeHash: item.effect.outcome_hash,
      proofHash: digest(item.effect.known_read_proof), controlRevision: known.controlRevision })
  }
  return { version: 2, proofID: `wtask_${digest([instanceID, grant.admissionID])}`, instanceID,
    rootWorkID: grant.rootWorkID, parentWorkID: parent.work_id, childWorkID: child.work_id,
    rootBindingHash: grant.rootBindingHash, parentBindingHash: parent.binding_hash, childBindingHash: child.binding_hash,
    grantHash: digest(grant), rootRevision: grant.rootRevision, parentRevision: parent.control_revision,
    childRevision: child.control_revision, parentSessionID: parent.session_id, parentInputID: parent.input_id,
    childSessionID: child.session_id, childInputID: child.input_id, admissionID: grant.admissionID, effectID,
    receiptID: grant.receiptID, attemptID: grant.attemptID, toolCallID: grant.toolCallID, ownerToken: grant.ownerToken,
    sessionClaimToken: grant.sessionClaimToken, activityID: grant.activityID, activityOrdinal: grant.activityOrdinal,
    triggerInputID: grant.triggerInputID, expectedInputSeq: grant.expectedInputSeq,
    inputHash: grant.toolInputHash, outcomeHash: sealed.output.hash, definitionHash: grant.definitionHash,
    registrationGeneration: grant.registrationGeneration, taskRunID: grant.taskRunID,
    taskGeneration: evidence.task.run.generation, taskRequestHash: evidence.task.run.request_hash,
    terminalReceiptID: terminal.receipt_id, terminalReceiptHash: digest(terminal),
    rawResultMessageID: message.id, rawResultMessageHash: digest(message),
    childResultHash: digest({ outcome: child.outcome, controlState: child.control_state, admittedSeq: child.admitted_seq }),
    childExpiresAt: grant.expiresAt, sourceRecordHash: child.source_record_hash, routeEvidenceHash: child.route_evidence_hash,
    providers, tools, createdAt: Date.now(),
  } satisfies WorkTaskKnownProofSchema.Record
})

/** Authenticated historical read only. An expired child is never made runnable; current
 * parent source/control still governs every recovery or continuation that consumes it. */
export const requireHistoricalTerminal = Effect.fn("WorkChildAuthority.requireHistoricalTerminal")(function* (
  tx: Tx, parent: WorkAuthority.Work, input: { admissionID: string; inputHash: string; outcomeHash: string },
) {
  const proof = yield* WorkTaskKnownProof.read(tx, input.admissionID)
  if (!proof || proof.parentWorkID !== parent.work_id || proof.rootWorkID !== parent.root_work_id ||
    proof.parentSessionID !== parent.session_id || proof.parentInputID !== parent.input_id ||
    proof.parentBindingHash !== parent.binding_hash || proof.rootBindingHash !== parent.binding_hash ||
    proof.parentRevision !== parent.control_revision || proof.rootRevision !== parent.control_revision ||
    proof.inputHash !== input.inputHash || proof.outcomeHash !== input.outcomeHash) return yield* denied()
  const current = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: parent.work_id, expectedRevision: parent.control_revision })
  if (current.binding_hash !== proof.parentBindingHash || current.outcome !== "pending" || current.parent_work_id !== null ||
    current.source_record_hash !== proof.sourceRecordHash || current.route_evidence_hash !== proof.routeEvidenceHash) return yield* denied()
  const child = yield* WorkAuthority.get(tx, proof.childWorkID)
  if (!child || child.binding_hash !== proof.childBindingHash || child.session_id !== proof.childSessionID || child.input_id !== proof.childInputID ||
    child.control_revision !== proof.childRevision || child.outcome !== "succeeded" || child.source_record_hash !== proof.sourceRecordHash ||
    child.route_evidence_hash !== proof.routeEvidenceHash || child.binding.schemaVersion !== "work-execution.v2" ||
    child.binding.childPolicy !== "deny_all" || child.binding.budget.maxChildren !== 0 ||
    child.binding.toolPolicy.capabilities.some((item) => item.toolID !== "read") ||
    proof.childResultHash !== digest({ outcome: child.outcome, controlState: child.control_state, admittedSeq: child.admitted_seq })) return yield* denied()
  const evidence = yield* terminalEvidence(tx, child, proof)
  const grant = evidence.record
  const admitted = yield* tx.select().from(TaskAdmissionTable).where(eq(TaskAdmissionTable.run_id, proof.taskRunID)).get()
  const latest = yield* tx.select({ seq: SessionInputTable.admitted_seq }).from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, SessionSchema.ID.make(parent.session_id)))
    .orderBy(desc(SessionInputTable.admitted_seq)).limit(1).get()
  if (digest(grant) !== proof.grantHash || grant.expiresAt !== proof.childExpiresAt || grant.taskRunID !== proof.taskRunID ||
    evidence.task.run.generation !== proof.taskGeneration || evidence.task.run.request_hash !== proof.taskRequestHash ||
    evidence.task.receipt.receipt_id !== proof.terminalReceiptID || digest(evidence.task.receipt) !== proof.terminalReceiptHash ||
    !admitted || admitted.request_hash !== proof.taskRequestHash || admitted.parent_session_id !== grant.parentSessionID ||
    admitted.tool_call_id !== grant.toolCallID || evidence.task.run.parent_session_id !== grant.parentSessionID ||
    evidence.task.run.parent_message_id !== grant.parentMessageID || evidence.task.run.tool_call_id !== grant.toolCallID ||
    evidence.task.run.child_session_id !== grant.childSessionID || evidence.task.run.child_message_id !== grant.childInputID ||
    evidence.task.run.delivery_mode !== "foreground" || evidence.task.run.workspace_mode !== "shared" ||
    evidence.task.run.interrupt_requested_at !== null || evidence.task.run.close_requested_at !== null ||
    latest?.seq !== grant.expectedInputSeq)
    return yield* denied()
  const message = yield* tx.select().from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, SessionMessage.ID.make(proof.rawResultMessageID))).get()
  if (!message || message.session_id !== child.session_id || String(evidence.task.run.raw_result_message_id) !== String(message.id) ||
    digest(message) !== proof.rawResultMessageHash || digest(yield* terminalProviders(tx, child)) !== digest(proof.providers) ||
    evidence.tools.length !== proof.tools.length) return yield* denied()
  for (const item of evidence.tools) {
    const bound = proof.tools.find((tool) => tool.effectID === item.effect.effect_id)
    if (!bound || item.admission.tool_name !== "read" || item.effect.known_read_proof === null ||
      bound.admissionID !== item.admission.admission_id || bound.admissionHash !== digest(item.admission) ||
      bound.effectHash !== digest(WorkTaskKnownProof.publicEffect(item.effect)) ||
      bound.proofHash !== digest(item.effect.known_read_proof) || bound.outcomeHash !== item.effect.outcome_hash) return yield* denied()
  }
  const effect = yield* tx.select().from(V2ToolEffectTable).where(eq(V2ToolEffectTable.effect_id, proof.effectID)).get()
  if (!effect || effect.tool_name !== "task" || effect.effect_kind !== "mutating" || effect.state !== "settled" || effect.error_code !== null ||
    effect.session_id !== parent.session_id || effect.receipt_id !== proof.receiptID || effect.provider_attempt_id !== proof.attemptID ||
    effect.tool_call_id !== proof.toolCallID || effect.owner_token !== proof.ownerToken || effect.outcome_hash !== proof.outcomeHash)
    return yield* denied()
  return proof
})

function terminalProviders(tx: Tx, child: WorkAuthority.Work) {
  return Effect.gen(function* () {
    const permits = yield* tx.select().from(WorkDispatchReservationTable).where(eq(WorkDispatchReservationTable.work_id, child.work_id))
      .orderBy(WorkDispatchReservationTable.created_at, WorkDispatchReservationTable.reservation_id).limit(33).all()
    if (!permits.length || permits.length > 32) return yield* denied()
    const providers: Array<typeof WorkTaskKnownProofSchema.Provider.Type> = []
    for (const permit of permits) {
      const receipt = yield* tx.select().from(V2ProviderTurnReceiptTable).where(eq(V2ProviderTurnReceiptTable.receipt_id, permit.receipt_id)).get()
      const attempt = receipt?.provider_attempt_id && (yield* tx.select().from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.attempt_id, receipt.provider_attempt_id)).get())
      const slot = yield* tx.select({ key: WorkCountAcquisitionTable.turn_key }).from(WorkCountAcquisitionTable)
        .where(eq(WorkCountAcquisitionTable.provider_receipt_id, permit.receipt_id)).get()
      const count = slot?.key && (yield* WorkCountAcquisition.getTurn(tx, child.work_id, slot.key))
      const usage = permit.actual_usage && WorkAuthorityPolicy.usageTotal(permit.actual_usage)
      if (!receipt || !attempt || !count || count.state !== "settled" || !count.result || permit.state !== "settled" ||
        !usage || !usage.ok || usage.value !== permit.charged_tokens || receipt.state !== "settled" || attempt.state !== "settled" ||
        receipt.session_id !== child.session_id || receipt.user_message_id !== child.input_id ||
        attempt.session_id !== child.session_id || permit.attempt_id !== attempt.attempt_id ||
        receipt.owner_token !== permit.owner_token || attempt.owner_token !== permit.owner_token ||
        count.binding.bindingHash !== child.binding_hash || count.binding.providerReceiptID !== receipt.receipt_id ||
        count.binding.providerAttemptID !== attempt.attempt_id || count.binding.providerOwnerToken !== permit.owner_token ||
        count.binding.sessionClaimToken !== attempt.execution_claim_token || permit.session_claim_token !== attempt.execution_claim_token ||
        permit.input_bound.tokens !== count.result.inputTokens || permit.wire_hash !== receipt.wire_request_hash ||
        receipt.wire_request_hash !== attempt.wire_request_hash || !receipt.outcome_artifact || receipt.outcome_hash !== digest(receipt.outcome_artifact))
        return yield* denied()
      providers.push({ workID: child.work_id, receiptID: receipt.receipt_id, attemptID: attempt.attempt_id,
        providerTurnSeq: receipt.provider_turn_seq, receiptHash: digest({ ...receipt, prepared_turn: undefined, outcome_artifact: undefined }),
        attemptHash: digest(attempt), ownerToken: permit.owner_token, countID: count.acquisitionID, countRecordHash: digest(count),
        reservationID: permit.reservation_id, reservationHash: digest(permit), chargedTokens: permit.charged_tokens })
    }
    return providers
  })
}

export const get = Effect.fn("WorkChildAuthority.get")(function* (tx: Pick<Db, "select">, childWorkID: string) {
  const row = yield* tx.select().from(WorkChildAuthorityTable).where(eq(WorkChildAuthorityTable.child_work_id, childWorkID)).get()
  if (!row) return undefined
  const decoded = Schema.decodeUnknownOption(WorkChildAuthoritySchema.Record, { onExcessProperty: "error" })(row.record)
  if (Option.isNone(decoded) || row.record_hash !== digest(decoded.value) || row.child_work_id !== decoded.value.childWorkID ||
    row.root_work_id !== decoded.value.rootWorkID || row.parent_work_id !== decoded.value.parentWorkID ||
    row.task_run_id !== decoded.value.taskRunID || row.admission_id !== decoded.value.admissionID ||
    row.child_session_id !== decoded.value.childSessionID || row.child_input_id !== decoded.value.childInputID ||
    row.child_binding_hash !== decoded.value.childBindingHash || row.parent_binding_hash !== decoded.value.parentBindingHash ||
    row.root_binding_hash !== decoded.value.rootBindingHash || row.parent_revision !== decoded.value.parentRevision ||
    row.root_revision !== decoded.value.rootRevision || row.expires_at !== decoded.value.expiresAt || row.created_at !== decoded.value.createdAt ||
    digest(decoded.value.parentBinding) !== row.parent_binding_hash || digest(decoded.value.rootBinding) !== row.root_binding_hash) return yield* denied()
  return decoded.value
})

/** Every child external admission rechecks the original root verifier and exact current await. */
export const requireCurrent = Effect.fn("WorkChildAuthority.requireCurrent")(function* (tx: Tx, child: WorkAuthority.Work, live = true) {
  const record = yield* get(tx, child.work_id)
  if (!record || record.childBindingHash !== child.binding_hash || child.binding_hash !== digest(child.binding) ||
    child.binding.workID !== child.work_id || child.binding.sessionID !== child.session_id || child.binding.inputID !== child.input_id ||
    child.binding.agentID !== child.agent_id || child.binding.rootWorkID !== child.root_work_id ||
    child.binding.parentWorkID !== child.parent_work_id || record.rootWorkID !== child.root_work_id ||
    record.parentWorkID !== child.parent_work_id || record.childSessionID !== child.session_id || record.childInputID !== child.input_id ||
    record.expiresAt <= Date.now()) return yield* denied("WORK_REVOKED")
  const parent = yield* WorkAuthority.requireCurrentControlInTransaction(tx, { workID: record.parentWorkID, expectedRevision: record.parentRevision })
  if (parent.work_id !== record.rootWorkID || parent.binding_hash !== record.parentBindingHash || parent.binding_hash !== record.rootBindingHash ||
    parent.control_revision !== record.rootRevision || parent.outcome !== "pending" || parent.source_record_hash !== child.source_record_hash ||
    parent.route_evidence_hash !== child.route_evidence_hash) return yield* denied("WORK_REVOKED")
  yield* WorkExecutionProfile.requirePlacement(tx, parent)
  const policy = WorkAuthorityPolicy.checkChild(parent.binding, child.binding)
  if (!policy.ok) return yield* policy.error
  const task = yield* tx.select({ run: TaskRunTable, admission: TaskAdmissionTable }).from(TaskRunTable)
    .innerJoin(TaskAdmissionTable, eq(TaskAdmissionTable.run_id, TaskRunTable.run_id))
    .where(eq(TaskRunTable.run_id, record.taskRunID)).get()
  if (!task || task.run.child_session_id !== record.childSessionID || task.run.child_message_id !== record.childInputID ||
    task.run.parent_session_id !== record.parentSessionID || task.run.parent_message_id !== record.parentMessageID ||
    task.run.tool_call_id !== record.toolCallID || task.run.delivery_mode !== "foreground" || task.run.workspace_mode !== "shared" ||
    task.run.request_hash !== task.admission.request_hash || task.admission.parent_session_id !== record.parentSessionID ||
    task.admission.tool_call_id !== record.toolCallID || task.run.interrupt_requested_at !== null || task.run.close_requested_at !== null)
    return yield* denied()
  if (live) {
    if (!["admitted", "provisioning", "running", "researching", "finalizing"].includes(task.run.state)) return yield* denied()
    const original = yield* parentEvidence(tx, record)
    if (original.receipt.receipt_id !== record.receiptID || original.attempt.attempt_id !== record.attemptID ||
      original.owner.owner_token !== record.ownerToken || original.session.execution_claim_token !== record.sessionClaimToken ||
      original.activity.activity_id !== record.activityID || original.activity.ordinal !== record.activityOrdinal ||
      original.activity.trigger_input_id !== record.triggerInputID || original.latest.admitted_seq !== record.expectedInputSeq ||
      !matchesSession(original.session, record.parentBinding)) return yield* denied()
    const terminal = yield* tx.select({ id: V2ToolEffectTable.effect_id }).from(V2ToolEffectTable)
      .where(and(eq(V2ToolEffectTable.receipt_id, record.receiptID), eq(V2ToolEffectTable.tool_call_id, record.toolCallID))).get()
    if (terminal) return yield* denied()
  }
  return { authorityID: parent.authority_id, revision: parent.source_revision, recordHash: parent.source_record_hash }
})

export const permitsAwait = Effect.fn("WorkChildAuthority.permitsAwait")(function* (tx: Tx, work: WorkAuthority.Work, admissionID: string) {
  if (!work.parent_work_id || work.outcome === "unknown") return false
  const record = yield* get(tx, work.work_id)
  if (!record || record.admissionID !== admissionID) return false
  yield* requireCurrent(tx, work)
  return true
})

/** Count disclosure consumes the same finite logical provider slots, including unknown slots. */
export const requireCountBudget = Effect.fn("WorkChildAuthority.requireCountBudget")(function* (tx: Tx,
  work: WorkAuthority.Work, receiptID: string) {
  if (work.binding.profile.id !== WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id) return
  const root = work.parent_work_id ? yield* WorkAuthority.get(tx, work.root_work_id) : work
  if (!root) return yield* denied()
  const slots = yield* tx.all<{ work_id: string }>(sql`SELECT c.work_id FROM work_count_acquisition c
    JOIN work_execution w ON w.work_id=c.work_id WHERE w.root_work_id=${work.root_work_id}
    AND c.provider_receipt_id != ${receiptID}`)
  const charges = yield* tx.select().from(WorkDispatchReservationTable)
    .where(and(eq(WorkDispatchReservationTable.root_work_id, work.root_work_id), sql`${WorkDispatchReservationTable.state} != 'released'`)).all()
  if (slots.length >= root.binding.budget.maxProviderDispatches ||
    slots.filter((slot) => slot.work_id === work.work_id).length >= work.binding.budget.maxProviderDispatches ||
    charges.reduce((sum, item) => sum + item.charged_tokens, 0) >= root.binding.budget.maxTotalTokens ||
    charges.filter((item) => item.work_id === work.work_id).reduce((sum, item) => sum + item.charged_tokens, 0) >= work.binding.budget.maxTotalTokens)
    return yield* denied("WORK_BUDGET_EXHAUSTED")
})

/** Authenticate original child leaves outside the parent's continuation transaction. */
export const prepareTerminal = Effect.fn("WorkChildAuthority.prepareTerminal")(function* (db: Db, admissionID: string): Effect.fn.Return<void, WorkAuthoritySchema.Error> {
  const row = yield* db.select({ id: WorkChildAuthorityTable.child_work_id }).from(WorkChildAuthorityTable)
    .where(eq(WorkChildAuthorityTable.admission_id, admissionID)).get().pipe(Effect.orDie)
  const record = row && (yield* get(db, row.id).pipe(Effect.mapError(() => denied())))
  if (!record) return yield* denied()
  const { WorkToolPolicy } = yield* Effect.promise(() => import("./work-tool-policy"))
  yield* WorkToolPolicy.preparePrevious(db, record.childSessionID)
})

/** Read-only proof control for a completed derived child. This never grants external execution. */
export const requireTerminalProofControl = Effect.fn("WorkChildAuthority.requireTerminalProofControl")(function* (tx: Tx,
  input: { workID: string; expectedRevision: number }) {
  const child = yield* WorkAuthority.get(tx, input.workID)
  if (!child || child.control_revision !== input.expectedRevision || child.outcome !== "succeeded") return yield* denied()
  const evidence = yield* terminalEvidence(tx, child)
  if (evidence.task.run.state !== "completed") return yield* denied()
  return child
})

/** Durable child result rather than text establishes the task tool's known outcome. */
export const requireTerminal = Effect.fn("WorkChildAuthority.requireTerminal")(function* (tx: Tx, parent: WorkAuthority.Work,
  input: { admissionID: string; inputHash: string; outcomeHash?: string }) {
  const row = yield* tx.select({ id: WorkChildAuthorityTable.child_work_id }).from(WorkChildAuthorityTable)
    .where(eq(WorkChildAuthorityTable.admission_id, input.admissionID)).get()
  const child = row && (yield* WorkAuthority.get(tx, row.id))
  if (!child) return yield* denied()
  const { record, tools } = yield* terminalEvidence(tx, child)
  if (record.parentWorkID !== parent.work_id || record.parentSessionID !== parent.session_id ||
    record.toolInputHash !== input.inputHash) return yield* denied()
  if (tools.length) {
    const { WorkToolPolicy } = yield* Effect.promise(() => import("./work-tool-policy"))
    const proof = yield* Effect.serviceOption(WorkToolPolicy.LeafProof)
    if (Option.isNone(proof)) return yield* denied()
    for (const tool of tools) {
      const known = yield* proof.value.requireVerified(tool.effect.effect_id)
      if (tool.effect.state !== "settled" || tool.effect.error_code !== null || known.workID !== child.work_id ||
        known.bindingHash !== child.binding_hash || known.admissionID !== tool.admission.admission_id ||
        known.outcomeHash !== tool.effect.outcome_hash || known.toolID !== tool.admission.tool_name) return yield* denied()
    }
  }
  if (input.outcomeHash !== undefined) {
    const effect = yield* tx.select().from(V2ToolEffectTable)
      .where(and(eq(V2ToolEffectTable.receipt_id, record.receiptID), eq(V2ToolEffectTable.tool_call_id, record.toolCallID))).get()
    if (!effect || effect.state !== "settled" || effect.error_code !== null || effect.outcome_hash !== input.outcomeHash) return yield* denied()
  }
  return record
})

function terminalEvidence(tx: Tx, child: WorkAuthority.Work, historical?: WorkTaskKnownProofSchema.Record) {
  return Effect.gen(function* () {
    if (!child.parent_work_id || !["succeeded", "failed"].includes(child.outcome) || child.control_state !== "active" ||
      child.control_revision !== 1 || child.admission_state !== "ready" || child.binding.deadline <= (historical?.createdAt ?? Date.now()) ||
      child.created_at + child.binding.budget.maxDurationMs <= (historical?.createdAt ?? Date.now())) return yield* denied()
    const record = yield* get(tx, child.work_id)
    if (!record) return yield* denied()
    if (!historical) yield* requireCurrent(tx, child, false)
    if (historical && (historical.grantHash !== digest(record) || historical.childBindingHash !== child.binding_hash ||
      record.childWorkID !== child.work_id || record.parentWorkID !== child.parent_work_id || record.rootWorkID !== child.root_work_id ||
      record.childSessionID !== child.session_id || record.childInputID !== child.input_id || record.expiresAt <= historical.createdAt ||
      digest(child.binding) !== child.binding_hash || digest(record.parentBinding) !== record.parentBindingHash ||
      digest(record.rootBinding) !== record.rootBindingHash)) return yield* denied()
    const task = yield* tx.select({ run: TaskRunTable, receipt: V2TaskRunReceiptTable }).from(TaskRunTable)
      .innerJoin(V2TaskRunReceiptTable, eq(V2TaskRunReceiptTable.run_id, TaskRunTable.run_id))
      .where(eq(TaskRunTable.run_id, record.taskRunID)).get()
    if (!task || task.run.execution_runtime !== "v2" || task.run.phase !== "settled" ||
      task.run.control_state !== "closed" || task.run.execution_owner !== null || task.run.lease_expires_at !== null ||
      !["completed", "failed"].includes(task.run.state) || task.run.time_settled === null ||
      historical && task.run.time_settled > historical.createdAt ||
      task.receipt.time_created !== task.run.time_settled || task.receipt.reason !== task.run.reason || task.receipt.state !== task.run.state || task.receipt.child_session_id !== child.session_id ||
      task.receipt.session_id !== record.parentSessionID || task.receipt.generation !== task.run.generation ||
      task.receipt.outcome_hash !== digest({ state: task.run.state, reason: task.receipt.reason,
        output: task.run.output ?? null, error: task.run.error ?? null })) return yield* denied()
    if ((task.run.state === "completed") !== (child.outcome === "succeeded") || !task.run.raw_result_message_id) return yield* denied()
    const permits = yield* tx.select().from(WorkDispatchReservationTable).where(eq(WorkDispatchReservationTable.work_id, child.work_id)).all()
    if (!permits.length || permits.some((item) => item.state !== "settled" || !item.actual_usage)) return yield* denied()
    for (const permit of permits) {
      const receipt = yield* tx.select().from(V2ProviderTurnReceiptTable).where(eq(V2ProviderTurnReceiptTable.receipt_id, permit.receipt_id)).get()
      const usage = permit.actual_usage && WorkAuthorityPolicy.usageTotal(permit.actual_usage)
      if (!usage || !usage.ok || usage.value !== permit.charged_tokens || permit.control_revision !== child.control_revision ||
        permit.root_work_id !== child.root_work_id || permit.settled_at === null || permit.error_code !== null ||
        historical && permit.settled_at > historical.createdAt ||
        !receipt || receipt.state !== "settled" || receipt.session_id !== child.session_id || receipt.user_message_id !== child.input_id ||
        receipt.provider_attempt_id !== permit.attempt_id || receipt.owner_token !== permit.owner_token ||
        receipt.wire_request_hash !== permit.wire_hash || !receipt.outcome_artifact || receipt.outcome_hash !== digest(receipt.outcome_artifact)) return yield* denied()
    }
    const message = yield* tx.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, SessionMessage.ID.make(task.run.raw_result_message_id))).get()
    const assistant = message && Schema.decodeUnknownOption(SessionMessage.Assistant)({ ...message.data, id: message.id, type: message.type })
    if (!message || message.session_id !== child.session_id || !assistant || Option.isNone(assistant) ||
      assistant.value.time.completed === undefined || assistant.value.error !== undefined || assistant.value.agent !== child.binding.agentID)
      return yield* denied()
    const tools = yield* tx.select({ admission: V2ToolEffectAdmissionTable, effect: V2ToolEffectTable }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ToolEffectTable, and(eq(V2ToolEffectTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id),
        eq(V2ToolEffectTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id)))
      .where(eq(V2ToolEffectAdmissionTable.session_id, SessionSchema.ID.make(child.session_id))).limit(129).all()
    if (tools.length > child.binding.budget.maxToolCalls) return yield* denied()
    if (tools.some((tool) => tool.effect.state !== "settled" || tool.effect.error_code !== null ||
      tool.effect.session_id !== child.session_id || tool.effect.tool_name !== tool.admission.tool_name ||
      tool.effect.provider_attempt_id !== tool.admission.provider_attempt_id || tool.effect.owner_token !== tool.admission.owner_token ||
      tool.effect.outcome_hash === null)) return yield* denied()
    const [unknown] = yield* tx.all<{ count: number }>(sql`SELECT count(*) count FROM (
      SELECT acquisition_id id FROM work_count_acquisition WHERE work_id=${child.work_id} AND state IN ('sending','unknown','failed')
      UNION ALL SELECT a.admission_id FROM session_v2_tool_effect_admission a LEFT JOIN session_v2_tool_effect e
        ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id WHERE a.session_id=${child.session_id} AND e.effect_id IS NULL)`)
    if (!unknown || unknown.count !== 0) return yield* denied()
    return { record, task, tools }
  })
}

function parentEvidence(tx: Tx, input: { admissionID: string; parentSessionID: string; parentMessageID: string; toolCallID: string; toolInputHash: string }, taskCallRequired = true) {
  return Effect.gen(function* () {
    const original = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
      attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, activity: SessionActivityTable,
      session: SessionTable, task: SessionV2TaskCallAdmissionTable }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
      .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
      .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
      .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, V2ProviderTurnReceiptTable.activity_id))
      .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
      .leftJoin(SessionV2TaskCallAdmissionTable, eq(SessionV2TaskCallAdmissionTable.tool_call_id, V2ToolEffectAdmissionTable.tool_call_id))
      .where(eq(V2ToolEffectAdmissionTable.admission_id, input.admissionID)).get()
    const latest = yield* tx.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, SessionSchema.ID.make(input.parentSessionID)))
      .orderBy(desc(SessionInputTable.admitted_seq)).limit(1).get()
    const offered = original?.receipt.outcome_artifact?.flatMap((event) => {
      const call = Schema.decodeUnknownOption(ToolCall)(event)
      return Option.isSome(call) && call.value.id === input.toolCallID ? [call.value] : []
    })
    if (!original || !latest || original.admission.tool_name !== "task" || original.admission.effect_kind !== "mutating" || original.admission.session_id !== input.parentSessionID ||
      original.admission.tool_call_id !== input.toolCallID || taskCallRequired && !original.task ||
      original.task !== null && (original.task.session_id !== input.parentSessionID || original.task.assistant_message_id !== input.parentMessageID) ||
      original.receipt.session_id !== input.parentSessionID || original.attempt.session_id !== input.parentSessionID ||
      original.activity.session_id !== input.parentSessionID || original.attempt.activity_id !== original.activity.activity_id ||
      original.receipt.prepared_turn?.assistant_message_id !== undefined && original.receipt.prepared_turn.assistant_message_id !== input.parentMessageID ||
      original.receipt.provider_attempt_id !== original.attempt.attempt_id ||
      original.receipt.owner_token !== original.owner.owner_token || original.attempt.owner_token !== original.owner.owner_token ||
      original.owner.released_at !== null || original.owner.lease_expires_at <= Date.now() || original.activity.state !== "active" ||
      original.activity.settled_at !== null || original.session.execution_claim_token === null ||
      original.session.execution_claim_token !== original.attempt.execution_claim_token || !original.session.v2_authority ||
      original.session.time_archived !== null || !["streaming", "settled"].includes(original.receipt.state) ||
      !["streaming", "settled"].includes(original.attempt.state) || offered?.length !== 1 || offered[0]!.name !== "task" ||
      digest(offered[0]!.input) !== input.toolInputHash || latest.id !== original.activity.trigger_input_id) return yield* denied()
    return { ...original, latest }
  })
}

function matchesSession(session: typeof SessionTable.$inferSelect, binding: WorkAuthoritySchema.ProjectBinding) {
  return session.id === binding.sessionID && session.agent === binding.agentID && session.directory === binding.location.directory &&
    session.workspace_id === (binding.location.workspaceID ?? null) && session.model?.id === binding.provider.modelID &&
    session.model.providerID === binding.provider.providerID && session.model.variant === undefined
}
